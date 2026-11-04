"""A scripted OpenAI-compatible model for UI development. It needs no GPU and no download.

Usage:
    python scripts/demo_model.py --port 11500

Add it to ~/.harness/providers.json:
    "demo": { "base_url": "http://127.0.0.1:11500/v1", "api_key": "demo" }

Behavior:
- The notes of background tasks ("<task-notification>") -> a short text reply.
- A user message that contains "background" -> a bash tool call with run_in_background (needs approval).
- A user message that contains "helper" -> an agent tool call with run_in_background.
- A user message that contains "ask" -> an ask_user_question call with two questions.
- In plan mode, a user message that contains "plan" -> an exit_plan_mode call with a plan.
- A user message that contains "web" -> web_search, then web_fetch of the first result.
- A user message that contains "visual" -> a show_visual call: three animated loaders, each with a
  "Use option" button that sends a prompt.
- A user message that contains "slow" -> a task list with a step in progress, then a slow reply.
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
- GET /props -> a context length of 32768 tokens, as llama-server gives it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
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


# The visual of the demo: three animated loaders with the theme colors, and a button for each one.
LOADERS = """<style>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px 12px;
  border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface); }
.name { color: var(--color-text-muted); font-size: 13px; }
.dot { fill: var(--color-accent); animation: pulse 1.2s ease-in-out infinite; }
.dot:nth-child(2) { animation-delay: 0.2s; } .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.spin { transform-origin: 20px 20px; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.bar { fill: var(--color-accent); animation: grow 1s ease-in-out infinite; transform-origin: 50% 100%; }
.bar:nth-child(2) { animation-delay: 0.15s; } .bar:nth-child(3) { animation-delay: 0.3s; }
@keyframes grow { 0%, 100% { transform: scaleY(0.4); } 50% { transform: scaleY(1); } }
</style>
<div class="grid">
  <div class="card">
    <svg width="60" height="40" viewBox="0 0 60 40"><circle class="dot" cx="12" cy="20" r="6"/><circle class="dot" cx="30" cy="20" r="6"/><circle class="dot" cx="48" cy="20" r="6"/></svg>
    <span class="name">Dots</span>
    <button onclick="sendPrompt('Use the dots loader')">Use option</button>
  </div>
  <div class="card">
    <svg width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="15" fill="none" stroke="var(--color-border)" stroke-width="4"/>
      <circle class="spin" cx="20" cy="20" r="15" fill="none" stroke="var(--color-accent)" stroke-width="4" stroke-linecap="round" stroke-dasharray="30 100"/></svg>
    <span class="name">Ring</span>
    <button onclick="sendPrompt('Use the ring loader')">Use option</button>
  </div>
  <div class="card">
    <svg width="40" height="40" viewBox="0 0 40 40"><rect class="bar" x="6" y="8" width="6" height="24" rx="2"/><rect class="bar" x="17" y="8" width="6" height="24" rx="2"/><rect class="bar" x="28" y="8" width="6" height="24" rx="2"/></svg>
    <span class="name">Bars</span>
    <button onclick="sendPrompt('Use the bars loader')">Use option</button>
  </div>
</div>"""


def plan(messages: list[dict], tools: set[str]) -> dict:
    last = messages[-1]
    if last["role"] == "user" and isinstance(last["content"], list):
        return {"text": "I can see the screenshot. The page shows the app."}
    if last["role"] == "tool":
        step = preview_step(last_tool_name(messages), last["content"], tools)
        if step:
            return step
        name = last_tool_name(messages)
        if name == "web_search":
            found = re.search(r"https?://\S+", last["content"])
            if found:
                return {"text": "I will read the first result.", "tool_calls": [
                    {"name": "web_fetch", "arguments": {"url": found.group(0)}}]}
        if name == "show_visual":
            return {"text": "Here are three loaders. Pick one with its **Use option** button."}
        if name == "update_plan" and any("slow" in (m.get("content") or "") for m in messages if m["role"] == "user"):
            return {"text": " ".join(["This reply comes slowly, so that the working line shows the step."] * 6), "delay": 0.25}
        output = last["content"]
        preview = "\n".join(output.splitlines()[:8])
        return {"text": (
            "Here is the result.\n\n"
            f"```\n{preview}\n```\n\n"
            "- The tool call **completed**.\n"
            "- Ask me to `run` a command or to `edit` a file to see a permission request."
        )}
    text = last.get("content") or ""
    if "<task-notification>" in text:
        return {"text": "A background task sent a notification. I read it: the work is **done**."}
    if "ask" in text.lower() and "ask_user_question" in tools:
        return {"text": "I need two choices from you.", "tool_calls": [{"name": "ask_user_question", "arguments": {"questions": [
            {"question": "Which database should the app use?", "header": "Database", "options": [
                {"label": "SQLite (Recommended)", "description": "One file. No server."},
                {"label": "Postgres", "description": "A server. Better for many users."}]},
            {"question": "Which features do you want first?", "header": "Features", "multiSelect": True, "options": [
                {"label": "Sign in"}, {"label": "Search"}, {"label": "Export"}]},
        ]}}]}
    if "plan" in text.lower() and "exit_plan_mode" in tools:
        return {"text": "Here is my plan.", "tool_calls": [{"name": "exit_plan_mode", "arguments": {"plan": (
            "## Plan\n\n1. Add type hints to `add` in `src/app.py`.\n2. Add a test in `tests/test_app.py`.\n"
            "3. Run the tests.")}}]}
    if "web" in text.lower() and "web_search" in tools:
        return {"text": "I will search the web.", "tool_calls": [{"name": "web_search", "arguments": {
            "query": "python asyncio TaskGroup", "count": 3}}]}
    if "visual" in text.lower() and "show_visual" in tools:
        return {"text": "I will show you three loader options.", "tool_calls": [{"name": "show_visual", "arguments": {
            "title": "loader_options", "code": LOADERS}}]}
    if "slow" in text.lower():
        return {"text": "", "tool_calls": [{"name": "update_plan", "arguments": {"items": [
            {"content": "Read the code", "status": "completed"},
            {"content": "Check the working line", "status": "in_progress"},
            {"content": "Report", "status": "pending"}]}}]}
    if "background" in text.lower():
        return {"text": "I will start the build in the background.", "tool_calls": [{"name": "bash", "arguments": {
            "command": "sleep 4 && echo build ok", "run_in_background": True, "description": "Built the app"}}]}
    if "helper" in text.lower() and "agent" in tools:
        return {"text": "I will give the search to a helper agent.", "tool_calls": [{"name": "agent", "arguments": {
            "prompt": "Read README.md and give a short report.", "description": "Read the README",
            "run_in_background": True}}]}
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
    if "memo" in text.lower() and "office_edit" in tools:
        # A new Word file: the chat shows a file card with "Open" (the daemon sends it as "created").
        return {"text": "I will write the memo as a Word file.", "tool_calls": [{"name": "office_edit", "arguments": {
            "path": f"docs/memo-{int(time.time())}.docx", "create": True, "edits": [
                {"op": "insert_paragraph", "after": 0, "text": "Memo", "style": "Title"},
                {"op": "insert_paragraph", "after": 1, "text": "The demo agent wrote this file."}]}}]}
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
        await asyncio.sleep(reply.get("delay", 0.03))
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


# The context length, as llama-server gives it, so that the client shows an endpoint source.
DEMO_CONTEXT = 32768


@app.get("/props")
async def props():
    return {"default_generation_settings": {"n_ctx": DEMO_CONTEXT}}


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
