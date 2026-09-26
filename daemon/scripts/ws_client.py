"""Phase 2 test: a WebSocket CLI client for the daemon.

Usage:
    python scripts/ws_client.py --port 53817 --token <token> --cwd <project> --model <provider>/<model>
    python scripts/ws_client.py --port 53817 --token <token> --resume <session_id>

Input:
- A line that starts with "/" sends a "command" message. Example: /model fake/other
- A line that starts with ":" sends raw JSON. Example: :{"type": "fs.list", "path": "."}
- "!" sends "interrupt".
- Other lines send a "prompt" message.
- When a permission request is open, the next line is the answer: y, a, or n.
"""

from __future__ import annotations

import argparse
import asyncio
import json

import websockets


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--cwd")
    parser.add_argument("--model")
    parser.add_argument("--resume")
    args = parser.parse_args()

    async with websockets.connect(f"ws://{args.host}:{args.port}/ws", max_size=None) as ws:
        await ws.send(json.dumps({"type": "auth", "token": args.token}))
        if args.resume:
            await ws.send(json.dumps({"type": "session.resume", "session_id": args.resume}))
        else:
            await ws.send(json.dumps({"type": "session.new", "cwd": args.cwd, "model": args.model}))

        pending: list[str] = []  # Open permission request ids.

        async def reader() -> None:
            async for raw in ws:
                msg = json.loads(raw)
                kind = msg["type"]
                if kind == "token":
                    print(msg["text"], end="", flush=True)
                elif kind == "tool.start":
                    print(f"\n[tool.start] {msg['name']} {json.dumps(msg['input'])[:300]}")
                elif kind == "tool.result":
                    print(f"[tool.result{' ERROR' if msg['is_error'] else ''}] {msg['output'][:600]}")
                elif kind == "permission.request":
                    pending.append(msg["request_id"])
                    print(f"\n[permission.request] {msg['tool']} {json.dumps(msg['input'])[:500]}")
                    if msg.get("diff"):
                        print(msg["diff"])
                    print("Allow? [y]es once / [a]lways / [n]o")
                elif kind == "session.ready":
                    shown = {k: v for k, v in msg.items() if k != "history"}
                    print(f"[session.ready] {json.dumps(shown)} ({len(msg['history'])} history messages)")
                else:
                    print(f"\n[{kind}] {json.dumps({k: v for k, v in msg.items() if k != 'type'})[:1000]}")

        task = asyncio.create_task(reader())
        try:
            while not task.done():
                line = (await asyncio.to_thread(input)).strip()
                if not line:
                    continue
                if pending:
                    decision = {"y": "allow_once", "a": "allow_always"}.get(line[:1].lower(), "deny")
                    msg = {"type": "permission.reply", "request_id": pending.pop(0), "decision": decision}
                elif line == "!":
                    msg = {"type": "interrupt"}
                elif line.startswith(":"):
                    msg = json.loads(line[1:])
                elif line.startswith("/"):
                    name, _, rest = line[1:].partition(" ")
                    msg = {"type": "command", "name": name, "args": rest}
                else:
                    msg = {"type": "prompt", "text": line}
                await ws.send(json.dumps(msg))
        except (EOFError, KeyboardInterrupt):
            pass
        finally:
            task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
