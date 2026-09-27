"""A scripted OpenAI-compatible model for UI development. It needs no GPU and no download.

Usage:
    python scripts/demo_model.py --port 11500

Add it to ~/.harness/providers.json:
    "demo": { "base_url": "http://127.0.0.1:11500/v1", "api_key": "demo" }

Behavior:
- A user message that contains "run" -> a bash tool call (needs approval).
- A skill that the user started with /name -> a short text reply.
- "use the skill <name> <arguments>" -> a skill tool call.
- A user message that contains "search" -> a glob and a grep tool call.
- A user message that contains "create" -> a write tool call for tests/test_app.py (needs approval).
- A user message that contains "refactor" -> a multi-line edit of src/app.py (needs approval).
- A user message that contains "edit" -> an edit tool call on the file README.md (needs approval).
- A user message that contains "preview" -> the preview tools, one call for each step:
  preview_start, preview_navigate "/", preview_snapshot, preview_click on the first button,
  preview_console, and preview_screenshot if the model has image input.
- Another user message -> a read tool call on the first file in the prompt, or README.md.
- A tool result -> a short Markdown summary.
- A request with no tools (a context summary) -> a fixed summary.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

from fake_openai import _chunk  # noqa: E402

app = FastAPI()


def last_tool_name(messages: list[dict]) -> str | None:
    for m in reversed(messages):
        if m["role"] == "assistant" and m.get("tool_calls"):
            return m["tool_calls"][-1]["function"]["name"]
    return None


def preview_step(name: str | None, output: str, tools: set[str]) -> dict | None:
    """The next call of the preview demo, or None at the end."""
    if name == "preview_start" and "is running" in output:
        return {"text": "The server runs. I will open the app.", "tool_calls": [
            {"name": "preview_navigate", "arguments": {"url": "/"}}]}
    if name == "preview_navigate" and output.startswith("Opened"):
        return {"text": "I will read the page.", "tool_calls": [{"name": "preview_snapshot", "arguments": {}}]}
    if name == "preview_snapshot":
        ref = re.search(r'button "[^"]*" \[ref=(e\d+)\]', output)
        if ref:
            return {"text": "I will click the first button.", "tool_calls": [
                {"name": "preview_click", "arguments": {"ref": ref.group(1)}}]}
        return {"text": "I will check the console.", "tool_calls": [{"name": "preview_console", "arguments": {}}]}
    if name == "preview_click":
        return {"text": "I will check the console.", "tool_calls": [{"name": "preview_console", "arguments": {}}]}
    if name == "preview_console" and "preview_screenshot" in tools:
        return {"text": "I will take a screenshot.", "tool_calls": [{"name": "preview_screenshot", "arguments": {}}]}
    return None


def plan(messages: list[dict], tools: set[str]) -> dict:
    last = messages[-1]
    if last["role"] == "user" and isinstance(last["content"], list):
        return {"text": "I can see the screenshot. The page shows the app."}
    if last["role"] == "tool":
        step = preview_step(last_tool_name(messages), last["content"], tools)
        if step:
            return step
        output = last["content"]
        preview = "\n".join(output.splitlines()[:8])
        return {"text": (
            "Here is the result.\n\n"
            f"```\n{preview}\n```\n\n"
            "- The tool call **completed**.\n"
            "- Ask me to `run` a command or to `edit` a file to see a permission request."
        )}
    text = last.get("content") or ""
    if text.startswith("The user started the skill"):
        name = text.split("/", 1)[1].split()[0].rstrip(".")
        return {"text": f"I follow the instructions of the skill **{name}**. The skill text is in my context."}
    skill = re.search(r"use the skill ([\w.:-]+)(.*)", text, re.IGNORECASE)
    if skill:
        return {"text": "I will load the skill.", "tool_calls": [{"name": "skill", "arguments": {
            "name": skill.group(1), "arguments": skill.group(2).strip()}}]}
    if "preview" in text.lower():
        return {"text": "I will start the app and check it.", "tool_calls": [{"name": "preview_start", "arguments": {}}]}
    if "run" in text.lower():
        return {"text": "I will run a command.", "tool_calls": [{"name": "bash", "arguments": {"command": "git status --short || ls"}}]}
    if "search" in text.lower():
        return {"text": "I will find the Python files and the uses of `add`.", "tool_calls": [
            {"name": "glob", "arguments": {"pattern": "**/*.py"}},
            {"name": "grep", "arguments": {"pattern": "add", "output": "content"}}]}
    if "create" in text.lower():
        return {"text": "I will create a test file.", "tool_calls": [{"name": "write", "arguments": {
            "path": "tests/test_app.py",
            "content": "from src.app import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n"}}]}
    if "refactor" in text.lower():
        return {"text": "I will add type hints and a docstring.", "tool_calls": [{"name": "edit", "arguments": {
            "path": "src/app.py",
            "old_string": "def add(a, b):\n    return a + b",
            "new_string": 'def add(a: int, b: int) -> int:\n    """Return the sum of a and b."""\n    return a + b'}}]}
    if "edit" in text.lower():
        return {"text": "I will change the title line.", "tool_calls": [{"name": "edit", "arguments": {
            "path": "README.md", "old_string": "# Coding Harness", "new_string": "# Coding Harness (demo edit)"}}]}
    match = re.search(r"[\w./-]+\.\w+", text)
    path = match.group(0) if match else "README.md"
    return {"text": f"I will read `{path}` first.", "tool_calls": [{"name": "read", "arguments": {"path": path, "limit": 40}}]}


async def stream(reply: dict):
    yield _chunk({"role": "assistant", "content": ""})
    for word in re.findall(r"\S+\s*|\n", reply.get("text", "")):
        yield _chunk({"content": word})
        await asyncio.sleep(0.03)
    for index, call in enumerate(reply.get("tool_calls", [])):
        yield _chunk({"tool_calls": [{"index": index, "id": f"call_demo_{index}", "type": "function",
                                      "function": {"name": call["name"], "arguments": json.dumps(call["arguments"])}}]})
    yield _chunk({}, "tool_calls" if reply.get("tool_calls") else "stop")
    usage = {"prompt_tokens": 1200, "completion_tokens": 40, "total_tokens": 1240}
    yield "data: " + json.dumps({"id": "demo", "object": "chat.completion.chunk", "created": 0, "model": "demo",
                                 "choices": [], "usage": usage}) + "\n\n"
    yield "data: [DONE]\n\n"


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": "scripted", "object": "model"}]}


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    if not body.get("tools"):  # A context summary request from the daemon.
        reply = {"text": (
            "- The user tried the demo prompts.\n"
            "- The agent read, searched, and changed files in the demo project."
        )}
    else:
        reply = plan(body["messages"], {t["function"]["name"] for t in body["tools"]})
    return StreamingResponse(stream(reply), media_type="text/event-stream")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=11500)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
