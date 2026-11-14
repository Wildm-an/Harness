"""A reply that the output limit cut (finish_reason "length") is not a finished reply."""

from __future__ import annotations

import asyncio
import json

import pytest

from harness_daemon.loop_guards import CUT_EMPTY_NOTE, CUT_REPLY_NOTE, MAX_CUT_REPLIES, json_ends_early
from harness_daemon.providers import finish_kind

from test_agent import make_agent


@pytest.mark.parametrize("reason, kind", [
    ("length", "length"), ("LENGTH", "length"), ("max_tokens", "length"), ("model_length", "length"),
    ("content_filter", "filter"), ("stop", "other"), ("tool_calls", "other"), (None, "other"), ("", "other"),
])
def test_finish_kind(reason, kind):
    assert finish_kind(reason) == kind


@pytest.mark.parametrize("raw, early", [
    ('{"a": "b', True), ('{"a": 1', True), ('{"path": "x", "content": "abc', True),
    ("{not json", False), ('{"a": 1}', False), ('[1, 2] x', False),
])
def test_json_ends_early(raw, early):
    assert json_ends_early(raw) is early


def notices(events):
    return [e["text"] for e in events if e["type"] == "notice"]


def test_a_cut_reply_gets_a_continuation(harness_home, project, fake_model):
    fake_model.script({"text": "The answer is", "finish": "length"}, {"text": " 42."})
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("what is the answer?")) == "end"
    assert len(fake_model.requests) == 2
    last = fake_model.requests[1]["messages"][-1]
    assert last["role"] == "user" and last["content"] == CUT_REPLY_NOTE
    assert any("output limit" in n for n in notices(events))


def test_a_cut_reply_with_no_text_gets_the_short_note(harness_home, project, fake_model):
    fake_model.script({"reasoning": "thinking a lot", "text": "", "finish": "length"}, {"text": "Short answer."})
    agent, _, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("go")) == "end"
    assert fake_model.requests[1]["messages"][-1]["content"] == CUT_EMPTY_NOTE


def test_cut_replies_stop_after_the_cap(harness_home, project, fake_model):
    fake_model.script(*[{"text": f"part {i}", "finish": "length"} for i in range(MAX_CUT_REPLIES + 1)])
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("write a lot")) == "error"
    assert len(fake_model.requests) == MAX_CUT_REPLIES + 1
    error = next(e for e in events if e["type"] == "error")
    assert f"{MAX_CUT_REPLIES + 1} times in sequence" in error["message"]


def test_the_cut_count_restarts_after_a_complete_reply(harness_home, project, fake_model):
    call = {"name": "read", "arguments": {"path": "hello.py"}}
    fake_model.script(
        *[{"text": "a", "finish": "length"}] * MAX_CUT_REPLIES,
        {"tool_calls": [call]},
        *[{"text": "b", "finish": "length"}] * MAX_CUT_REPLIES,
        {"text": "Done."},
    )
    agent, _, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("go")) == "end"


def test_a_cut_tool_call_gets_the_smaller_call_error(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "write", "arguments": '{"path": "a.txt", "content": "abc'}], "finish": "length"},
        {"text": "I will send a smaller call."},
    )
    agent, events, requests = make_agent(project)
    assert asyncio.run(agent.run_turn("write a.txt")) == "end"
    result = next(e for e in events if e["type"] == "tool.result")
    assert result["is_error"] and "Send a smaller call" in result["output"] and "cut this write call" in result["output"]
    assert not (project / "a.txt").exists() and requests == []
    # The next request holds valid JSON in each tool call.
    for message in fake_model.requests[1]["messages"]:
        for call in message.get("tool_calls") or []:
            json.loads(call["function"]["arguments"])


def test_complete_calls_before_a_cut_call_still_run(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}},
                        {"name": "write", "arguments": '{"path": "b.txt", "content": "x'}], "finish": "length"},
        {"text": "Ok."},
    )
    agent, events, _ = make_agent(project)
    asyncio.run(agent.run_turn("go"))
    results = [e for e in events if e["type"] == "tool.result"]
    assert not results[0]["is_error"] and "def greet" in results[0]["output"]
    assert results[1]["is_error"] and "Send a smaller call" in results[1]["output"]


def test_a_cut_call_with_no_finish_reason(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "write", "arguments": '{"path": "a.txt", "content": "abc'}], "finish": None},
        {"text": "Ok."},
    )
    agent, events, _ = make_agent(project)
    asyncio.run(agent.run_turn("go"))
    result = next(e for e in events if e["type"] == "tool.result")
    assert "possibly cut the call" in result["output"] and "Unterminated string" in result["output"]


def test_a_cut_call_with_no_arguments(harness_home, project, fake_model):
    fake_model.script({"tool_calls": [{"name": "write", "arguments": ""}], "finish": "length"}, {"text": "Ok."})
    agent, events, _ = make_agent(project)
    asyncio.run(agent.run_turn("go"))
    result = next(e for e in events if e["type"] == "tool.result")
    assert "cut this write call" in result["output"]


def test_a_filtered_reply_ends_the_turn_with_a_notice(harness_home, project, fake_model):
    fake_model.script({"text": "Part of", "finish": "content_filter"})
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("go")) == "end"
    assert len(fake_model.requests) == 1
    assert any("filtered this reply" in n for n in notices(events))


def test_no_finish_reason_changes_nothing(harness_home, project, fake_model):
    fake_model.script({"text": "Hello.", "finish": None})
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("hi")) == "end"
    assert len(fake_model.requests) == 1 and notices(events) == []


def test_the_system_prompt_and_tools_stay_the_same(harness_home, project, fake_model):
    fake_model.script({"text": "The answer is", "finish": "length"}, {"text": " 42."})
    agent, _, _ = make_agent(project)
    asyncio.run(agent.run_turn("go"))
    first, second = fake_model.requests
    assert first["messages"][0] == second["messages"][0] and first["tools"] == second["tools"]
