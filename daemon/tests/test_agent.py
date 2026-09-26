from __future__ import annotations

import asyncio

from harness_daemon.agent import Agent
from harness_daemon.config import load_settings
from harness_daemon.providers import ModelClient, check_tool_support, resolve_model


def make_agent(project, decision="allow_once", **setting_overrides):
    events: list[dict] = []
    requests: list[dict] = []

    async def emit(event):
        events.append(event)

    async def approver(request):
        requests.append(request)
        return decision

    provider, model = resolve_model("fake/test-model")
    settings = load_settings(project)
    settings.update(setting_overrides)
    agent = Agent(cwd=project, client=ModelClient(provider, model), emit=emit, approver=approver, settings=settings)
    return agent, events, requests


def types(events):
    return [e["type"] for e in events]


def test_text_reply_streams_tokens(harness_home, project, fake_model):
    fake_model.script({"text": "Hello from the model."})
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("hi")) == "end"
    assert "".join(e["text"] for e in events if e["type"] == "token") == "Hello from the model."
    assert events[-1]["type"] == "turn.end"
    assert events[-1]["usage"]["completion_tokens"] == 10
    sent = fake_model.requests[0]
    assert sent["messages"][0]["role"] == "system"
    assert sent["messages"][-1] == {"role": "user", "content": "hi"}
    assert {t["function"]["name"] for t in sent["tools"]} == {"read", "glob", "grep", "edit", "write", "bash"}


def test_tool_call_loop(harness_home, project, fake_model):
    fake_model.script(
        {"text": "I will read it.", "tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]},
        {"text": "The file defines greet()."},
    )
    agent, events, requests = make_agent(project)
    assert asyncio.run(agent.run_turn("what is in hello.py?")) == "end"
    assert types(events).count("tool.start") == 1
    result = next(e for e in events if e["type"] == "tool.result")
    assert not result["is_error"] and "def greet" in result["output"]
    assert requests == []  # read needs no approval
    # The second request holds the assistant tool call and the tool result.
    second = fake_model.requests[1]["messages"]
    assert second[-2]["tool_calls"][0]["function"]["name"] == "read"
    assert second[-1]["role"] == "tool" and "def greet" in second[-1]["content"]


def test_edit_asks_permission_and_sends_diff(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'hi'"}}]},
        {"text": "Done."},
    )
    agent, events, requests = make_agent(project)
    asyncio.run(agent.run_turn("change hello to hi"))
    assert len(requests) == 1 and requests[0]["tool"] == "edit"
    assert "+    return 'hi'" in requests[0]["diff"]
    assert "'hi'" in (project / "hello.py").read_text()
    changed = next(e for e in events if e["type"] == "fs.changed")
    assert changed["path"] == "hello.py" and changed["by"] == "agent" and len(changed["hash"]) == 64


def test_deny_ends_the_turn(harness_home, project, fake_model):
    fake_model.script({"tool_calls": [
        {"name": "bash", "arguments": {"command": "echo one"}},
        {"name": "bash", "arguments": {"command": "echo two"}},
    ]})
    agent, events, requests = make_agent(project, decision="deny")
    assert asyncio.run(agent.run_turn("run things")) == "denied"
    assert len(requests) == 1
    tool_msgs = [m for m in agent.history if m["role"] == "tool"]
    assert len(tool_msgs) == 2  # Each tool call has a result, so the history stays valid.
    assert "denied" in tool_msgs[0]["content"] and "earlier tool call" in tool_msgs[1]["content"]


def test_max_tool_calls(harness_home, project, fake_model):
    call = {"name": "read", "arguments": {"path": "hello.py"}}
    fake_model.script({"tool_calls": [call]}, {"tool_calls": [call, call]})
    agent, events, _ = make_agent(project, max_tool_calls=2)
    assert asyncio.run(agent.run_turn("loop")) == "max_tool_calls"
    assert types(events).count("tool.start") == 2
    assert "limit of 2 tool calls" in agent.history[-1]["content"]


def test_bad_arguments_and_unknown_tool_go_back_to_the_model(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "read", "arguments": "{not json"}, {"name": "write_file", "arguments": {}}]},
        {"text": "Sorry."},
    )
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("go")) == "end"
    results = [e for e in events if e["type"] == "tool.result"]
    assert all(r["is_error"] for r in results)
    assert "not valid JSON" in results[0]["output"] and "Unknown tool" in results[1]["output"]


def test_interrupt_stops_a_running_command(harness_home, project, fake_model):
    fake_model.script({"tool_calls": [{"name": "bash", "arguments": {"command": "sleep 30"}}]})
    agent, events, _ = make_agent(project)

    async def scenario():
        task = asyncio.create_task(agent.run_turn("wait"))
        while "tool.start" not in types(events):
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.5)
        task.cancel()
        return await asyncio.wait_for(task, 10)

    assert asyncio.run(scenario()) == "interrupted"
    assert events[-1] == {"type": "turn.end", "usage": events[-1]["usage"], "stop_reason": "interrupted"}
    assert agent.history[-1]["role"] == "tool" and "interrupted" in agent.history[-1]["content"]


def test_model_error_is_reported(harness_home, project, fake_model):
    agent, events, _ = make_agent(project)  # No scripted reply: the fake server returns HTTP 500.
    assert asyncio.run(agent.run_turn("hi")) == "error"
    assert any(e["type"] == "error" for e in events)


def test_repeated_call_ids_become_unique(harness_home, project, fake_model):
    call = {"id": "call_0", "name": "read", "arguments": {"path": "hello.py"}}
    fake_model.script({"tool_calls": [call]}, {"tool_calls": [call]}, {"text": "ok"})
    agent, events, _ = make_agent(project)
    asyncio.run(agent.run_turn("read twice"))
    ids = [e["id"] for e in events if e["type"] == "tool.start"]
    assert len(ids) == 2 and len(set(ids)) == 2
    results = [m for m in agent.history if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in results] == ids
    assert results[0]["is_error"] is False
    # The model must not get the client-only field.
    sent = fake_model.requests[-1]["messages"]
    assert all("is_error" not in m for m in sent)


def test_tool_support_check(harness_home, fake_model):
    provider, model = resolve_model("fake/m")
    assert asyncio.run(check_tool_support(provider, model)) is True
    fake_model.capabilities = ["completion"]
    assert asyncio.run(check_tool_support(provider, model)) is False
