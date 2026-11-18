"""The orchestrator tools of T3 Code: orchestrator_capabilities, delegate_task, task_status, and task_cancel.

The tool names, the descriptions, and the input and result fields come from T3 Code (MIT License, Copyright (c) 2026
T3 Tools Inc., THIRD_PARTY_LICENSES.md): apps/server/src/mcp/toolkits/orchestrator/tools.ts and
packages/contracts/src/orchestratorMcp.ts. Harness runs them with its own parts:

- A provider instance is an agent: "harness" (the built-in loop with the models of the Harness providers) or an ACP
  agent of Settings > Agents, for example "codex-acp".
- A child is a nested session with no window (server.py, start_delegate). The sidebar shows it under this session.
  It gets only the task text, not the history of this session.
- A child runs as a background task of this session (tasks.py). When it ends, a note wakes this session with
  "Delegated task <id> (<title>) [<status>]:" and the result, as the completion wake of T3 Code.
- Mode "wait" waits at most 45 s (default 30 s). A timeout does not cancel the child: its end wakes this session.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .base import Tool, ToolContext, ToolError, ToolResult
from .routines import BUILTIN, MODE_ORDER, agent_label, routine_mode, session_agent, session_mode

TITLE_CHARS = 80
MAX_TASK_CHARS = 120_000
CAPABILITY_TIMEOUT = 15.0  # Seconds for the model lists of the Harness providers.
SHORT_LIST = 12  # The models of each provider in the short list of orchestrator_capabilities.
SEARCH_CAP = 40
WAIT_DEFAULT_MS = 30_000
WAIT_MAX_MS = 45_000
RESULT_INLINE_BYTES = 16_000  # As DELEGATED_RESULT_INLINE_BYTES of T3 Code.
ROLES = ("implementation", "research", "review", "design", "test", "general")
RUNNING_TASK_NEXT = ("Completion wakes this thread. Do not wait on it or poll it. Continue other work, and end your "
                     "turn when none is left.")

# start(title, task, agent, model, effort, worktree, mode) -> Delegation. The session gives it (session.py).
StartFn = Callable[..., Awaitable["Delegation"]]


@dataclass
class Delegation:
    """A child agent that runs a delegated task. ``wait`` ends with (stop reason, result text)."""

    session_id: str
    title: str
    agent: str | None  # None: Harness.
    model: str | None
    folder: str
    wait: Callable[[], Awaitable[tuple[str, str]]]
    cancel: Callable[[], Awaitable[None]]
    pending: Callable[[], dict[str, Any] | None]  # The oldest permission request of the child, or None.
    effort: str | None = None
    started_at: float = field(default_factory=time.time)
    task_id: str | None = None
    done: asyncio.Future | None = None
    cancelled: bool = False

    def status(self) -> str:
        """The status of T3 Code: running, waiting, completed, failed, cancelled, interrupted."""
        if self.done is None or not self.done.done():
            return "waiting" if self.pending() else "running"
        if self.cancelled:
            return "cancelled"
        if self.done.cancelled() or self.done.exception() is not None:
            return "failed"
        stop = self.done.result()[0]
        return "completed" if stop == "end" else "interrupted" if stop == "interrupted" else "failed"

    def summary(self) -> str | None:
        if self.done is None or not self.done.done() or self.done.cancelled() or self.done.exception() is not None:
            return None
        return self.done.result()[1] or None


def _json(value: dict[str, Any]) -> ToolResult:
    return ToolResult(json.dumps(value, ensure_ascii=False, indent=1))


def _instance(agent: str | None) -> str:
    return agent or BUILTIN


def _options(effort: str | None) -> list[dict[str, str]]:
    return [{"id": "effort", "value": effort}] if effort else []


class Registry:
    """The delegated tasks of one agent, by taskId."""

    def __init__(self) -> None:
        self.items: dict[str, Delegation] = {}

    def find(self, args: dict[str, Any]) -> tuple[str, Delegation]:
        task_id = str(args.get("taskId") or "").strip()
        if not task_id:
            raise ToolError("Give 'taskId'.")
        item = self.items.get(task_id)
        if item is None:
            raise ToolError(f"Unknown taskId '{task_id}'. Use the taskId that delegate_task gave.")
        return task_id, item


def result_of(task_id: str, item: Delegation, wait_timed_out: bool = False) -> dict[str, Any]:
    """The result fields of delegate_task and task_status (OrchestratorMcpDelegateTaskResult of T3 Code)."""
    status = item.status()
    pending = item.pending() if status in ("running", "waiting") else None
    out: dict[str, Any] = {
        "taskId": task_id, "childThreadId": item.session_id, "link": f"session {item.session_id[:8]} ({item.title})",
        "status": status, "workState": "result_available" if item.done is not None and item.done.done() else "working",
        "providerInstanceId": _instance(item.agent), "model": item.model, "options": _options(item.effort),
        "summary": item.summary(), "hasPendingQuestion": False,
        "pendingApproval": pending, "waitTimedOut": wait_timed_out,
    }
    if status in ("running", "waiting"):
        out["next"] = RUNNING_TASK_NEXT
    return out


def wake_detail(task_id: str, item: Delegation) -> str:
    """The note that wakes the parent when a child ends (delegatedCompletionWakeDetail of T3 Code)."""
    label = f"Delegated task {task_id} ({item.title}) [{item.status()}]"
    result = item.summary()
    if result is not None:
        detail = f"{label}:\n{result}"
        if len(detail.encode("utf-8")) <= RESULT_INLINE_BYTES:
            return detail
    return f"{label}. Use task_status with taskId {task_id} to read the result."


# -- the target ----------------------------------------------------------------------------------------


def _effort(options: Any) -> str | None:
    """options.effort, as a record ({effort: 'max'}) or as selections ([{id: 'effort', value: 'max'}])."""
    if isinstance(options, dict):
        value = options.get("effort")
    elif isinstance(options, list):
        value = next((o.get("value") for o in options if isinstance(o, dict) and o.get("id") == "effort"), None)
    else:
        value = None
    return str(value).strip() or None if value is not None else None


def resolve_target(args: dict[str, Any], ctx: ToolContext) -> tuple[str | None, str | None, str | None]:
    """The agent, the model, and the reasoning level of the child (resolveTarget of T3 Code). With no target: the agent
    and the model of this session. A child of the same agent with no model gets the model of this session. A child of
    another agent with no model gets the default model of that agent."""
    from .. import acp_harnesses
    from ..providers import EFFORT_API

    target = args.get("target") or {}
    if not isinstance(target, dict):
        raise ToolError("'target' must be an object: {providerInstanceId?, model?, options?}.")
    own_agent, own_model = session_agent(ctx)
    raw = str(target.get("providerInstanceId") or target.get("driverKind") or "").strip()
    if not raw:
        agent = own_agent
    elif raw == BUILTIN:
        agent = None
    elif acp_harnesses.find(raw) is not None:
        agent = raw
    else:
        raise ToolError(f"Unknown providerInstanceId '{raw}'. Call orchestrator_capabilities for the providers.")
    model = str(target.get("model") or "").strip() or None
    if model is None and agent == own_agent:
        model = own_model
    effort = _effort(target.get("options"))
    if effort is not None:
        levels = list(EFFORT_API) if agent is None else [e["id"] for e in acp_harnesses.cached_efforts(agent)]
        if levels and effort not in levels:
            raise ToolError(f"effort '{effort}' is not an option of {_instance(agent)}. Use one of: {', '.join(levels)}.")
    return agent, model, effort


def child_mode(requested: Any, ctx: ToolContext) -> str:
    """The permission mode of the child: "inherit" (default) is the mode of this session. A mode above it is
    rejected (runtime_mode_escalation_denied of T3 Code)."""
    if requested in (None, "", "inherit"):
        return routine_mode(None, session_mode(ctx))
    if requested not in MODE_ORDER:
        raise ToolError(f"runtimeMode must be 'inherit' or one of: {', '.join(MODE_ORDER)}.")
    return routine_mode(requested, session_mode(ctx))


# -- the tools -----------------------------------------------------------------------------------------


class OrchestratorCapabilitiesTool(Tool):
    name = "orchestrator_capabilities"
    description = ("List providers, models, options, and runtime modes for `delegate_task`. Short list. `search` "
                   "finds others. Any catalog model works.")
    parameters = {
        "type": "object",
        "properties": {
            "search": {"type": "string", "description": "Match model ids and labels. Replaces the short list."},
        },
    }

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from .. import acp_harnesses, provider_config
        from ..providers import DEFAULT_EFFORT, EFFORT_API

        search = str(args.get("search") or "").strip().lower()
        cap = SEARCH_CAP if search else SHORT_LIST

        def pick(models: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
            found = [m for m in models if not search or search in f"{m['id']} {m.get('label', '')}".lower()]
            return found[:cap], max(0, len(found) - cap)

        own_agent, own_model = session_agent(ctx)
        mode = session_mode(ctx)
        modes = list(MODE_ORDER[:MODE_ORDER.index("default" if mode == "plan" else mode) + 1])
        providers: list[dict[str, Any]] = []
        try:
            listed = await asyncio.wait_for(provider_config.all_models(), CAPABILITY_TIMEOUT)
        except Exception as e:  # noqa: BLE001 - the list is extra information.
            listed = {"items": [], "errors": [{"provider": "providers", "message": str(e) or type(e).__name__}]}
        builtin = [{"id": f"{i['provider']}/{i['model']}"} for i in listed.get("items") or []]
        shown, omitted = pick(builtin)
        effort_option = {"id": "effort", "values": list(EFFORT_API), "default": DEFAULT_EFFORT}
        providers.append({
            "providerInstanceId": BUILTIN, "driverKind": BUILTIN, "displayName": "Harness",
            "models": [{**m, "options": [effort_option]} for m in shown], "omittedModels": omitted,
            "runtimeModes": modes, "canRunChildTask": True, "canRunCrossProviderChildTask": True,
            "constraints": [f"{e.get('provider')}: {e.get('message')}" for e in listed.get("errors") or []]})
        for harness_id in acp_harnesses.enabled_ids(ctx.settings):
            spec = acp_harnesses.find(harness_id)
            if spec is None:
                continue
            state, detail = acp_harnesses.status(spec)
            efforts = [e["id"] for e in acp_harnesses.cached_efforts(spec.id)]
            option = [{"id": "effort", "values": efforts}] if efforts else []
            models = [{"id": str(m["id"]), **({"label": str(m["name"])} if m.get("name") and m["name"] != m["id"] else {}),
                       **({"options": option} if option else {})}
                      for m in acp_harnesses.cached_models(spec.id) if not acp_harnesses.is_default_alias(m)]
            shown, omitted = pick(models)
            constraints = [] if models else ["The model list is not known yet: the agent uses its default model."]
            if state == "missing":
                constraints.append(detail or "Not installed.")
            providers.append({
                "providerInstanceId": spec.id, "driverKind": spec.id, "displayName": spec.name, "models": shown,
                "omittedModels": omitted, "runtimeModes": modes, "canRunChildTask": state != "missing",
                "canRunCrossProviderChildTask": state != "missing", "constraints": constraints})
        return _json({
            "parentThreadId": None, "inheritedProviderInstanceId": _instance(own_agent), "inheritedModel": own_model,
            "runtimeMode": mode, "providers": providers,
            "features": {"appOwnedSubagents": True, "asyncPolling": True, "cancellation": True,
                         "batchThreadCreation": False, "threadManagement": False, "incrementalThreadRead": False,
                         "scheduledTasks": True, "maxBatchThreads": 0}})


class DelegateTaskTool(Tool):
    name = "delegate_task"
    description = ("Start one child agent with only `task`. No parent history. Separate checkout or PR per child: "
                   "`isolation:'worktree'`. Keep `taskId` for `task_status` and `task_cancel`. No secrets in `task`.")
    parameters = {
        "type": "object",
        "properties": {
            "task": {"type": "string", "description": "The full task for the child."},
            "target": {
                "type": "object",
                "properties": {
                    "providerInstanceId": {"type": "string",
                                           "description": "Provider instance id from `orchestrator_capabilities`."},
                    "driverKind": {"type": "string", "description": "Prefer `providerInstanceId`."},
                    "model": {"type": "string"},
                    "options": {"type": "object", "description": "Options from `orchestrator_capabilities`, such as "
                                                                 "{effort:'max'}. Given values override inherited. "
                                                                 "[] or {} clears."},
                },
            },
            "title": {"type": "string"},
            "role": {"type": "string", "enum": list(ROLES)},
            "isolation": {"type": "string", "enum": ["shared", "worktree"],
                          "description": "'shared' (default): parent checkout. 'worktree': new prepared checkout from "
                                         "the parent commit, for a separate checkout or PR per child. Uncommitted edits "
                                         "stay out."},
            "mode": {"type": "string", "enum": ["async", "wait"],
                     "description": "Default 'async'. 'wait' only if this turn needs the result. A question or "
                                    "approval ends the wait."},
            "timeoutMs": {"type": "number", "description": "Mode 'wait' only. At most 45 s. A timeout does not cancel "
                                                           "the child."},
            "runtimeMode": {"type": "string", "enum": ["inherit", *MODE_ORDER],
                            "description": "Omit unless the user asks for a supervised child. Narrow modes pause for "
                                           "human approval, not read-only. Above yours is rejected."},
        },
        "required": ["task"],
    }

    def __init__(self, start: StartFn, registry: Registry):
        self.start = start
        self.registry = registry

    def _fields(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        task = str(args.get("task") or "").strip()
        if not task:
            raise ToolError("Give 'task'.")
        if len(task) > MAX_TASK_CHARS:
            raise ToolError(f"'task' is longer than {MAX_TASK_CHARS} characters.")
        role = str(args.get("role") or "general")
        if role not in ROLES:
            raise ToolError(f"'role' must be one of: {', '.join(ROLES)}.")
        isolation = str(args.get("isolation") or "shared")
        if isolation not in ("shared", "worktree"):
            raise ToolError("'isolation' must be 'shared' or 'worktree'.")
        mode = str(args.get("mode") or "async")
        if mode not in ("async", "wait"):
            raise ToolError("'mode' must be 'async' or 'wait'.")
        if ctx.tasks is None:
            raise ToolError("Delegation is not available here.")
        timeout = args.get("timeoutMs")
        timeout_ms = WAIT_DEFAULT_MS if not isinstance(timeout, (int, float)) else max(0, min(float(timeout), WAIT_MAX_MS))
        agent, model, effort = resolve_target(args, ctx)
        title = " ".join(str(args.get("title") or "").split()) or " ".join(task.split())[:60]
        # "Act as the X sub-agent for this task." before the task, as T3 Code (delegatedTaskModes.ts).
        text = task if role == "general" else f"Act as the {role} sub-agent for this task.\n\n{task}"
        return {"task": text, "title": title[:TITLE_CHARS], "agent": agent, "model": model, "effort": effort,
                "worktree": isolation == "worktree", "mode": mode, "timeout": timeout_ms / 1000,
                "runtime_mode": child_mode(args.get("runtimeMode"), ctx)}

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from ..tasks import TaskError

        f = self._fields(args, ctx)
        try:
            item = await self.start(f["title"], f["task"], f["agent"], f["model"], f["effort"], f["worktree"],
                                    f["runtime_mode"])
        except ToolError:
            raise
        except Exception as e:  # noqa: BLE001 - the model gets the reason.
            raise ToolError(f"The child did not start: {e}") from None
        item.effort = f["effort"]
        item.done = asyncio.ensure_future(item.wait())

        async def job(task: Any) -> int:
            await asyncio.wait({item.done})
            task.end_note = wake_detail(task.id, item)
            task.result = item.summary() or ""
            task.append(f"{task.end_note}\n")
            return 0 if item.status() == "completed" else 1

        who = f"{agent_label(item.agent)}{f' · {item.model}' if item.model else ''}"
        try:
            background = ctx.tasks.start_job("agent", f["task"], f"{item.title} ({who})", job)
        except TaskError as e:
            await item.cancel()
            raise ToolError(str(e)) from None
        item.task_id = background.id
        self.registry.items[background.id] = item
        if f["mode"] == "wait":
            try:
                await asyncio.wait({item.done}, timeout=f["timeout"])
            except asyncio.CancelledError:
                await item.cancel()  # The turn of this session stopped: the child stops too.
                raise
            if item.done.done():
                background.noted = True  # This reply has the result: no wake note.
                return _json(result_of(background.id, item))
            return _json(result_of(background.id, item, wait_timed_out=True))
        return _json(result_of(background.id, item))


class TaskStatusTool(Tool):
    name = "task_status"
    description = ("Read one delegated task you started. Do not call it on a running task before its completion wakes "
                   "you. `workState`: working, waiting_for_children, result_available. A finished turn with live child "
                   "work is not done. `summary`: final result. Reading it marks it delivered.")
    parameters = {"type": "object", "properties": {"taskId": {"type": "string"}}, "required": ["taskId"]}

    def __init__(self, registry: Registry):
        self.registry = registry

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        task_id, item = self.registry.find(args)
        if item.summary() is not None and ctx.tasks is not None:
            background = ctx.tasks.tasks.get(task_id)
            if background is not None:
                background.noted = True  # Reading the result marks it delivered.
        return _json(result_of(task_id, item))


class TaskCancelTool(Tool):
    name = "task_cancel"
    description = ("Stop one delegated task by `taskId`. Stops its running and queued turns, its delegates, and its PR "
                   "watches, including later runs in its child thread. A finished task keeps its result.")
    parameters = {
        "type": "object",
        "properties": {"taskId": {"type": "string"}, "reason": {"type": "string"}},
        "required": ["taskId"],
    }

    def __init__(self, registry: Registry):
        self.registry = registry

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        task_id, item = self.registry.find(args)
        if item.done is not None and item.done.done():
            return _json({"taskId": task_id, "status": item.status()})
        item.cancelled = True
        await item.cancel()
        return _json({"taskId": task_id, "status": "cancel_requested"})


def delegate_tools(start: StartFn) -> list[Tool]:
    registry = Registry()
    return [OrchestratorCapabilitiesTool(), DelegateTaskTool(start, registry), TaskStatusTool(registry),
            TaskCancelTool(registry)]
