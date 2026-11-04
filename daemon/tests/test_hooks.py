"""Command hooks from the settings files (hooks.py), in the form of Claude Code hooks."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from harness_daemon.hooks import CommandHooks, HookCommand, load_hooks
from harness_daemon.tools.shell import detect_shell

from test_agent import make_agent, types

PYTHON = Path(sys.executable).as_posix()

# A hook script: it writes each event to a log, then acts as the file "action.json" says.
SCRIPT = r'''
import json, sys, pathlib
event = json.load(sys.stdin)
here = pathlib.Path(__file__).parent
with open(here / "log.jsonl", "a", encoding="utf-8") as f:
    f.write(json.dumps(event) + "\n")
actions = json.loads((here / "action.json").read_text())
act = actions.get(event["hook_event_name"], {})
if event["hook_event_name"] == "Stop" and event.get("stop_hook_active"):
    act = {}
if act.get("stderr"):
    sys.stderr.write(act["stderr"])
if act.get("stdout"):
    sys.stdout.write(act["stdout"] if isinstance(act["stdout"], str) else json.dumps(act["stdout"]))
sys.exit(act.get("exit", 0))
'''


def setup_hooks(project: Path, actions: dict, events: dict[str, str], where: str = "project") -> Path:
    folder = project / ".hooktest"
    folder.mkdir(exist_ok=True)
    (folder / "hook.py").write_text(SCRIPT, encoding="utf-8")
    (folder / "action.json").write_text(json.dumps(actions), encoding="utf-8")
    command = f'"{PYTHON}" "{(folder / "hook.py").as_posix()}"'
    hooks = {event: [{"matcher": matcher, "hooks": [{"type": "command", "command": command}]}]
             for event, matcher in events.items()}
    settings = project / ".harness" / "settings.json"
    settings.parent.mkdir(exist_ok=True)
    data = json.loads(settings.read_text()) if settings.exists() else {}
    data["hooks"] = hooks
    settings.write_text(json.dumps(data), encoding="utf-8")
    return folder


def logged(folder: Path) -> list[dict]:
    path = folder / "log.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def test_matchers_use_the_harness_and_the_claude_code_names():
    hook = HookCommand("PreToolUse", "Bash|Edit", "x")
    assert hook.matches(("bash", "Bash")) and hook.matches(("edit", "Edit"))
    assert not hook.matches(("read", "Read"))
    assert HookCommand("PreToolUse", "", "x").matches(("read", "Read"))
    assert HookCommand("PreToolUse", "mcp__.*", "x").matches(("mcp__github__create_issue",))


def test_hooks_come_from_the_user_and_the_project_settings(harness_home, project):
    (harness_home / "settings.json").write_text(json.dumps(
        {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo user"}]}]}}))
    setup_hooks(project, {}, {"PreToolUse": "Bash"})
    found = load_hooks(project)
    assert [(h.event, h.source.endswith(("settings.json",))) for h in found] == [("Stop", True), ("PreToolUse", True)]
    data = json.loads((project / ".harness" / "settings.json").read_text())
    data["disableAllHooks"] = True
    (project / ".harness" / "settings.json").write_text(json.dumps(data))
    assert load_hooks(project) == []


def test_a_pre_tool_use_hook_blocks_a_command(harness_home, project, fake_model):
    folder = setup_hooks(project, {"PreToolUse": {"exit": 2, "stderr": "No rm in this project."}}, {"PreToolUse": "Bash"})
    fake_model.script({"tool_calls": [{"name": "bash", "arguments": {"command": "rm -rf build"}}]}, {"text": "OK."})
    agent, events, requests = make_agent(project)
    assert asyncio.run(agent.run_turn("clean up")) == "end"
    result = next(e for e in events if e["type"] == "tool.result")
    assert result["is_error"] and "No rm in this project." in result["output"]
    assert requests == []  # The user did not get a question.
    sent = logged(folder)[0]
    assert (sent["hook_event_name"], sent["tool_name"], sent["harness_tool_name"]) == ("PreToolUse", "Bash", "bash")
    assert sent["tool_input"]["command"] == "rm -rf build"


def test_a_pre_tool_use_hook_can_allow_with_no_question(harness_home, project, fake_model):
    allow = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}
    setup_hooks(project, {"PreToolUse": {"stdout": allow}}, {"PreToolUse": "Edit"})
    fake_model.script(
        {"tool_calls": [{"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'hey'"}}]},
        {"text": "Done."},
    )
    agent, events, requests = make_agent(project, decision="deny")
    assert asyncio.run(agent.run_turn("edit it")) == "end"
    assert requests == [] and "'hey'" in (project / "hello.py").read_text()


def test_a_post_tool_use_hook_gives_feedback_to_the_agent(harness_home, project, fake_model):
    folder = setup_hooks(project, {"PostToolUse": {"stdout": {"decision": "block", "reason": "Run the linter now."}}},
                         {"PostToolUse": "Read"})
    fake_model.script({"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]}, {"text": "OK."})
    agent, events, _ = make_agent(project)
    asyncio.run(agent.run_turn("read it"))
    result = next(e for e in events if e["type"] == "tool.result")
    assert "[A PostToolUse hook says: Run the linter now.]" in result["output"]
    assert "hello" in logged(folder)[0]["tool_response"]["output"]
    assert logged(folder)[0]["tool_input"]["file_path"].endswith("hello.py")


def test_prompt_hooks_add_context_or_block(harness_home, project, fake_model):
    folder = setup_hooks(project, {"SessionStart": {"stdout": "The branch is main."},
                                   "UserPromptSubmit": {"stdout": "Today is Tuesday."}},
                         {"SessionStart": "", "UserPromptSubmit": ""})
    fake_model.script({"text": "Hi."}, {"text": "Again."})
    agent, events, _ = make_agent(project)
    asyncio.run(agent.run_turn("hello"))
    user = agent.history[0]
    assert user["display"] == "hello" and "The branch is main." in user["content"] and "Today is Tuesday." in user["content"]
    asyncio.run(agent.run_turn("again"))
    assert [e["hook_event_name"] for e in logged(folder)] == ["SessionStart", "UserPromptSubmit", "UserPromptSubmit"]

    (folder / "action.json").write_text(json.dumps({"UserPromptSubmit": {"exit": 2, "stderr": "No secrets in prompts."}}))
    assert asyncio.run(agent.run_turn("my password is x")) == "blocked"
    assert any(e["type"] == "error" and "No secrets in prompts." in e["message"] for e in events)
    assert not any("password" in str(m.get("content")) for m in agent.history)


def test_a_stop_hook_makes_the_agent_continue_one_time(harness_home, project, fake_model):
    folder = setup_hooks(project, {"Stop": {"exit": 2, "stderr": "Run the tests first."}}, {"Stop": ""})
    fake_model.script({"text": "Done."}, {"text": "The tests pass."})
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("fix it")) == "end"
    assert "Run the tests first." in fake_model.requests[-1]["messages"][-1]["content"]
    stops = [e for e in logged(folder) if e["hook_event_name"] == "Stop"]
    assert [e["stop_hook_active"] for e in stops] == [False, True]


def test_a_failed_hook_gives_a_warning_and_does_not_block(harness_home, project, fake_model):
    setup_hooks(project, {"PreToolUse": {"exit": 1, "stderr": "oops"}}, {"PreToolUse": "Read"})
    fake_model.script({"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]}, {"text": "OK."})
    agent, events, _ = make_agent(project)
    asyncio.run(agent.run_turn("read it"))
    assert not next(e for e in events if e["type"] == "tool.result")["is_error"]
    assert any(e["type"] == "notice" and "exit code 1" in e["text"] and "oops" in e["text"] for e in events)


def test_a_hook_gets_the_project_folder_in_the_environment(project):
    shell = detect_shell()
    command = f'"{PYTHON}" -c "import os; print(os.environ[\'HARNESS_PROJECT_DIR\'])"'
    project_hooks = project / ".harness"
    project_hooks.mkdir(exist_ok=True)
    (project_hooks / "settings.json").write_text(json.dumps(
        {"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": command}]}]}}))
    outcome = asyncio.run(CommandHooks(project, shell).run("SessionStart", {}))
    assert outcome.context == [str(project)]
