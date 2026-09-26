"""Phase 1 test: run the agent loop from a terminal, with no WebSocket.

Usage:
    python scripts/agent_repl.py --cwd <project> --model local-ollama/qwen2.5-coder:7b
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harness_daemon.agent import Agent  # noqa: E402
from harness_daemon.providers import ModelClient, check_tool_support, resolve_model  # noqa: E402


async def emit(event: dict) -> None:
    kind = event["type"]
    if kind == "token":
        print(event["text"], end="", flush=True)
    elif kind == "tool.start":
        print(f"\n[tool] {event['name']} {json.dumps(event['input'])[:300]}", flush=True)
    elif kind == "tool.result":
        mark = "error" if event["is_error"] else "ok"
        print(f"[{mark}] {event['output'][:600]}", flush=True)
    elif kind == "turn.end":
        print(f"\n[turn.end] {event['stop_reason']} {event['usage']}", flush=True)
    elif kind == "error":
        print(f"\n[error] {event['message']}", flush=True)


async def approver(request: dict) -> str:
    print(f"\n[permission] {request['tool']}: {json.dumps(request['input'])[:500]}")
    if request.get("diff"):
        print(request["diff"])
    answer = await asyncio.to_thread(input, "Allow? [y]es once / [a]lways / [n]o: ")
    return {"y": "allow_once", "a": "allow_always"}.get(answer.strip().lower()[:1], "deny")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", default=".")
    parser.add_argument("--model", required=True, help="<provider>/<model> or <model>")
    args = parser.parse_args()

    provider, model = resolve_model(args.model)
    support = await check_tool_support(provider, model)
    if support is False:
        print(f"Warning: {model} does not support tool calls.")
    agent = Agent(cwd=Path(args.cwd), client=ModelClient(provider, model), emit=emit, approver=approver)
    print(f"Model: {provider.name}/{model}  Project: {agent.cwd}  Shell: {agent.ctx.shell.name}")
    while True:
        try:
            text = await asyncio.to_thread(input, "\n> ")
        except EOFError:
            return
        if text.strip() in ("exit", "quit"):
            return
        if text.strip():
            await agent.run_turn(text)


if __name__ == "__main__":
    asyncio.run(main())
