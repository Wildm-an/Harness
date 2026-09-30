"""The tools for background tasks (tasks.py): read the output of a task, and stop a task."""

from __future__ import annotations

from typing import Any

from .base import Tool, ToolContext, ToolError, ToolResult, get_int, truncate

MAX_WAIT = 120  # Seconds.


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
    return f"The task {task.id} ended with exit code {task.returncode}."


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
        return ("Read the new output of a background task that bash started with run_in_background, "
                "and its status. Each call gives only the output after the last call.")

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


def task_tools() -> list[Tool]:
    return [TaskOutputTool(), TaskStopTool()]
