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
        {"text": ""},  # The reply to the reminder to close the task list (test below).
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


def test_the_agent_gets_a_reminder_when_it_does_not_update_the_plan(daemon, project, fake_model):  # noqa: F811
    glob = {"name": "glob", "arguments": {"pattern": "*.py"}}
    plan = {"name": "update_plan", "arguments": {"items": [
        {"content": "Fix the bug", "status": "in_progress"},
        {"content": "Run the tests", "status": "pending"}]}}
    fake_model.script({"tool_calls": [plan]}, *[{"tool_calls": [glob]}] * 9, {"text": "Done."}, {"text": ""})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Fix the bug"})
    c.until("turn.end")
    # Request n+2 follows n tool calls after the plan. The reminder comes after 8 calls, one time.
    assert "since your last update_plan" not in _user_texts(fake_model.requests[8])
    assert "8 tool calls since your last update_plan" in _user_texts(fake_model.requests[9])
    assert _user_texts(fake_model.requests[10]).count("since your last update_plan") == 1
    c.close()


PLAN = [{"content": "Fix the bug", "status": "completed"}, {"content": "Run the tests", "status": "in_progress"}]
CLOSED = [{"content": "Fix the bug", "status": "completed"}, {"content": "Run the tests", "status": "completed"}]


def _plan(items: list[dict]) -> dict:
    return {"name": "update_plan", "arguments": {"items": items}}


def test_a_turn_that_ends_with_open_steps_gets_one_more_step_to_close_the_plan(daemon, project, fake_model):  # noqa: F811
    fake_model.script({"tool_calls": [_plan(PLAN)]}, {"text": "The bug is fixed."},
                      {"tool_calls": [_plan(CLOSED)]}, {"text": ""})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Fix the bug"})
    c.until("turn.end")
    assert len(fake_model.requests) == 4
    assert "You ended the turn" not in _user_texts(fake_model.requests[1])
    reminder = _user_texts(fake_model.requests[2])
    assert "steps that are not completed: Run the tests" in reminder and "do not write it again" in reminder
    # One reminder in a turn: the last request does not get it again.
    assert _user_texts(fake_model.requests[3]).count("You ended the turn") == 1
    c.close()


def test_wrap_up_with_open_steps_gets_the_reminder_before_the_answer(daemon, project, fake_model):  # noqa: F811
    wrap = {"name": "wrap_up", "arguments": {"recap": "The bug is fixed."}}
    fake_model.script({"tool_calls": [_plan(PLAN)]}, {"tool_calls": [wrap]},
                      {"tool_calls": [_plan(CLOSED)]}, {"text": "Done."})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Fix the bug"})
    c.until("turn.end")
    assert len(fake_model.requests) == 4
    assert "Before your final answer, call update_plan" in _user_texts(fake_model.requests[2])
    assert "You ended the turn" not in _user_texts(fake_model.requests[3])
    c.close()


def test_a_closed_plan_or_no_plan_ends_the_turn_at_once(daemon, project, fake_model):  # noqa: F811
    fake_model.script({"tool_calls": [_plan(CLOSED)]}, {"text": "Done."}, {"text": "A short answer."})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Fix the bug"})
    c.until("turn.end")
    assert len(fake_model.requests) == 2
    # The next turn has no plan of its own: an old, closed plan does not matter.
    c.send({"type": "prompt", "text": "What is 2 + 2?"})
    c.until("turn.end")
    assert len(fake_model.requests) == 3
    c.close()
