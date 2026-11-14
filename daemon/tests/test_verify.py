"""The verification gate (verify.py): the verify command of the project runs when a turn that changed files ends."""

from __future__ import annotations

import asyncio
import json
import sys

from harness_daemon.verify import output_tail, verify_command

from test_agent import make_agent

PYTHON = sys.executable.replace("\\", "/")
CHECK = """\
import os, sys
print("checked:", os.environ.get("HARNESS_CHANGED_FILES", "").replace(chr(10), ","))
if os.path.exists("fail.flag"):
    print("line before")
    print("AssertionError: 2 != 3")
    sys.exit(1)
"""


def setup(project, failing=False, **settings):
    (project / "check.py").write_text(CHECK)
    if failing:
        (project / "fail.flag").write_text("x")
    agent, events, requests = make_agent(project, verify_command=f'"{PYTHON}" check.py', **settings)
    return agent, events


def notices(events):
    return [e["text"] for e in events if e["type"] == "notice"]


EDIT = {"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'hi'"}}


def test_output_tail_keeps_the_end_and_cuts_at_a_line():
    text = "\n".join(f"line {i}" for i in range(100))
    tail = output_tail(text, 50)
    assert tail.endswith("line 99") and tail.splitlines()[1].startswith("line ")
    assert tail.startswith("[... ") and output_tail("short", 50) == "short"


def test_no_command_means_no_run(harness_home, project, fake_model):
    fake_model.script({"tool_calls": [EDIT]}, {"text": "Done."})
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("change it")) == "end"
    assert len(fake_model.requests) == 2 and "verify" not in events[-1]


def test_a_turn_with_no_file_change_does_not_run_the_command(harness_home, project, fake_model):
    fake_model.script({"text": "Hello."})
    agent, events = setup(project)
    asyncio.run(agent.run_turn("hi"))
    assert not any("verify command" in n for n in notices(events))


def test_a_pass_adds_nothing_to_the_model_request(harness_home, project, fake_model):
    fake_model.script({"tool_calls": [EDIT]}, {"text": "Done."})
    agent, events = setup(project)
    assert asyncio.run(agent.run_turn("change it")) == "end"
    assert len(fake_model.requests) == 2  # No extra step.
    assert any(n.startswith("The verify command passed") for n in notices(events))
    verify = events[-1]["verify"]
    assert verify["status"] == "passed" and verify["runs"] == 1 and verify["exit_code"] == 0


def test_a_failure_sends_the_end_of_the_output_and_the_turn_continues(harness_home, project, fake_model):
    fake_model.script({"tool_calls": [EDIT]}, {"text": "Done."}, {"text": "The test failed before my change."})
    agent, events = setup(project, failing=True)
    assert asyncio.run(agent.run_turn("change it")) == "end"
    note = fake_model.requests[2]["messages"][-1]["content"]
    assert note.startswith("[Harness: The verify command of this project failed")
    assert "Exit code: 1" in note and "AssertionError: 2 != 3" in note and "checked: hello.py" in note
    assert "Do not change or remove a test" in note
    # The model stopped with no new file change: no second run.
    assert events[-1]["verify"]["runs"] == 1 and events[-1]["verify"]["status"] == "failed"


def test_the_gate_stops_after_the_limit_of_continuations(harness_home, project, fake_model, monkeypatch):
    # One edit, then a stop after each of the 5 failures, then the last stop at the limit.
    fake_model.script({"tool_calls": [EDIT]}, *[{"text": "Done."}] * 6)
    agent, events = setup(project, failing=True)
    # Each step changes the file again, so each stop runs the command.
    original = agent._run_verify_gate

    async def changed_again():
        agent._turn_changed.add("hello.py")
        return await original()

    agent._run_verify_gate = changed_again
    assert asyncio.run(agent.run_turn("change it")) == "end"
    assert agent._stop_continuations == 5 and len(fake_model.requests) == 7
    assert any("still fails after 5 runs" in n for n in notices(events))


def test_a_deny_rule_blocks_the_command(harness_home, project, fake_model):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"deny": ["bash"]}))
    fake_model.script({"tool_calls": [EDIT]}, {"text": "Done."})
    agent, events = setup(project)
    assert asyncio.run(agent.run_turn("change it")) == "end"
    assert any("blocks the verify command" in n for n in notices(events)) and "verify" not in events[-1]


def test_plan_mode_and_a_subagent_do_not_run_it(harness_home, project, fake_model):
    agent, events = setup(project, permission_mode="plan")
    agent._turn_changed.add("hello.py")
    assert asyncio.run(agent._run_verify_gate()) is None
    agent, _ = setup(project)
    agent.user_facing = False
    agent._turn_changed.add("hello.py")
    assert asyncio.run(agent._run_verify_gate()) is None


def test_a_worktree_uses_the_command_of_its_project(project):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"verify_command": "npm test"}))
    worktree = project / ".harness" / "worktrees" / "fix"
    worktree.mkdir(parents=True)
    assert verify_command({}, worktree) == "npm test"
    assert verify_command({"verify_command": "make check"}, worktree) == "make check"
    assert verify_command({}, project) is None


def test_a_stop_hook_message_is_a_harness_note(harness_home, project, fake_model, monkeypatch):
    from harness_daemon.hooks import HookOutcome

    fake_model.script({"text": "Done."}, {"text": "Done again."})
    agent, events, _ = make_agent(project)
    calls = []

    async def run(event, payload):
        calls.append(payload)
        return HookOutcome(blocked="run the tests" if len(calls) == 1 else None)

    monkeypatch.setattr(agent.command_hooks, "has", lambda event: event == "Stop")
    monkeypatch.setattr(agent.command_hooks, "run", run)
    asyncio.run(agent.run_turn("go"))
    note = fake_model.requests[1]["messages"][-1]["content"]
    assert note == "[Harness: A Stop hook asks you to continue: run the tests]"
    assert any(n.startswith("A Stop hook asked the agent to continue") for n in notices(events))
    assert not any("A plugin added a message" in n for n in notices(events))
