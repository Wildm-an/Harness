"""The task list reminders (agent.py _plan_note): the agent shows update_plan and keeps it current."""

from __future__ import annotations

import json

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.


def _user_texts(request: dict) -> str:
    return "\n".join(str(m.get("content")) for m in request["messages"] if m["role"] == "user")


def test_the_agent_gets_a_reminder_to_show_and_update_the_plan(daemon, project, fake_model):  # noqa: F811
    glob = {"name": "glob", "arguments": {"pattern": "*.py"}}
    plan = {"name": "update_plan", "arguments": {"items": [
        {"content": "Read the code", "status": "completed"},
        {"content": "Fix the bug", "status": "in_progress"},
        {"content": "Run the tests", "status": "pending"}]}}
    fake_model.script(
        {"tool_calls": [glob]}, {"tool_calls": [glob]}, {"tool_calls": [glob]},
        {"tool_calls": [plan]},
        {"text": "Stopped for now."},
        {"text": "Continued."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Fix the bug"})
    c.until("turn.end")
    # Three tool calls with no plan: the next request has the reminder, one time.
    assert "showed no task list" not in _user_texts(fake_model.requests[2])
    assert "showed no task list" in _user_texts(fake_model.requests[3])
    assert _user_texts(fake_model.requests[4]).count("showed no task list") == 1

    # The next prompt: the plan has open steps, so the first request names them.
    c.send({"type": "prompt", "text": "Also add a test"})
    c.until("turn.end")
    text = _user_texts(fake_model.requests[-1])
    assert "steps that are not completed: Fix the bug; Run the tests" in text
    assert json.dumps(plan["arguments"])  # The plan is valid JSON for the history.
    c.close()
