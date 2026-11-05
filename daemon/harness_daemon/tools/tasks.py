"""The tools for background tasks (tasks.py): read the output of a task, stop a task, watch a
command (monitor), start a subagent (agent), and start a turn later (schedule_wakeup)."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from .base import Approval, Tool, ToolContext, ToolError, ToolResult, get_int, truncate

MAX_WAIT = 120  # Seconds.
MONITOR_DEFAULT = 600  # Seconds.
MONITOR_MAX = 3600
WAKEUP_MIN = 60  # Seconds.
WAKEUP_MAX = 3600

# Runs a subagent: (prompt, description, background). Returns the report, or the task id in the background.
# (prompt, description, background, agent type) -> the report, or the task id in the background.
RunSubagent = Callable[[str, str, bool, str], Awaitable[str]]


def _host(ctx: ToolContext) -> Any:
    if ctx.tasks is None:
        raise ToolError("Background tasks are not available here.")
    return ctx.tasks


def _task(args: dict[str, Any], ctx: ToolContext) -> Any:
    from ..tasks import TaskError

    task_id = args.get("id")
    if not isinstance(task_id, str) or not task_id.strip():
        raise ToolError("id is empty.")
    try:
        return _host(ctx).get(task_id.strip())
    except TaskError as e:
        raise ToolError(str(e)) from e


def _status(task: Any) -> str:
    if task.status == "running":
        return f"The task {task.id} still runs."
    if task.status == "stopped":
        return f"The task {task.id} was stopped."
    if task.kind in ("agent", "wakeup"):
        return f"The task {task.id} is done." if task.returncode == 0 else f"The task {task.id} failed."
    return f"The task {task.id} ended with exit code {task.returncode}."


def _text(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ToolError(f"{key} is empty.")
    return value.strip()


def _description(args: dict[str, Any]) -> str:
    value = args.get("description")
    return value.strip() if isinstance(value, str) else ""


class TaskOutputTool(Tool):
    name = "task_output"
    parameters = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "The id of the background task, for example task-1a2b3c."},
            "wait": {"type": "integer", "description": f"Wait at most this many seconds for the task to end (0 to {MAX_WAIT}). Optional."},
        },
        "required": ["id"],
    }

    def describe(self, ctx: ToolContext) -> str:
        return ("Read the new output of a background task (a bash command with run_in_background, a "
                "monitor, a background agent, or a wakeup), and its status. Each call gives only the "
                "output after the last call.")

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        task = _task(args, ctx)
        wait = min(max(get_int(args, "wait", 0), 0), MAX_WAIT)
        if wait:
            await _host(ctx).wait(task, wait)
        if task.ended_at is not None:
            task.noted = True  # The agent knows now: the next prompt does not tell it again.
        output = truncate(task.new_output().rstrip("\n"), ctx.settings["max_output_chars"], keep_tail=True)
        return ToolResult(f"{output or '(no new output)'}\n[{_status(task)}]")


class TaskStopTool(Tool):
    name = "task_stop"
    parameters = {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "The id of the background task."}},
        "required": ["id"],
    }

    def describe(self, ctx: ToolContext) -> str:
        return "Stop a background task and all its child processes."

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        task = _task(args, ctx)
        if task.ended_at is not None:
            return ToolResult(f"[{_status(task)}]")
        task.noted = True
        await _host(ctx).stop(task.id)
        return ToolResult(f"[The task {task.id} is stopped.]")


class MonitorTool(Tool):
    name = "monitor"
    parameters = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The command to watch, for example a log tail or a test watcher."},
            "description": {"type": "string", "description": "What the monitor watches, in 3 to 8 words, for the user."},
            "timeout": {"type": "integer", "description": f"Stop the monitor after this many seconds "
                                                          f"(10 to {MONITOR_MAX}). Default: {MONITOR_DEFAULT}. Optional."},
        },
        "required": ["command", "description"],
    }
    needs_approval = True

    def describe(self, ctx: ToolContext) -> str:
        return ("Run a command in the background and watch its output. Each new output line comes to you "
                "as a notification, also when no turn runs. Use it to wait for an event, for example a "
                "line in a log or the end of a deploy. Make the command print only the lines that you "
                "need (for example with grep). Stop it with task_stop when you do not need it.")

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        command = _text(args, "command")
        # The bash rules apply: the monitor runs a shell command.
        return Approval(key=command, rule=f"bash({command})", tool="bash")

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from ..tasks import TaskError

        command = _text(args, "command")
        timeout = min(max(get_int(args, "timeout", MONITOR_DEFAULT), 10), MONITOR_MAX)
        try:
            task = _host(ctx).start(command, _description(args), kind="monitor", timeout=timeout)
        except TaskError as e:
            raise ToolError(str(e)) from e
        return ToolResult(f"The monitor {task.id} runs for at most {timeout} seconds. Each new output line "
                          f"comes to you as a notification. Stop it with task_stop.")


class ScheduleWakeupTool(Tool):
    name = "schedule_wakeup"
    parameters = {
        "type": "object",
        "properties": {
            "delay_seconds": {"type": "integer", "description": f"The time to wait, in seconds ({WAKEUP_MIN} to {WAKEUP_MAX})."},
            "prompt": {"type": "string", "description": "The message that you get when the time ends."},
            "reason": {"type": "string", "description": "Why you wait, in 3 to 8 words, for the user."},
        },
        "required": ["delay_seconds", "prompt", "reason"],
    }

    def describe(self, ctx: ToolContext) -> str:
        return ("Start a new turn later: when the time ends, you get the prompt as a notification. Use it "
                "to check a state that changes slowly and that no tool can tell you about, for example a "
                "CI run or a deploy. Do not use it to wait for a background task or a monitor: they "
                "notify you when they end.")

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from ..tasks import TaskError

        prompt = _text(args, "prompt")
        delay = min(max(get_int(args, "delay_seconds", WAKEUP_MIN), WAKEUP_MIN), WAKEUP_MAX)
        reason = _text(args, "reason")

        async def job(_task: Any) -> int:
            await asyncio.sleep(delay)
            return 0

        try:
            task = _host(ctx).start_job("wakeup", prompt, reason, job, wake_at=time.time() + delay)
        except TaskError as e:
            raise ToolError(str(e)) from e
        return ToolResult(f"The wakeup {task.id} is set for {delay} seconds from now. Stop it with task_stop.")


CRON_MAX_AGE = 7 * 24 * 3600  # A recurring task ends after 7 days, as in Claude Code.


class CronCreateTool(Tool):
    name = "cron_create"
    parameters = {
        "type": "object",
        "properties": {
            "cron": {"type": "string", "description": "5 fields in local time: minute hour day-of-month month "
                                                      "day-of-week, for example '*/10 * * * *' or '0 9 * * 1-5'."},
            "prompt": {"type": "string", "description": "The message that you get at each time."},
            "recurring": {"type": "boolean", "description": "True (default): at each time, for 7 days. False: one time only."},
            "description": {"type": "string", "description": "The task in 3 to 8 words, for the user."},
        },
        "required": ["cron", "prompt"],
    }

    def describe(self, ctx: ToolContext) -> str:
        return ("Schedule a prompt with a cron expression: at each time, you get the prompt as a notification, "
                "in the running turn or in a new turn. Use it when the user asks for work at set times, for "
                "example \"check the deploy every 10 minutes\" or \"run the report at 9:00 on weekdays\". A "
                "recurring task ends after 7 days. Use schedule_wakeup for one check after a delay. The tasks "
                "stay only while the session is open. List them with cron_list and stop one with cron_delete. "
                "For work that must continue after this session, use routine_create.")

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> None:
        from ..cron import CronError, parse_cron

        try:
            parse_cron(str(args.get("cron") or ""))
        except CronError as e:
            raise ToolError(str(e)) from None
        _text(args, "prompt")
        return None

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        import datetime as dt

        from ..cron import parse_cron
        from ..tasks import TaskError

        cron = parse_cron(str(args.get("cron")))
        prompt = _text(args, "prompt")
        recurring = args.get("recurring") is not False
        description = str(args.get("description") or "").strip() or prompt.splitlines()[0][:60]
        host = _host(ctx)
        first = cron.next_after(dt.datetime.now())
        assert first is not None

        async def job(task: Any) -> int:
            at = first
            while at is not None:
                if recurring and at.timestamp() > task.started_at + CRON_MAX_AGE:
                    task.append("The task ended after 7 days.\n")
                    return 0
                task.wake_at = at.timestamp()
                host._changed()
                await asyncio.sleep(max(0.0, at.timestamp() - time.time()))
                when = at.strftime("%Y-%m-%d %H:%M")
                task.append(f"{when}: the prompt went to the agent.\n")
                host.fire(task, when)
                if not recurring:
                    return 0
                at = cron.next_after(at)
            return 1

        try:
            task = host.start_job("cron", prompt, description, job, wake_at=first.timestamp())
        except TaskError as e:
            raise ToolError(str(e)) from e
        task.schedule, task.recurring = cron.text, recurring
        how = "at each time of the schedule, for 7 days" if recurring else "one time"
        return ToolResult(f"The scheduled task {task.id} runs {how}. The first time is "
                          f"{first.strftime('%Y-%m-%d %H:%M')} (local time). Stop it with cron_delete.")


class CronListTool(Tool):
    name = "cron_list"
    description = "List the scheduled tasks of this session (cron_create): the id, the schedule, the next time, and the prompt."
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        import datetime as dt

        tasks = [t for t in _host(ctx).tasks.values() if t.kind == "cron" and t.ended_at is None]
        if not tasks:
            return ToolResult("No scheduled tasks.")
        lines = []
        for t in tasks:
            next_time = dt.datetime.fromtimestamp(t.wake_at).strftime("%Y-%m-%d %H:%M") if t.wake_at else "?"
            lines.append(f"- {t.id}: '{t.schedule}' ({'recurring' if t.recurring else 'one time'}), next {next_time}: {t.label}")
        return ToolResult("\n".join(lines))


class CronDeleteTool(Tool):
    name = "cron_delete"
    description = "Stop a scheduled task of cron_create, with its id."
    parameters = {"type": "object", "properties": {"id": {"type": "string", "description": "The task id."}},
                  "required": ["id"]}

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from ..tasks import TaskError

        host = _host(ctx)
        task_id = _text(args, "id")
        task = host.tasks.get(task_id)
        if task is None or task.kind != "cron":
            raise ToolError(f"No scheduled task with the id {task_id}. Use cron_list.")
        try:
            await host.stop(task_id)
        except TaskError as e:
            raise ToolError(str(e)) from e
        return ToolResult(f"The scheduled task {task_id} is stopped.")


class AgentTool(Tool):
    name = "agent"
    parameters = {
        "type": "object",
        "properties": {
            "prompt": {"type": "string", "description": "The full task for the subagent. It does not see this conversation."},
            "description": {"type": "string", "description": "The task in 3 to 5 words, for the user."},
            "run_in_background": {"type": "boolean", "description": "Return at once. The report comes to you as a "
                                                                    "notification when the subagent ends. Optional."},
            "subagent_type": {"type": "string", "description": "The agent type. Default: general-purpose."},
        },
        "required": ["prompt", "description"],
    }

    def __init__(self, run: RunSubagent):
        self.run_subagent = run

    def describe(self, ctx: ToolContext) -> str:
        from ..agents import discover_agents

        types = "\n".join(f"- {a.name}: {a.description}" for a in discover_agents(ctx.cwd).values())
        return ("Give a task to a subagent with a new context. It returns a report. Use it for a search or a "
                "review of many files, or for independent work. With run_in_background, you can continue your "
                "work while the subagent runs. Do not do the same work at the same time. Several agents in one "
                "step run at the same time. Select the agent type with subagent_type:\n" + types)

    def schema(self, ctx: ToolContext) -> dict[str, Any]:
        from ..agents import discover_agents

        schema = super().schema(ctx)
        props = dict(schema["function"]["parameters"]["properties"])
        props["subagent_type"] = {**props["subagent_type"], "enum": list(discover_agents(ctx.cwd))}
        schema["function"]["parameters"] = {**schema["function"]["parameters"], "properties": props}
        return schema

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from ..providers import ModelError

        prompt = _text(args, "prompt")
        description = _description(args)
        background = args.get("run_in_background") is True
        kind = str(args.get("subagent_type") or "").strip() or "general-purpose"
        try:
            result = await self.run_subagent(prompt, description, background, kind)
        except ModelError as e:
            raise ToolError(str(e)) from e
        if background:
            return ToolResult(f"The subagent runs as the background task {result}. Its report comes to you as "
                              f"a notification. Do not wait for it: continue with other work, or end the turn.")
        return ToolResult(f"The report of the subagent:\n\n{result}")


def task_tools(run_subagent: RunSubagent | None = None) -> list[Tool]:
    tools: list[Tool] = [TaskOutputTool(), TaskStopTool(), MonitorTool(), ScheduleWakeupTool(),
                         CronCreateTool(), CronListTool(), CronDeleteTool()]
    if run_subagent is not None:
        tools.append(AgentTool(run_subagent))
    return tools
