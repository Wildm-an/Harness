"""Background tasks (tasks.py) and the "Keep computer awake" switch (keepawake.py)."""

from __future__ import annotations

import asyncio
import time

import pytest

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


@pytest.mark.skipif(detect_shell().name not in ("bash", "sh"), reason="the command needs a POSIX shell")
def test_a_stopped_task_ends_when_its_shell_ends(project):
    # The subshell starts sleep and ends at once: sleep is no longer in the process tree of the shell,
    # and it keeps the output pipe open. On a CI runner, a child that started at the moment of the
    # kill did the same. The task must still end when the shell ends.
    async def main() -> None:
        host = TaskHost(project, detect_shell())
        task = host.start("(sleep 5 &); sleep 5")
        await asyncio.sleep(0.5)
        await host.stop(task.id)
        await host.wait(task, 3)
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
        {"text": "It ended."},  # The turn that the end of the task starts.
    )
    c.send({"type": "prompt", "text": "Run it in the background"})
    request = c.until("permission.request")[0]
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    _, seen = c.until("turn.end")
    result = next(m for m in fake_model.requests[-1]["messages"] if m["role"] == "tool")["content"]
    assert "background task task-" in result
    assert True in held  # The computer stayed awake during the turn.

    # The task list can come before or after the end of the turn: a fast computer ends the task first.
    early = [m for m in seen if m["type"] == "tasks" and m["items"]]
    items = early[-1]["items"] if early else c.until("tasks")[0]["items"]
    task_id = items[0]["id"]
    c.send({"type": "task.get", "id": task_id})
    detail = c.until("task")[0]
    for _ in range(40):  # Up to 10 seconds.
        if detail["status"] != "running":
            break
        time.sleep(0.25)
        c.send({"type": "task.get", "id": task_id})
        detail = c.until("task")[0]
    assert detail["status"] == "done" and "bg-task-ok" in detail["output"]

    # The end of the task starts a turn, as in Claude Code. The user sent no prompt.
    started = c.until("turn.started")[0]
    assert started["origin"] == "task" and started["text"] == "Background task ended: Printed a line"
    c.until("turn.end")
    note = fake_model.requests[-1]["messages"][-1]["content"]
    assert f"The background task {task_id}" in note and "<task-notification>" in note
    c.close()


def test_notes_of_monitors_agents_and_wakeups(project):
    async def main() -> None:
        notified: list[int] = []
        host = TaskHost(project, detect_shell(), on_notify=lambda: notified.append(1))
        monitor = host.start("echo first-line && echo second-line", "Watched two lines", kind="monitor")
        await host.wait(monitor, 20)
        await asyncio.sleep(0.1)
        assert notified
        texts = [text for text, _ in host.take_notes()]
        assert "first-line" in texts[0] and "second-line" in texts[0]
        assert any("The monitor" in t and "ended with exit code 0" in t for t in texts)

        async def report(task: BackgroundTask) -> int:
            task.result = "Found 3 files."
            return 0

        agent = host.start_job("agent", "Count the files", "Count files", report)
        await host.wait(agent, 5)
        (text, short), = host.take_notes()
        assert "finished" in text and "Found 3 files." in text and short == "Background agent finished: Count files"

        async def tick(_task: BackgroundTask) -> int:
            await asyncio.sleep(0.05)
            return 0

        wakeup = host.start_job("wakeup", "Check the CI run.", "Check CI", tick)
        await host.wait(wakeup, 5)
        (text, short), = host.take_notes()
        assert "Check the CI run." in text and short == "Scheduled wakeup: Check CI"

        # A stopped wakeup gives no note.
        late = host.start_job("wakeup", "Never", "Later", tick)
        await host.stop(late.id)
        assert late.status == "stopped" and host.take_notes() == []

    asyncio.run(main())


def test_a_background_agent_reports_in_a_new_turn(daemon, harness_home, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    fake_model.script(
        {"tool_calls": [{"name": "agent", "arguments": {"prompt": "Count the files", "description": "Count files",
                                                        "run_in_background": True}}]},
        {"text": "It runs."},
        {"when": "Count the files", "text": "There are 3 files."},  # The subagent.
        {"text": "The agent found 3 files."},  # The turn that the report starts.
    )
    c.send({"type": "prompt", "text": "Start a helper"})
    c.until("turn.end")
    started = c.until("turn.started")[0]
    assert started["text"] == "Background agent finished: Count files"
    c.until("turn.end")
    note = fake_model.requests[-1]["messages"][-1]["content"]
    assert "There are 3 files." in note
    # The subagent does not get the agent tool: it cannot start subagents.
    sub = next(r for r in fake_model.requests if "Count the files" in str(r["messages"][1].get("content")))
    assert "agent" not in [t["function"]["name"] for t in sub.get("tools") or []]

    # The "subagents" setting off removes the agent tool at once.
    c.send({"type": "user_settings.set", "values": {"subagents": False}})
    assert c.until("user_settings")[0]["values"]["subagents"] is False
    fake_model.script({"text": "No helpers."})
    c.send({"type": "prompt", "text": "Any helpers?"})
    c.until("turn.end")
    assert "agent" not in [t["function"]["name"] for t in fake_model.requests[-1].get("tools") or []]
    c.close()
