"""The routine tools: the agent saves a routine (routines.py) that shows on the Routines page.

A routine is a prompt that Harness runs on a cron schedule, each time in a new session, also when no
window is open. cron_create (tools/tasks.py) is different: its tasks stay only while the session is open.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from .base import Approval, Tool, ToolContext, ToolError, ToolResult

# The permission modes, from the most limited to the least limited. A routine cannot get a mode that is
# less limited than the mode of the session that makes it.
MODE_ORDER = ("plan", "default", "acceptEdits", "auto", "bypassPermissions")
MODE_NAMES = {"plan": "Plan", "default": "Manual", "acceptEdits": "Accept edits", "auto": "Auto",
              "bypassPermissions": "Bypass permissions"}


def _scheduler() -> Any:
    from ..routines import HUB

    if HUB.scheduler is None:
        raise ToolError("The routine scheduler does not run in this daemon.")
    return HUB.scheduler


def _when(epoch: float | None) -> str:
    return dt.datetime.fromtimestamp(epoch).strftime("%Y-%m-%d %H:%M") if epoch else "none"


def session_mode(ctx: ToolContext) -> str:
    mode = str(ctx.settings.get("permission_mode") or "default")
    return mode if mode in MODE_ORDER else "default"


def routine_mode(requested: Any, session: str) -> str:
    """The mode of a new routine. Default: the mode of the session (Manual for a session in Plan mode, because
    a routine in Plan mode cannot change anything). Raise ToolError for a mode above the session mode."""
    ceiling = "default" if session == "plan" else session
    if requested in (None, ""):
        return ceiling
    if requested not in MODE_ORDER:
        raise ToolError(f"permission_mode must be one of: {', '.join(MODE_ORDER)}.")
    if MODE_ORDER.index(requested) > MODE_ORDER.index(ceiling):
        raise ToolError(f"A routine cannot get a less limited permission mode than this session "
                        f"({MODE_NAMES[session]}). Use {ceiling} or a more limited mode, or tell the user "
                        f"to change the mode of the routine on the Routines page.")
    return str(requested)


def _text(args: dict[str, Any], key: str) -> str:
    value = str(args.get(key) or "").strip()
    if not value:
        raise ToolError(f"Give '{key}'.")
    return value


class RoutineCreateTool(Tool):
    name = "routine_create"
    needs_approval = True
    parameters = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "A short name for the Routines page, for example "
                                                      "'Morning commit summary'."},
            "prompt": {"type": "string", "description": "The full task for each run. A new session runs it with no "
                                                        "memory of this conversation: give the goal, the files or "
                                                        "commands, and what to report."},
            "schedule": {"type": "string", "description": "A cron expression with 5 fields in the local time of the "
                                                          "daemon computer: minute hour day-of-month month "
                                                          "day-of-week. For example '0 9 * * 1-5' (09:00 on weekdays)."},
            "permission_mode": {"type": "string", "enum": list(MODE_ORDER),
                                "description": "The mode of the runs. Default: the mode of this session. It cannot "
                                               "be less limited than the mode of this session."},
            "enabled": {"type": "boolean", "description": "True (default): the routine runs on its schedule. False: "
                                                          "it is saved as Inactive."},
        },
        "required": ["name", "prompt", "schedule"],
    }

    def describe(self, ctx: ToolContext) -> str:
        return ("Save a routine: a prompt that Harness runs on a cron schedule, each time in a new session. Routines "
                "continue after this session ends, also when no Harness window is open. The routine shows on the "
                "Routines page, where the user can edit it, turn it off, or delete it. Use this tool when the user "
                "asks for recurring or later work that must continue after this session, for example \"every "
                "morning, summarize the new commits\" or \"each Friday at 17:00, check the dependencies\". Use "
                "cron_create only for reminders while this session is open. The runs work in the project folder of "
                "this session, with the model of this session. Use routine_list first to find a routine that does "
                "the same work. After the save, tell the user the name, the schedule, and the next run.")

    def _fields(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        from ..cron import CronError, parse_cron

        schedule = " ".join(str(args.get("schedule") or "").split())
        try:
            parse_cron(schedule)
        except CronError as e:
            raise ToolError(str(e)) from None
        model = ctx.model() if callable(ctx.model) else None
        return {"name": _text(args, "name")[:200], "prompt": _text(args, "prompt"), "cwd": str(ctx.cwd),
                "model": model or None, "permission_mode": routine_mode(args.get("permission_mode"), session_mode(ctx)),
                "schedule": schedule, "enabled": args.get("enabled") is not False}

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        _scheduler()
        fields = self._fields(args, ctx)
        shown = {"name": fields["name"], "schedule": fields["schedule"],
                 "permission_mode": MODE_NAMES[fields["permission_mode"]], "folder": fields["cwd"],
                 "model": fields["model"] or "the default model", "active": fields["enabled"],
                 "prompt": fields["prompt"]}
        return Approval(key=fields["name"], rule="routine_create", input=shown)

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        scheduler = _scheduler()
        fields = self._fields(args, ctx)
        try:
            routine_id = scheduler.storage.save_routine(fields)
        except (ValueError, OSError) as e:
            raise ToolError(f"The routine was not saved: {e}") from None
        scheduler.wake()
        await scheduler.send_items()  # The Routines page of each window shows the new routine.
        item = scheduler.item(scheduler.storage.get_routine(routine_id))
        path = scheduler.storage.routines_dir / f"{routine_id}.md"
        state = "Active" if item["enabled"] else "Inactive"
        return ToolResult(f"Saved the routine '{item['name']}' ({state}) in {path}. Schedule: '{item['schedule']}' "
                          f"(local time). Next run: {_when(item['next_fire_at'])}. Mode: "
                          f"{MODE_NAMES[item['permission_mode']]}. The user sees it on the Routines page.")


class RoutineListTool(Tool):
    name = "routine_list"
    description = ("List the saved routines of the Routines page: the id, the name, Active or Inactive, the schedule, "
                   "the next run, the folder, and the last run. Use it before routine_create, and when the user asks "
                   "about the routines.")
    parameters = {"type": "object", "properties": {}}

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        scheduler = _scheduler()
        items = scheduler.items()
        if not items:
            return ToolResult(f"No routines. The folder is {scheduler.storage.routines_dir}.")
        lines = []
        for r in items:
            state = "Active" if r["enabled"] and not r["error"] else "Inactive"
            last = r["last_run"]
            last_text = f"{last['status']} at {_when(last['started_at'])}" if last else "none"
            line = (f"- {r['id']}: {r['name']} ({state}), schedule '{r['schedule']}', next {_when(r['next_fire_at'])}, "
                    f"folder {r['cwd']}, last run {last_text}")
            if r["error"]:
                line += f". File problem: {r['error']}"
            lines.append(line)
        return ToolResult("\n".join(lines))


def routine_tools() -> list[Tool]:
    return [RoutineCreateTool(), RoutineListTool()]
