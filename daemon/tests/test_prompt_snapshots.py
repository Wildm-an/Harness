"""Snapshots of the system prompt and the tool list that each model family gets.

A change of a prompt text or a tool description changes the behavior of the agent. This test shows each such
change as a diff, so that a reviewer sees it. Update the snapshots after an intended change:

    HARNESS_UPDATE_SNAPSHOTS=1 python -m pytest tests/test_prompt_snapshots.py

The test pins the values that change with the computer and the day: the folders, the operating system, the
shell, and the date.
"""

from __future__ import annotations

import datetime
import difflib
import json
import os
import re
import types
from pathlib import Path

import pytest

from harness_daemon.agent import Agent
from harness_daemon.config import load_settings
from harness_daemon.memory import memory_dir
from harness_daemon.providers import ModelClient, resolve_model

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

SNAPSHOTS = Path(__file__).resolve().parent / "snapshots"
PLACEHOLDER_PATH = re.compile(r"(<PROJECT>|<MEMORY>|<HARNESS_HOME>)((?:(?:\\\\|\\|/)[\w.\-]+)*)")
UPDATE = os.environ.get("HARNESS_UPDATE_SNAPSHOTS") == "1"

# One model name for each prompt family of model_prompts.py. The provider name ("fake") does not count.
FAMILIES = {
    "claude": "anthropic/claude-opus-5-5",
    "gpt": "openai/gpt-5.5",
    "gemini": "google/gemini-3-pro",
    "deepseek": "deepseek/deepseek-v4-pro",
    "kimi": "moonshot/kimi-k2",
    "mistral": "local/mistral-large",
    "generic": "ollama/llama3.3:70b",
    "small": "ollama/qwen2.5-coder:7b",
}


@pytest.fixture
def pinned(monkeypatch):
    """Fixed values for the parts of the prompt that change with the computer and the day."""
    fixed = types.SimpleNamespace(date=types.SimpleNamespace(today=lambda: datetime.date(2026, 1, 1)))
    monkeypatch.setattr("harness_daemon.prompt.datetime", fixed)
    monkeypatch.setattr("harness_daemon.prompt.os_name", lambda: "TestOS 1.0")


def normalize(text: str, project: Path, harness_home: Path) -> str:
    """Replace the folders of this test run with fixed names. JSON text has escaped backslashes."""
    pairs = [
        (str(memory_dir(project)), "<MEMORY>"),
        (str(project.resolve()), "<PROJECT>"),
        (str(project), "<PROJECT>"),
        (str(harness_home.resolve()), "<HARNESS_HOME>"),
        (str(harness_home), "<HARNESS_HOME>"),
    ]
    for path, name in pairs:
        text = text.replace(json.dumps(path)[1:-1], name).replace(path, name)
    # A Windows path after a placeholder has backslashes (two in JSON text). Only these become "/": a global
    # replace would also change JSON escapes such as \n.
    return PLACEHOLDER_PATH.sub(lambda m: m.group(1) + re.sub(r"\\\\|\\", "/", m.group(2)), text)


def assert_snapshot(name: str, text: str) -> None:
    path = SNAPSHOTS / name
    text = text.replace("\r\n", "\n")
    if not text.endswith("\n"):
        text += "\n"
    if UPDATE or not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        if not UPDATE:
            pytest.fail(f"New snapshot {name}. Check the file, then run the test again.")
        return
    expected = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    if text != expected:
        diff = "".join(difflib.unified_diff(expected.splitlines(True), text.splitlines(True),
                                            f"snapshots/{name}", "now"))
        pytest.fail(f"The snapshot {name} changed. If the change is intended, run:\n"
                    f"HARNESS_UPDATE_SNAPSHOTS=1 python -m pytest tests/test_prompt_snapshots.py\n\n{diff}")


def make(project: Path, model: str, user_facing: bool = True) -> Agent:
    async def emit(event):
        return None

    async def approver(request):
        return "allow_once"

    provider, _ = resolve_model("fake/test-model")
    settings = load_settings(project)
    settings["shell"] = "bash"
    return Agent(cwd=project, client=ModelClient(provider, model), emit=emit, approver=approver,
                 settings=settings, user_facing=user_facing)


def render(agent: Agent) -> tuple[str, str]:
    return agent.system_prompt, json.dumps(agent.tool_schemas(), indent=2, ensure_ascii=False)


@pytest.fixture
def snapshot_project(project):
    (project / "HARNESS.md").write_text("Use tabs in Python files.\n", encoding="utf-8")
    return project


@pytest.mark.parametrize("family", sorted(FAMILIES))
def test_the_prompt_of_each_family(family, harness_home, snapshot_project, pinned):
    prompt, _ = render(make(snapshot_project, FAMILIES[family]))
    assert_snapshot(f"prompt/{family}.txt", normalize(prompt, snapshot_project, harness_home))


def test_the_tools_of_the_agent(harness_home, snapshot_project, pinned):
    """All families get the same tools now. A tool set for one family (for example apply_patch) changes this."""
    tools = {family: render(make(snapshot_project, model))[1] for family, model in FAMILIES.items()}
    assert len(set(tools.values())) == 1, "The tools differ by family. Give each family its own snapshot."
    assert_snapshot("tools/agent.json", normalize(tools["claude"], snapshot_project, harness_home))


def test_the_prompt_of_a_subagent(harness_home, snapshot_project, pinned):
    prompt, tools = render(make(snapshot_project, FAMILIES["claude"], user_facing=False))
    assert_snapshot("prompt/subagent.txt", normalize(prompt, snapshot_project, harness_home))
    assert_snapshot("tools/subagent.json", normalize(tools, snapshot_project, harness_home))


def test_the_first_request_of_a_session(daemon, harness_home, snapshot_project, fake_model, pinned):  # noqa: F811
    """A session adds the task, routine, session, and preview tools. This is the request that a user sends."""
    (harness_home / "settings.json").write_text(json.dumps({"shell": "bash"}), encoding="utf-8")
    fake_model.script({"text": "Hi."})
    c = Client(daemon)
    c.new_session(snapshot_project)
    c.send({"type": "prompt", "text": "hi"})
    c.until("turn.end")
    request = fake_model.requests[0]
    assert_snapshot("prompt/session.txt", normalize(request["messages"][0]["content"], snapshot_project, harness_home))
    tools = json.dumps(request["tools"], indent=2, ensure_ascii=False)
    assert_snapshot("tools/session.json", normalize(tools, snapshot_project, harness_home))
