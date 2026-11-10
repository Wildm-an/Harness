"""A fake ACP agent for the tests of acp.py. It reads JSON-RPC lines on stdin and writes them on stdout.

The prompt text selects the script:

- "hello": two text chunks, then end_turn.
- "edit": a plan, an edit of hello.py that asks for permission, then "Done.".
- "wait": a running command that ends only with session/cancel.
- "blocks": a reply with the number of prompt blocks (a recap adds one).
- "fsread", "fswrite": a file read and a file write through the client (fs/*).
- "term": a command in a terminal of the client (terminal/*).
- "mcp": a call of the Harness MCP server (tools/list, then tools/call cron_list).
- "mcpcard": two send_file calls of the Harness MCP server. The agent reports the first one as a tool call
  ("call_m"), and does not report the second one.
- "/review <x>": the command of the agent.
- "env": a reply with the arguments and some environment variables of the agent, as JSON (acp_models.py).

The agent has two models ("fast" and "smart") and one command ("review"). "hello" sends a usage update.

FAKE_ACP_LOG: a file that gets one JSON line for each message from the client.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import urllib.request
from pathlib import Path

LOCK = threading.Lock()
LOG = os.environ.get("FAKE_ACP_LOG")
waiting: dict[int, threading.Event] = {}
answers: dict[int, dict] = {}
cancelled = threading.Event()
next_id = [1000]
sessions: dict[str, str] = {}  # session id -> cwd
mcp_urls: dict[str, str] = {}  # session id -> the URL of the Harness MCP server


def send(message: dict) -> None:
    with LOCK:
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
        sys.stdout.flush()


def log(message: dict) -> None:
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(message) + "\n")


def update(sid: str, body: dict) -> None:
    send({"method": "session/update", "params": {"sessionId": sid, "update": body}})


def ask(method: str, params: dict) -> dict:
    next_id[0] += 1
    rid = next_id[0]
    event = threading.Event()
    waiting[rid] = event
    send({"id": rid, "method": method, "params": params})
    event.wait(30)
    return answers.pop(rid, {})


def mcp_post(url: str, body: dict) -> dict:
    """One JSON-RPC message to the Harness MCP server (HTTP)."""
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read() or b"{}")


def chunk(sid: str, text: str) -> None:
    update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})


def run_prompt(rid: int, params: dict) -> None:
    try:
        script(rid, params)
    except Exception as e:  # noqa: BLE001 - the test sees the error in the reply text.
        chunk(params["sessionId"], f"fake agent error: {type(e).__name__}: {e}")
        send({"id": rid, "result": {"stopReason": "end_turn"}})


def script(rid: int, params: dict) -> None:
    sid = params["sessionId"]
    blocks = params.get("prompt") or []
    text = blocks[-1].get("text", "") if blocks else ""
    stop = "end_turn"
    if text == "hello":
        update(sid, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Hmm."}})
        chunk(sid, "Hello ")
        chunk(sid, "from fake.")
        update(sid, {"sessionUpdate": "usage_update", "used": 1234, "size": 200000})
    elif text == "fsread":
        path = str(Path(sessions[sid]) / "hello.py")
        answer = ask("fs/read_text_file", {"sessionId": sid, "path": path, "line": 2, "limit": 1})
        chunk(sid, "read: " + ((answer.get("result") or {}).get("content") or "").strip())
    elif text == "fswrite":
        path = str(Path(sessions[sid]) / "hello.py")
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": "call_w", "title": "Write hello.py", "kind": "edit",
                     "status": "in_progress", "locations": [{"path": path}]})
        answer = ask("fs/write_text_file", {"sessionId": sid, "path": path, "content": "print('written')\n"})
        failed = "error" in answer
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "call_w",
                     "status": "failed" if failed else "completed",
                     "content": [{"type": "content", "content": {"type": "text", "text": json.dumps(answer.get("error"))}}]
                     if failed else []})
        chunk(sid, "write failed" if failed else "Wrote.")
    elif text == "term":
        created = ask("terminal/create", {"sessionId": sid, "command": "echo hi-from-term"})
        tid = (created.get("result") or {}).get("terminalId")
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": "call_t", "title": "Run echo", "kind": "execute",
                     "status": "in_progress", "content": [{"type": "terminal", "terminalId": tid}]})
        status = (ask("terminal/wait_for_exit", {"sessionId": sid, "terminalId": tid}).get("result") or {})
        output = (ask("terminal/output", {"sessionId": sid, "terminalId": tid}).get("result") or {}).get("output", "")
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "call_t", "status": "completed"})
        ask("terminal/release", {"sessionId": sid, "terminalId": tid})
        chunk(sid, f"exit={status.get('exitCode')} out={output.strip()}")
    elif text == "mcp":
        url = mcp_urls[sid]

        def post(body: dict) -> dict:
            return mcp_post(url, body)

        post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        names = [t["name"] for t in post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]]
        called = post({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "cron_list", "arguments": {}}})
        chunk(sid, f"tools={','.join(sorted(names))} call={called['result']['content'][0]['text']}")
    elif text == "mcpcard":
        url = mcp_urls[sid]
        args = {"files": ["hello.py"]}
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": "call_m", "title": "mcp__harness__send_file",
                     "kind": "other", "status": "in_progress", "rawInput": args})
        mcp_post(url, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "send_file", "arguments": args}})
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "call_m", "status": "completed"})
        mcp_post(url, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                       "params": {"name": "send_file", "arguments": {"files": ["hello.py"], "caption": "unreported"}}})
        chunk(sid, "sent")
    elif text == "env":
        names = ["GOOSE_PROVIDER", "GOOSE_MODEL", "OPENAI_HOST", "OPENAI_BASE_PATH", "OPENAI_API_KEY", "GOOSE_CONTEXT_LIMIT"]
        chunk(sid, json.dumps({"argv": sys.argv[1:], "env": {n: os.environ.get(n) for n in names}}))
    elif text.startswith("/review"):
        chunk(sid, "review: " + text[len("/review"):].strip())
    elif text == "edit":
        path = Path(sessions[sid]) / "hello.py"
        old = path.read_text(encoding="utf-8")
        new = old.replace("'hello'", "'hey'")
        update(sid, {"sessionUpdate": "plan", "entries": [
            {"content": "Edit hello.py", "priority": "high", "status": "in_progress"},
            {"content": "Report", "priority": "low", "status": "pending"},
        ]})
        chunk(sid, "I will edit the file.")
        call = {"toolCallId": "call_1", "title": "Edit hello.py", "kind": "edit", "status": "pending",
                "locations": [{"path": str(path)}],
                "content": [{"type": "diff", "path": str(path), "oldText": old, "newText": new}]}
        update(sid, {"sessionUpdate": "tool_call", **call})
        answer = ask("session/request_permission", {"sessionId": sid, "toolCall": {"toolCallId": "call_1"}, "options": [
            {"optionId": "yes", "name": "Allow", "kind": "allow_once"},
            {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
            {"optionId": "no", "name": "Reject", "kind": "reject_once"},
        ]})
        outcome = (answer.get("result") or {}).get("outcome") or {}
        if outcome.get("optionId") in ("yes", "always"):
            path.write_text(new, encoding="utf-8")
            update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "completed"})
            chunk(sid, "Done.")
        else:
            update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "failed",
                         "content": [{"type": "content", "content": {"type": "text", "text": "Rejected."}}]})
            chunk(sid, f"Not allowed: {outcome}.")
    elif text == "wait":
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": "call_w", "title": "sleep", "kind": "execute",
                     "status": "in_progress", "rawInput": {"command": ["bash", "-lc", "sleep 30"]}})
        cancelled.clear()
        cancelled.wait(30)
        stop = "cancelled"
    elif text == "blocks":
        chunk(sid, f"blocks={len(blocks)}")
    else:
        chunk(sid, f"echo: {text}")
    send({"id": rid, "result": {"stopReason": stop}})


def main() -> None:
    count = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message = json.loads(line)
        log(message)
        method = message.get("method")
        rid = message.get("id")
        if method is None:  # A reply to a request of the agent.
            answers[rid] = message
            event = waiting.pop(rid, None)
            if event is not None:
                event.set()
            continue
        params = message.get("params") or {}
        if method == "initialize":
            send({"id": rid, "result": {"protocolVersion": 1, "agentCapabilities": {
                "loadSession": True, "promptCapabilities": {"image": False}, "mcpCapabilities": {"http": True}},
                "authMethods": []}})
        elif method == "session/new":
            count += 1
            sid = f"fake-{os.getpid()}-{count}"
            sessions[sid] = params["cwd"]
            for server in params.get("mcpServers") or []:
                if server.get("url"):
                    mcp_urls[sid] = server["url"]
            send({"id": rid, "result": {"sessionId": sid, "modes": {"currentModeId": "default", "availableModes": [
                {"id": "default", "name": "Default"}, {"id": "plan", "name": "Plan"}]},
                "models": {"currentModelId": "fast", "availableModels": [
                    {"modelId": "fast", "name": "Fast"}, {"modelId": "smart", "name": "Smart"}]}}})
            update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": [
                {"name": "review", "description": "Review the code", "input": {"hint": "path"}}]})
        elif method == "session/load":
            sessions[params["sessionId"]] = params["cwd"]
            for server in params.get("mcpServers") or []:
                if server.get("url"):
                    mcp_urls[params["sessionId"]] = server["url"]
            chunk(params["sessionId"], "An old reply that the client must not see.")
            send({"id": rid, "result": {}})
        elif method in ("session/set_mode", "session/set_model"):
            send({"id": rid, "result": {}})
        elif method == "session/prompt":
            threading.Thread(target=run_prompt, args=(rid, params), daemon=True).start()
        elif method == "session/cancel":
            cancelled.set()
        elif rid is not None:
            send({"id": rid, "error": {"code": -32601, "message": f"Unknown method {method}"}})


if __name__ == "__main__":
    main()
