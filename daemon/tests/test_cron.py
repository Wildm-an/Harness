"""Recurring tasks: cron expressions (cron.py) and the cron tools (tools/tasks.py)."""

from __future__ import annotations

import asyncio
import datetime as dt

import pytest

from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.cron import CronError, parse_cron
from harness_daemon.tasks import TaskHost
from harness_daemon.tools import ToolContext, ToolError
from harness_daemon.tools import tasks as task_tools
from harness_daemon.tools.shell import detect_shell
from harness_daemon.tools.tasks import CronCreateTool, CronDeleteTool, CronListTool


def at(text: str) -> dt.datetime:
    return dt.datetime.fromisoformat(text)


def test_cron_expressions_give_the_next_time():
    assert parse_cron("*/15 * * * *").next_after(at("2026-11-04 10:07")) == at("2026-11-04 10:15")
    assert parse_cron("0 9 * * 1-5").next_after(at("2026-11-06 09:00")) == at("2026-11-09 09:00")  # Friday -> Monday.
    assert parse_cron("30 8 1 * *").next_after(at("2026-11-04 00:00")) == at("2026-12-01 08:30")
    assert parse_cron("0 0 * * 7").next_after(at("2026-11-04 00:00")) == at("2026-11-08 00:00")  # 7 is Sunday.
    # Both day fields: a day that matches one of them matches.
    assert parse_cron("0 12 15 * 1").next_after(at("2026-11-10 13:00")) == at("2026-11-15 12:00")
    assert parse_cron("5,35 1-2 * * *").next_after(at("2026-11-04 01:35")) == at("2026-11-04 02:05")
    assert parse_cron("0 0 29 2 *").next_after(at("2026-03-01 00:00")) == at("2028-02-29 00:00")


@pytest.mark.parametrize("bad", ["", "* * * *", "61 * * * *", "* 24 * * *", "*/0 * * * *", "a * * * *",
                                 "5-1 * * * *", "0 0 31 2 *"])
def test_bad_cron_expressions(bad):
    with pytest.raises(CronError):
        parse_cron(bad)


def test_a_scheduled_task_fires_its_prompt_and_can_be_stopped(project, monkeypatch):
    async def main() -> None:
        notified: list[int] = []
        host = TaskHost(project, detect_shell(), on_notify=lambda: notified.append(1))
        ctx = ToolContext(cwd=project, settings=dict(DEFAULT_SETTINGS), shell=detect_shell(), tasks=host)
        # The next time is in 0.2 seconds: the test does not wait a minute.
        soon = dt.datetime.now() + dt.timedelta(seconds=0.2)
        real = parse_cron("* * * * *")

        class Fast:
            text = real.text
            calls = 0

            def next_after(self, after):
                Fast.calls += 1
                return soon if Fast.calls <= 2 else soon + dt.timedelta(seconds=0.3 * Fast.calls)

        monkeypatch.setattr("harness_daemon.cron.parse_cron", lambda text: Fast())
        tool = CronCreateTool()
        out = (await tool.run({"cron": "* * * * *", "prompt": "Check the deploy.", "description": "Check deploy"}, ctx)).output
        assert "runs at each time of the schedule" in out
        task = next(t for t in host.tasks.values() if t.kind == "cron")
        assert (task.schedule, task.recurring, task.status) == ("* * * * *", True, "running")
        listed = (await CronListTool().run({}, ctx)).output
        assert task.id in listed and "recurring" in listed and "Check deploy" in listed
        await asyncio.sleep(0.5)
        notes = host.take_notes()
        assert notified and len(notes) == 1 and "Its prompt:\nCheck the deploy." in notes[0][0]
        assert notes[0][1] == "Scheduled task: Check deploy"
        assert "went to the agent" in task.output
        assert (await CronDeleteTool().run({"id": task.id}, ctx)).output.endswith("is stopped.")
        assert task.status == "stopped" and host.take_notes() == []  # A stopped task gives no note.
        with pytest.raises(ToolError):
            await CronDeleteTool().run({"id": "task-none"}, ctx)

    asyncio.run(main())


def test_a_one_time_task_ends_after_it_fires(project, monkeypatch):
    async def main() -> None:
        host = TaskHost(project, detect_shell())
        ctx = ToolContext(cwd=project, settings=dict(DEFAULT_SETTINGS), shell=detect_shell(), tasks=host)
        soon = dt.datetime.now() + dt.timedelta(seconds=0.1)

        class Once:
            text = "0 9 * * *"

            def next_after(self, after):
                return soon

        monkeypatch.setattr("harness_daemon.cron.parse_cron", lambda text: Once())
        await CronCreateTool().run({"cron": "0 9 * * *", "prompt": "Send the report.", "recurring": False}, ctx)
        await asyncio.sleep(0.4)
        task = next(t for t in host.tasks.values() if t.kind == "cron")
        assert task.status == "done"
        notes = host.take_notes()
        assert len(notes) == 1 and "Send the report." in notes[0][0]  # The fire note only, no end note.

    asyncio.run(main())


def test_the_create_tool_checks_the_expression(project):
    ctx = ToolContext(cwd=project, settings=dict(DEFAULT_SETTINGS), shell=detect_shell(), tasks=TaskHost(project, detect_shell()))
    with pytest.raises(ToolError, match="5 fields"):
        asyncio.run(CronCreateTool().prepare({"cron": "every day", "prompt": "x"}, ctx))
    assert task_tools.CRON_MAX_AGE == 7 * 24 * 3600
