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
HIDDEN_TOOLS = {
    "read", "glob", "grep", "edit", "write", "bash", "web_search", "web_fetch", "update_plan", "wrap_up",
    "ask_user_question", "exit_plan_mode", "skill", "tool_search", "agent", "offer_session", "start_session",
    "show_visual",
}
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
