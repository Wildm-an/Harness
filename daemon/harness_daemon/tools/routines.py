"""The routine tools: the agent saves, lists, changes, and deletes the routines (routines.py) of the Routines page.

A routine is a prompt that Harness runs on a cron schedule, each time in a new session, also when no
window is open. cron_create (tools/tasks.py) is different: its tasks stay only while the session is open.

A routine runs with an agent: the built-in loop of Harness ("harness"), or an ACP agent of Settings > Agents (for
example "claude-acp"). The model is a "provider/model" spec for the built-in loop, else a model id of the agent.
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
BUILTIN = "harness"  # The built-in loop of Harness (acp_harnesses.BUILTIN_ID).


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


# -- the agent of a routine --------------------------------------------------------------------------


def agent_names(ctx: ToolContext) -> str:
    """The agents that a routine can use, for the tool descriptions: "harness (Harness ...), claude-acp (...)"."""
    from .. import acp_harnesses

    names = [f"{BUILTIN} (Harness, the built-in loop)"]
    for harness_id in acp_harnesses.enabled_ids(ctx.settings):
        spec = acp_harnesses.find(harness_id)
        if spec is not None:
            names.append(f"{spec.id} ({spec.name})")
    return ", ".join(names)


def session_agent(ctx: ToolContext) -> tuple[str | None, str | None]:
    """The agent of this session and its model: (None, "provider/model"), or (harness id, model id or None)."""
    if callable(ctx.agent):
        agent, model = ctx.agent()
        return agent, model or None
    model = ctx.model() if callable(ctx.model) else None
    return None, model or None


def _agent_arg(value: Any, ctx: ToolContext) -> str | None:
    """An agent argument: None for the built-in loop, else a known harness id. Raise ToolError for others."""
    from .. import acp_harnesses

    agent = str(value).strip()
    if agent == BUILTIN:
        return None
    if acp_harnesses.find(agent) is None:
        raise ToolError(f"Unknown agent '{agent}'. Use one of: {agent_names(ctx)}.")
    return agent


def _model_arg(value: Any) -> str | None:
    return str(value).strip() or None if isinstance(value, str) else None


def routine_agent(requested: Any, requested_model: Any, ctx: ToolContext) -> tuple[str | None, str | None]:
    """The agent and the model of a new routine. No agent: the agent of this session. No model: the model of this
    session when the agent is the same, else the default model of the agent."""
    own_agent, own_model = session_agent(ctx)
    model = _model_arg(requested_model)
    if requested in (None, ""):
        return own_agent, model or own_model
    agent = _agent_arg(requested, ctx)
    if model is None and agent == own_agent:
        model = own_model
    return agent, model


def agent_label(agent: str | None) -> str:
    from .. import acp_harnesses

    if not agent:
        return "Harness"
    spec = acp_harnesses.find(agent)
    return spec.name if spec else agent


AGENT_TEXT = ("The agent that runs the routine: 'harness' (the built-in loop) or the id of an agent of "
              "Settings > Agents, for example 'claude-acp'.")
MODEL_TEXT = ("The model of the runs. For 'harness': a 'provider/model' spec. For another agent: a model id of that "
              "agent, for example 'opus'.")


# -- the tools ---------------------------------------------------------------------------------------


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
            "agent": {"type": "string", "description": f"{AGENT_TEXT} Default: the agent of this session."},
            "model": {"type": "string", "description": f"{MODEL_TEXT} Default: the model of this session for the "
                                                       "same agent, else the default model of the agent."},
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
                "this session. By default they use the agent and the model of this session. Set 'agent' and "
                f"'model' for another agent. The agents: {agent_names(ctx)}. Use routine_list first to find a "
                "routine that does the same work, and routine_update to change it. After the save, tell the user "
                "the name, the agent, the schedule, and the next run.")

    def _fields(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        from ..cron import CronError, parse_cron

        schedule = " ".join(str(args.get("schedule") or "").split())
        try:
            parse_cron(schedule)
        except CronError as e:
            raise ToolError(str(e)) from None
        agent, model = routine_agent(args.get("agent"), args.get("model"), ctx)
        return {"name": _text(args, "name")[:200], "prompt": _text(args, "prompt"), "cwd": str(ctx.cwd),
                "agent": agent, "model": model,
                "permission_mode": routine_mode(args.get("permission_mode"), session_mode(ctx)),
                "schedule": schedule, "enabled": args.get("enabled") is not False}

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        _scheduler()
        fields = self._fields(args, ctx)
        shown = {"name": fields["name"], "schedule": fields["schedule"],
                 "permission_mode": MODE_NAMES[fields["permission_mode"]], "folder": fields["cwd"],
                 "agent": agent_label(fields["agent"]), "model": fields["model"] or "the default model",
                 "active": fields["enabled"], "prompt": fields["prompt"]}
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
        return ToolResult(f"Saved the routine '{item['name']}' (id {routine_id}, {state}) in {path}. Agent: "
                          f"{agent_label(item.get('agent'))}, model: {item.get('model') or 'the default model'}. "
                          f"Schedule: '{item['schedule']}' (local time). Next run: {_when(item['next_fire_at'])}. "
                          f"Mode: {MODE_NAMES[item['permission_mode']]}. The user sees it on the Routines page.")


class RoutineListTool(Tool):
    name = "routine_list"
    description = ("List the saved routines of the Routines page: the id, the name, Active or Inactive, the agent, "
                   "the model, the mode, the schedule, the next run, the folder, and the last run. Use it before "
                   "routine_create, routine_update, and routine_delete, and when the user asks about the routines.")
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
            line = (f"- {r['id']}: {r['name']} ({state}), agent {agent_label(r.get('agent'))}, model "
                    f"{r.get('model') or 'default'}, mode {r['permission_mode']}, schedule '{r['schedule']}', next "
                    f"{_when(r['next_fire_at'])}, folder {r['cwd']}, last run {last_text}")
            if r["error"]:
                line += f". File problem: {r['error']}"
            lines.append(line)
        return ToolResult("\n".join(lines))


def _routine(scheduler: Any, args: dict[str, Any]) -> dict[str, Any]:
    routine_id = _text(args, "id")
    routine = scheduler.storage.get_routine(routine_id)
    if routine is None:
        raise ToolError(f"Unknown routine '{routine_id}'. Use routine_list to find the id.")
    return routine


class RoutineUpdateTool(Tool):
    name = "routine_update"
    needs_approval = True
    parameters = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "The id of the routine, from routine_list."},
            "name": {"type": "string", "description": "A new name."},
            "prompt": {"type": "string", "description": "A new full prompt. It replaces the old prompt."},
            "schedule": {"type": "string", "description": "A new cron expression with 5 fields, in local time."},
            "agent": {"type": "string", "description": f"A new agent. {AGENT_TEXT} A new agent with no 'model' gets "
                                                       "the default model of that agent."},
            "model": {"type": "string", "description": f"A new model. {MODEL_TEXT} An empty text: the default model."},
            "permission_mode": {"type": "string", "enum": list(MODE_ORDER),
                                "description": "A new mode. It cannot be less limited than the mode of this session."},
            "enabled": {"type": "boolean", "description": "True: Active, the routine runs on its schedule. False: "
                                                          "Inactive."},
        },
        "required": ["id"],
    }

    def describe(self, ctx: ToolContext) -> str:
        return ("Change a saved routine of the Routines page. Give the id (routine_list) and only the fields to "
                "change. The other fields stay. Use it when the user asks to change the prompt, the schedule, the "
                f"agent, the model, or the mode of a routine, or to turn it on or off. The agents: {agent_names(ctx)}. "
                "After the change, tell the user what changed and the next run.")

    @staticmethod
    def _changes(args: dict[str, Any], ctx: ToolContext, routine: dict[str, Any]) -> dict[str, Any]:
        from ..cron import CronError, parse_cron

        changes: dict[str, Any] = {}
        if args.get("name") is not None:
            changes["name"] = _text(args, "name")[:200]
        if args.get("prompt") is not None:
            changes["prompt"] = _text(args, "prompt")
        if args.get("schedule") is not None:
            schedule = " ".join(str(args["schedule"]).split())
            try:
                parse_cron(schedule)
            except CronError as e:
                raise ToolError(str(e)) from None
            changes["schedule"] = schedule
        if args.get("agent") not in (None, ""):
            agent = _agent_arg(args["agent"], ctx)
            changes["agent"] = agent
            if agent != routine.get("agent"):
                changes["model"] = None  # The old model is a model of the old agent.
        if args.get("model") is not None:
            changes["model"] = _model_arg(args["model"])
        if args.get("permission_mode") not in (None, ""):
            changes["permission_mode"] = routine_mode(args["permission_mode"], session_mode(ctx))
        if isinstance(args.get("enabled"), bool):
            changes["enabled"] = args["enabled"]
        if not changes:
            raise ToolError("Give at least one field to change.")
        return changes

    @staticmethod
    def _shown(changes: dict[str, Any]) -> dict[str, Any]:
        shown = dict(changes)
        if "agent" in shown:
            shown["agent"] = agent_label(shown["agent"])
        if "model" in shown:
            shown["model"] = shown["model"] or "the default model"
        if "permission_mode" in shown:
            shown["permission_mode"] = MODE_NAMES[shown["permission_mode"]]
        if "enabled" in shown:
            shown["active"] = shown.pop("enabled")
        return shown

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        routine = _routine(_scheduler(), args)
        changes = self._changes(args, ctx, routine)
        return Approval(key=routine["id"], rule="routine_update",
                        input={"routine": routine["name"], "id": routine["id"], **self._shown(changes)})

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        scheduler = _scheduler()
        routine = _routine(scheduler, args)
        changes = self._changes(args, ctx, routine)
        try:
            scheduler.storage.save_routine(changes, routine["id"])
        except (ValueError, OSError) as e:
            raise ToolError(f"The routine was not changed: {e}") from None
        scheduler.wake()
        await scheduler.send_items(routine["id"])
        item = scheduler.item(scheduler.storage.get_routine(routine["id"]))
        state = "Active" if item["enabled"] else "Inactive"
        changed = [f"{k} {v}" for k, v in self._shown(changes).items() if k != "prompt"]
        if "prompt" in changes:
            changed.append("the prompt")
        return ToolResult(f"Changed the routine '{item['name']}' ({state}): {', '.join(changed)}. Agent: "
                          f"{agent_label(item.get('agent'))}, model: {item.get('model') or 'the default model'}. "
                          f"Schedule: '{item['schedule']}'. Next run: {_when(item['next_fire_at'])}.")


class RoutineDeleteTool(Tool):
    name = "routine_delete"
    needs_approval = True
    description = ("Delete a saved routine and its run history. The sessions of earlier runs stay. On Windows the "
                   "file goes to the Recycle Bin. Use it only when the user asks to delete a routine. To stop a "
                   "routine for a time, use routine_update with enabled false.")
    parameters = {
        "type": "object",
        "properties": {"id": {"type": "string", "description": "The id of the routine, from routine_list."}},
        "required": ["id"],
    }

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        routine = _routine(_scheduler(), args)
        return Approval(key=routine["id"], rule="routine_delete",
                        input={"routine": routine["name"], "id": routine["id"], "schedule": routine["schedule"]})

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        scheduler = _scheduler()
        routine = _routine(scheduler, args)
        try:
            scheduler.storage.delete_routine(routine["id"])
        except (ValueError, OSError) as e:
            raise ToolError(f"The routine was not deleted: {e}") from None
        scheduler.wake()
        await scheduler.send_items()
        return ToolResult(f"Deleted the routine '{routine['name']}' ({routine['id']}).")


def routine_tools() -> list[Tool]:
    return [RoutineCreateTool(), RoutineListTool(), RoutineUpdateTool(), RoutineDeleteTool()]
