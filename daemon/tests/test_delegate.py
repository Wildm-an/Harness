"""The orchestrator tools of T3 Code (tools/delegate.py): delegate_task runs a child agent on another agent."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from harness_daemon import acp_harnesses
from harness_daemon.tools.base import ToolContext, ToolError
from harness_daemon.tools.shell import detect_shell
from harness_daemon.tools.delegate import (Delegation, Registry, TaskCancelTool, TaskStatusTool, child_mode,
                                           resolve_target, wake_detail)

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.

FAKE = Path(__file__).resolve().parent / "fake_acp_agent.py"


@pytest.fixture
def fake_agent(harness_home):
    """The fake ACP agent as an enabled agent of Settings > Agents. The sessions still use the built-in loop."""
    spec = acp_harnesses.save_custom("Fake ACP", f'"{sys.executable}" "{FAKE}"')
    settings = harness_home / "settings.json"
    data = json.loads(settings.read_text()) if settings.exists() else {}
    data["agents_enabled"] = [spec.id]
    settings.write_text(json.dumps(data))
    return spec


def _ctx(tmp_path, agent=None, model="fake/test-model", mode="default") -> ToolContext:
    ctx = ToolContext(cwd=tmp_path, settings={"permission_mode": mode}, shell=detect_shell())
    ctx.agent = lambda: (agent, model)
    return ctx


def test_the_target_comes_from_the_parent(tmp_path, fake_agent):
    ctx = _ctx(tmp_path)
    assert resolve_target({"task": "x"}, ctx) == (None, "fake/test-model", None)
    assert resolve_target({"target": {"providerInstanceId": fake_agent.id, "model": "smart"}}, ctx) == (
        fake_agent.id, "smart", None)
    # Another agent with no model: the default model of that agent, not the model of the parent.
    assert resolve_target({"target": {"providerInstanceId": fake_agent.id}}, ctx) == (fake_agent.id, None, None)
    assert resolve_target({"target": {"providerInstanceId": "harness", "options": {"effort": "max"}}}, ctx)[2] == "max"
    assert resolve_target({"target": {"options": [{"id": "effort", "value": "low"}]}}, ctx)[2] == "low"
    with pytest.raises(ToolError, match="Unknown providerInstanceId"):
        resolve_target({"target": {"providerInstanceId": "nope"}}, ctx)
    with pytest.raises(ToolError, match="not an option"):
        resolve_target({"target": {"options": {"effort": "huge"}}}, ctx)


def test_a_child_mode_is_not_above_the_parent(tmp_path):
    ctx = _ctx(tmp_path, mode="acceptEdits")
    assert child_mode(None, ctx) == "acceptEdits" and child_mode("inherit", ctx) == "acceptEdits"
    assert child_mode("plan", ctx) == "plan"
    with pytest.raises(ToolError, match="less limited"):
        child_mode("bypassPermissions", ctx)


def test_status_cancel_and_the_wake_text(tmp_path):
    async def main() -> None:
        stopped = asyncio.Event()

        async def wait() -> tuple[str, str]:
            await stopped.wait()
            return "interrupted", ""

        async def cancel() -> None:
            stopped.set()

        item = Delegation(session_id="s" * 32, title="Review", agent="codex-acp", model="gpt-5", folder=str(tmp_path),
                          wait=wait, cancel=cancel, pending=lambda: None)
        item.done = asyncio.ensure_future(item.wait())
        registry = Registry()
        registry.items["task-1"] = item
        ctx = _ctx(tmp_path)
        status = json.loads((await TaskStatusTool(registry).run({"taskId": "task-1"}, ctx)).output)
        assert status["status"] == "running" and status["workState"] == "working" and "next" in status
        assert status["providerInstanceId"] == "codex-acp" and status["summary"] is None
        cancelled = json.loads((await TaskCancelTool(registry).run({"taskId": "task-1"}, ctx)).output)
        assert cancelled == {"taskId": "task-1", "status": "cancel_requested"}
        await item.done
        assert item.status() == "cancelled"
        assert wake_detail("task-1", item) == ("Delegated task task-1 (Review) [cancelled]. Use task_status with taskId "
                                               "task-1 to read the result.")
        with pytest.raises(ToolError, match="Unknown taskId"):
            await TaskStatusTool(registry).run({"taskId": "task-9"}, ctx)

    asyncio.run(main())


def test_delegate_a_task_to_another_agent_and_wait(daemon, project, fake_model, fake_agent):  # noqa: F811
    """As T3 Code: a Harness session gives a task to another agent. The child is a nested session; mode "wait"
    returns its last answer."""
    c = Client(daemon)
    ready = c.new_session(project)
    fake_model.script(
        {"tool_calls": [{"name": "orchestrator_capabilities", "arguments": {}}]},
        {"tool_calls": [{"name": "delegate_task", "arguments": {
            "task": "hello child", "title": "Echo", "mode": "wait", "timeoutMs": 40000,
            "target": {"providerInstanceId": fake_agent.id}}}]},
        {"text": "The child answered."},
    )
    c.send({"type": "prompt", "text": "Ask the fake agent"})
    c.until("turn.end", timeout=60)
    results = [m["content"] for m in fake_model.requests[-1]["messages"] if m["role"] == "tool"]
    caps = json.loads(results[0])
    assert caps["inheritedProviderInstanceId"] == "harness" and caps["inheritedModel"] == "fake/test-model"
    assert [p["providerInstanceId"] for p in caps["providers"]] == ["harness", fake_agent.id]
    done = json.loads(results[1])
    assert done["status"] == "completed" and done["workState"] == "result_available"
    assert done["summary"] == "echo: hello child" and done["providerInstanceId"] == fake_agent.id
    assert done["waitTimedOut"] is False and "next" not in done
    # The child is a nested session of the parent, on the other agent.
    c.send({"type": "session.list"})
    rows = c.until("sessions")[0]["items"]
    child = next(r for r in rows if r["id"] == done["childThreadId"])
    assert child["parent_id"] == ready["session_id"] and child["title"] == "Echo"
    assert child["model"] == fake_agent.id
    c.close()


def test_an_async_child_wakes_the_parent(daemon, project, fake_model, fake_agent):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    fake_model.script(
        {"tool_calls": [{"name": "delegate_task", "arguments": {
            "task": "async child", "title": "Later", "role": "review",
            "target": {"providerInstanceId": fake_agent.id}}}]},
        {"text": "It runs."},
        {"text": "Got the result."},  # The turn that the end of the child starts.
    )
    c.send({"type": "prompt", "text": "Delegate it"})
    c.until("turn.end", timeout=60)
    started = json.loads(next(m for m in fake_model.requests[-1]["messages"] if m["role"] == "tool")["content"])
    assert started["status"] in ("running", "waiting") and started["next"].startswith("Completion wakes this thread")
    woke = c.until("turn.started", timeout=60)[0]
    assert woke["origin"] == "task" and woke["text"].startswith("Delegated task ended: Later")
    c.until("turn.end", timeout=60)
    note = fake_model.requests[-1]["messages"][-1]["content"]
    # The role line of T3 Code comes before the task.
    assert f"Delegated task {started['taskId']} (Later) [completed]:\necho: Act as the review sub-agent" in note
    c.close()
