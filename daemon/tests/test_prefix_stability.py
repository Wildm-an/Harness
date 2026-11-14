"""The start of each model request must stay the same in a session, so that the prompt cache of the endpoint works.

The system message and the tool list are the prefix. A state change (plan mode, memory, settings) goes in a
[Harness: ...] note at the end of the messages, never in the prefix.
"""

from __future__ import annotations

import asyncio
import json

from test_agent import make_agent


def tool_names(request: dict) -> list[str]:
    return [t["function"]["name"] for t in request.get("tools") or []]


def test_the_prefix_stays_the_same_across_turns_and_setting_changes(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]},
        {"text": "It greets."},
        {"text": "Ok."},
        {"text": "Done."},
    )
    agent, _, _ = make_agent(project)
    agent.context_length = 200_000  # No compaction: a summary starts a new prefix by design.
    asyncio.run(agent.run_turn("what does hello.py do?"))
    agent.reload_settings({**agent.settings, "permission_mode": "plan"})
    asyncio.run(agent.run_turn("thanks"))
    agent.memory.save("python", "The user writes Python.", "user", "The user writes Python.")
    agent.memory_changed()
    agent.reload_settings({**agent.settings, "permission_mode": "acceptEdits"})
    asyncio.run(agent.run_turn("one more"))

    requests = fake_model.requests
    assert len(requests) == 4
    first = requests[0]
    for request in requests[1:]:
        assert request["messages"][0] == first["messages"][0]
        # The order counts: the endpoint caches the exact bytes of the request start.
        assert tool_names(request) == tool_names(first)
        assert json.dumps(request["tools"], sort_keys=True) == json.dumps(first["tools"], sort_keys=True)


def test_the_messages_only_grow_at_the_end(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]},
        {"text": "It greets."},
        {"text": "Ok."},
    )
    agent, _, _ = make_agent(project)
    agent.context_length = 200_000
    asyncio.run(agent.run_turn("what does hello.py do?"))
    asyncio.run(agent.run_turn("thanks"))
    requests = fake_model.requests
    for before, after in zip(requests, requests[1:]):
        assert after["messages"][:len(before["messages"])] == before["messages"]


def test_two_agents_with_the_same_inputs_send_the_same_prefix(harness_home, project):
    first, _, _ = make_agent(project)
    second, _, _ = make_agent(project)
    assert first.system_prompt == second.system_prompt
    assert json.dumps(first.tool_schemas()) == json.dumps(second.tool_schemas())
    prompt = first.system_prompt
    first._rebuild_prompt()
    assert first.system_prompt == prompt


def test_a_setting_change_keeps_the_tool_order(harness_home, project):
    agent, _, _ = make_agent(project)
    before = [t["function"]["name"] for t in agent.tool_schemas()]
    for mode in ("plan", "default", "acceptEdits"):
        agent.reload_settings({**agent.settings, "permission_mode": mode})
        assert [t["function"]["name"] for t in agent.tool_schemas()] == before
    # A tool that a setting removes comes back at its old place.
    agent.reload_settings({**agent.settings, "web_search": "off"})
    assert "web_search" not in [t["function"]["name"] for t in agent.tool_schemas()]
    agent.reload_settings({**agent.settings, "web_search": "auto"})
    assert [t["function"]["name"] for t in agent.tool_schemas()] == before
