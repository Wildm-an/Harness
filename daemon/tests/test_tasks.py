"""Background tasks (tasks.py) and the "Keep computer awake" switch (keepawake.py)."""

from __future__ import annotations

import asyncio

from harness_daemon.keepawake import AWAKE, KeepAwake
from harness_daemon.tasks import MAX_KEPT_OUTPUT, BackgroundTask, TaskHost
from harness_daemon.tools.shell import detect_shell

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_the_agent_reads_only_new_output():
    task = BackgroundTask(id="task-1", command="x", description="", started_at=0)
    task.append("one\n")
    assert task.new_output() == "one\n"
    task.append("two\n")
    assert task.new_output() == "two\n"
    assert task.new_output() == ""
    task.append("x" * (MAX_KEPT_OUTPUT + 10))
    assert task.new_output().startswith("[10 earlier characters are not kept.]")


def test_a_task_runs_ends_and_gives_a_note(project):
    async def main() -> None:
        changes: list[int] = []
        host = TaskHost(project, detect_shell(), on_change=lambda: changes.append(1))
        task = host.start("echo harness-task-ok", "Printed a line")
        assert task.status == "running" and host.running == [task]
        await host.wait(task, 20)
        assert task.status == "done" and "harness-task-ok" in task.output
        await asyncio.sleep(0.1)  # The end goes to the loop.
        assert len(changes) == 2  # The start and the end.
        notes = host.take_ended_notes()
        assert len(notes) == 1 and task.id in notes[0] and "exit code 0" in notes[0]
        assert host.take_ended_notes() == []

    asyncio.run(main())


def test_a_task_stops(project):
    async def main() -> None:
        host = TaskHost(project, detect_shell())
        task = host.start("sleep 30" if detect_shell().name != "powershell" else "Start-Sleep 30")
        await host.stop(task.id)
        await host.wait(task, 10)
        assert task.status == "stopped"

    asyncio.run(main())


def test_keep_awake_holds_while_one_session_needs_it(monkeypatch):
    awake = KeepAwake()
    applied: list[bool] = []
    monkeypatch.setattr(awake, "_apply", lambda on: applied.append(on))
    a, b = object(), object()
    awake.hold(a, True)
    awake.hold(b, True)
    awake.hold(a, False)
    awake.hold(b, False)
    assert applied == [True, True, True, False]


def test_the_agent_starts_a_background_task(daemon, project, fake_model, monkeypatch):  # noqa: F811
    held: list[bool] = []
    monkeypatch.setattr(AWAKE, "_apply", lambda on: held.append(on))
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "session.keep_awake", "on": True})
    assert c.until("keep_awake")[0]["on"] is True

    fake_model.script(
        {"tool_calls": [{"name": "bash", "arguments": {"command": "echo bg-task-ok", "run_in_background": True,
                                                       "description": "Printed a line"}}]},
        {"text": "It runs."},
    )
    c.send({"type": "prompt", "text": "Run it in the background"})
    request = c.until("permission.request")[0]
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    c.until("turn.end")
    result = next(m for m in fake_model.requests[-1]["messages"] if m["role"] == "tool")["content"]
    assert "background task task-" in result
    assert True in held  # The computer stayed awake during the turn.

    items = c.until("tasks")[0]["items"]
    task_id = items[0]["id"]
    c.send({"type": "task.get", "id": task_id})
    detail = c.until("task")[0]
    for _ in range(40):
        if detail["status"] != "running":
            break
        c.send({"type": "task.get", "id": task_id})
        detail = c.until("task")[0]
    assert detail["status"] == "done" and "bg-task-ok" in detail["output"]

    # The next prompt tells the agent that the task ended.
    fake_model.script({"text": "It ended."})
    c.send({"type": "prompt", "text": "Is it done?"})
    c.until("turn.end")
    assert f"The background task {task_id}" in fake_model.requests[-1]["messages"][-1]["content"]
    c.close()
