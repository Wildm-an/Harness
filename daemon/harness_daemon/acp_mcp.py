"""The Harness MCP server of an ACP session: the Harness tools for another harness (acp.py).

An ACP harness gets one MCP server named "harness" in ``session/new``. It has:

- The Harness tools that the other harness does not have: the browser preview, the documents,
  the background tasks, the memory, and the search of the other sessions.
- The tools of the MCP servers of the user (``mcp__<server>__<tool>``). The daemon connects to
  these servers, so OAuth, the connectors, and the approvals of Harness keep working.

Each call runs through the agent of the session (``Agent._execute``): the permission rules, the
permission mode, and the hooks of Harness apply.

The server is a JSON-RPC endpoint of the daemon: ``POST /acp-mcp/<secret>`` (MCP streamable HTTP, with
JSON replies). A harness that cannot use HTTP MCP servers gets the stdio bridge: the daemon program
with ``--mcp-bridge <url>``. It sends each line of stdin to the endpoint, and writes each reply to stdout.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.request
import weakref
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import __version__

if TYPE_CHECKING:
    from .acp import AcpAgent

SERVER_NAME = "harness"
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
# The tools that the other harness has itself, and the tools that need the model or the chat of Harness.
# show_visual and ask_user_question are open to the harness: their cards show in the chat at the tool row of the
# call (acp.py ``_view``), as T3 Code shows the cards of its MCP tools.
HIDDEN_TOOLS = {
    "read", "glob", "grep", "edit", "write", "apply_patch", "bash", "web_search", "web_fetch", "update_plan", "wrap_up",
    "exit_plan_mode", "skill", "tool_search", "agent", "offer_session", "start_session",
}

# The name of a Harness MCP tool in the title of a tool call of the harness: "mcp__harness__show_visual" (Claude
# Code), "mcp__editor_harness_aa5f56ca__preview_navigate" (Hermes Agent gives the server its own name),
# "harness.show_visual", "harness/show_visual", "harness_show_visual", or "show_visual (harness)".
_TITLE_TOOL = re.compile(r"(?:^|[^A-Za-z0-9])(?:mcp__[A-Za-z0-9_]*?harness[A-Za-z0-9_]*?__|harness(?:__|[./:_]))([a-z][a-z0-9_]*)")
_TITLE_SUFFIX = re.compile(r"^([a-z][a-z0-9_]*)\s*\((?:mcp:?\s*)?harness(?:\s+mcp(?:\s+server)?)?\)", re.IGNORECASE)


def tool_of_title(title: str, tools: set[str] | list[str]) -> str | None:
    """The Harness tool of a tool call of the harness, from its title. None: not a Harness MCP tool."""
    for pattern in (_TITLE_TOOL, _TITLE_SUFFIX):
        m = pattern.search(title.strip())
        if m and m.group(1) in tools:
            return m.group(1)
    return None


# The lines of the instructions block. Each line shows only when the harness gets all of its tools.
_INSTRUCTION_LINES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("preview_start", "preview_navigate", "preview_snapshot"),
     "- Browser: the user sees the Browser pane of Harness. After a change to a web page or a web app, start its "
     "server with preview_start, open the page with preview_navigate, and check it with preview_snapshot (and "
     "preview_screenshot when the look matters). Test with preview_click and preview_fill. List, switch, and close "
     "tabs with preview_tabs. Do not use the browser tools when the task has no web interface."),
    (("show_visual",),
     "- Visuals: to explain with a diagram, a flow, a chart, or a comparison, call show_visual. The visual shows in "
     "the chat. Do not repeat its content in your text."),
    (("ask_user_question",),
     "- Questions: when a choice belongs to the user and the request and the code do not settle it, call "
     "ask_user_question. The user answers on a card in the chat. Do not ask such a question in plain text."),
    (("send_file",),
     "- Files: to give the user a file of the project (a report, an image, a PDF), call send_file. The chat shows a "
     "file card."),
    (("artifact",),
     "- Pages: to publish a finished HTML page for the user, call artifact."),
    (("memory",),
     "- Memory: save facts about the user and the project that help later sessions with memory."),
    (("conversation_search", "session_read"),
     "- Other sessions: find earlier work with conversation_search, and read a session with session_read."),
    (("monitor", "task_output"),
     "- Background work: watch a long command with monitor, and read its output with task_output."),
)


def instructions(tools: set[str] | list[str]) -> str:
    """The block that tells the model of another harness about the tools of the Harness interface. Harness puts it
    before the first prompt of each new ACP session, as T3 Code does for its ACP agents. Empty: no such tools."""
    tools = set(tools)
    lines = [text for needs, text in _INSTRUCTION_LINES if all(t in tools for t in needs)]
    if not lines:
        return ""
    return ("<harness_instructions>\n"
            "You run inside Harness, a desktop app for coding agents. The user reads your work in the Harness chat. "
            f"The MCP server \"{SERVER_NAME}\" gives you the tools of the Harness interface. Use them:\n"
            + "\n".join(lines) + "\n"
            f"Call them through the \"{SERVER_NAME}\" MCP server, for example mcp__{SERVER_NAME}__show_visual. "
            "The user does not see this block.\n"
            "</harness_instructions>")

BRIDGE_FLAG = "--mcp-bridge"

# The secret of the URL -> the agent of the session. The secret is the only access control: the
# endpoint listens on the daemon address, and only the harness process gets the URL.
_AGENTS: "weakref.WeakValueDictionary[str, AcpAgent]" = weakref.WeakValueDictionary()


def register(agent: "AcpAgent") -> str:
    secret = secrets.token_urlsafe(24)
    _AGENTS[secret] = agent
    return secret


def unregister(secret: str | None) -> None:
    if secret:
        _AGENTS.pop(secret, None)


def find(secret: str) -> "AcpAgent | None":
    return _AGENTS.get(secret)


def exposed_tools(agent: "AcpAgent") -> list[str]:
    return [name for name in agent.tools if name not in HIDDEN_TOOLS]


def _tool_list(agent: "AcpAgent") -> list[dict[str, Any]]:
    tools = []
    for name in exposed_tools(agent):
        schema = agent.tools[name].schema(agent.ctx)
        function = schema.get("function", schema)
        tools.append({
            "name": name,
            "description": str(function.get("description") or ""),
            "inputSchema": function.get("parameters") or {"type": "object", "properties": {}},
        })
    return tools


def _content(output: str, image: str | None) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": output or "Done."}]
    m = re.match(r"data:([\w/+.-]+);base64,(.*)", image or "", re.S)
    if m:
        content.append({"type": "image", "mimeType": m.group(1), "data": m.group(2)})
    return content


async def _one(agent: "AcpAgent", message: Any) -> dict[str, Any] | None:
    """The reply to one JSON-RPC message, or None for a notification."""
    if not isinstance(message, dict) or not isinstance(message.get("method"), str):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Not a JSON-RPC request."}}
    method = message["method"]
    if "id" not in message:
        return None  # notifications/initialized, notifications/cancelled
    request_id = message["id"]
    params = message.get("params") if isinstance(message.get("params"), dict) else {}

    def ok(result: Any) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    def error(code: int, text: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": text}}

    if method == "initialize":
        asked = params.get("protocolVersion")
        version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return ok({"protocolVersion": version, "capabilities": {"tools": {"listChanged": False}},
                   "serverInfo": {"name": SERVER_NAME, "title": "Harness", "version": __version__},
                   "instructions": "The tools of Harness: the browser preview of the project, documents, "
                                   "background tasks, memory, the other sessions, and the MCP servers of the user."})
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": _tool_list(agent)})
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        if not isinstance(name, str) or name not in exposed_tools(agent):
            return error(-32602, f"Unknown tool: {name}")
        result = await agent.run_harness_tool(name, args)
        return ok({"content": _content(result.output, result.image), "isError": bool(result.is_error)})
    return error(-32601, f"Method not found: {method}")


async def handle(agent: "AcpAgent", body: Any) -> Any:
    """The reply to a POST body: one message or a batch. None: no reply (only notifications)."""
    if isinstance(body, list):
        replies = [r for r in [await _one(agent, m) for m in body] if r is not None]
        return replies or None
    return await _one(agent, body)


def server_entry(agent_caps: dict[str, Any], url: str) -> dict[str, Any]:
    """The McpServer entry of session/new: HTTP when the harness supports it, else the stdio bridge."""
    mcp = agent_caps.get("mcpCapabilities") if isinstance(agent_caps.get("mcpCapabilities"), dict) else {}
    if mcp.get("http"):
        return {"type": "http", "name": SERVER_NAME, "url": url, "headers": []}
    from .frozen import is_frozen

    if is_frozen():
        command, args, env = sys.executable, [BRIDGE_FLAG, url], []
    else:
        # The same package as this daemon, also when another copy is installed in the Python.
        root = str(Path(__file__).resolve().parents[1])
        path = os.pathsep.join([root, os.environ["PYTHONPATH"]]) if os.environ.get("PYTHONPATH") else root
        command, args, env = sys.executable, ["-m", "harness_daemon", BRIDGE_FLAG, url], [{"name": "PYTHONPATH", "value": path}]
    return {"name": SERVER_NAME, "command": command, "args": args, "env": env}


def run_bridge(url: str) -> None:
    """The stdio bridge: each line of stdin is a JSON-RPC message for the endpoint at ``url``."""
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        request = urllib.request.Request(url, data=line.encode("utf-8"), method="POST",
                                         headers={"Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                body = response.read().decode("utf-8")
        except (urllib.error.URLError, OSError) as e:
            if isinstance(message, dict) and "id" in message:
                reply = {"jsonrpc": "2.0", "id": message["id"],
                         "error": {"code": -32603, "message": f"Harness is not reachable: {e}"}}
                out.write(json.dumps(reply) + "\n")
                out.flush()
            continue
        if body.strip():
            out.write(body.strip().replace("\n", " ") + "\n")
            out.flush()
