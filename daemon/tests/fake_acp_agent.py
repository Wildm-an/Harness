"""A fake ACP agent for the tests of acp.py. It reads JSON-RPC lines on stdin and writes them on stdout.

The prompt text selects the script:

- "hello": two text chunks, then end_turn.
- "edit": a plan, an edit of hello.py that asks for permission, then "Done.".
- "wait": a running command that ends only with session/cancel.
- "blocks": a reply with the number of prompt blocks (a recap adds one).

FAKE_ACP_LOG: a file that gets one JSON line for each message from the client.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

LOCK = threading.Lock()
LOG = os.environ.get("FAKE_ACP_LOG")
waiting: dict[int, threading.Event] = {}
answers: dict[int, dict] = {}
cancelled = threading.Event()
next_id = [1000]
sessions: dict[str, str] = {}  # session id -> cwd


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


def chunk(sid: str, text: str) -> None:
    update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})


def run_prompt(rid: int, params: dict) -> None:
    sid = params["sessionId"]
    blocks = params.get("prompt") or []
    text = blocks[-1].get("text", "") if blocks else ""
    stop = "end_turn"
    if text == "hello":
        update(sid, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "Hmm."}})
        chunk(sid, "Hello ")
        chunk(sid, "from fake.")
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
                "loadSession": True, "promptCapabilities": {"image": False}}, "authMethods": []}})
        elif method == "session/new":
            count += 1
            sid = f"fake-{os.getpid()}-{count}"
            sessions[sid] = params["cwd"]
            send({"id": rid, "result": {"sessionId": sid, "modes": {"currentModeId": "default", "availableModes": [
                {"id": "default", "name": "Default"}, {"id": "plan", "name": "Plan"}]}}})
        elif method == "session/load":
            sessions[params["sessionId"]] = params["cwd"]
            chunk(params["sessionId"], "An old reply that the client must not see.")
            send({"id": rid, "result": {}})
        elif method == "session/set_mode":
            send({"id": rid, "result": {}})
        elif method == "session/prompt":
            threading.Thread(target=run_prompt, args=(rid, params), daemon=True).start()
        elif method == "session/cancel":
            cancelled.set()
        elif rid is not None:
            send({"id": rid, "error": {"code": -32601, "message": f"Unknown method {method}"}})


if __name__ == "__main__":
    main()
