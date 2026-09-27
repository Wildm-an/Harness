"""The agent loop.

1. Send the system prompt, the history, and the tool schemas to the model.
2. Stream the text to the client.
3. If the model returns tool calls, run them in order and append the results.
4. Repeat until the model returns no tool calls, the tool call limit is reached,
   the user denies a tool call, or the user interrupts the turn.

The agent sends events with the same shape as the protocol messages:
``token``, ``tool.start``, ``tool.result``, ``fs.changed``, ``context.compacted``,
``turn.end``, and ``error``.

Before each model call, the agent checks the context size. See context.py.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import load_settings
from .context import COMPACT_AT, KEEP_TURNS, estimate_tokens, split_turns, summarize, trim_tool_outputs
from .files import file_hash, relpath
from .permissions import Approver, PermissionGate
from .prompt import build_system_prompt, load_project_instructions
from .providers import DEFAULT_CONTEXT_LENGTH, ModelClient, ModelError
from .skills import Skill, render_skill
from .tools import (
    SkillTool,
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    default_tools,
    detect_shell,
    preview_tools,
    truncate,
)

Emit = Callable[[dict[str, Any]], Awaitable[None]]
# Called after a compaction with the number of removed history messages and the new summary.
OnCompact = Callable[[int, "str | None"], None]

INTERRUPTED = "The user interrupted the turn. The tool did not complete."
DENIED = "The user denied this tool call."
SKIPPED_AFTER_DENY = "Not run, because the user denied an earlier tool call."

# Fields of stored messages that only the client uses. The model does not get them.
# The model gets the "image" of a tool result in a separate message. See Agent.messages.
CLIENT_ONLY_FIELDS = ("is_error", "diff", "display", "image")

IMAGE_MESSAGE = "The image from the {tool} tool call:"

# Events of a subagent that the client does not get. The subagent report replaces its text.
SUBAGENT_HIDDEN_EVENTS = {"token", "turn.end", "context.compacted", "command.result"}

FORK_REPORT_REQUEST = (
    "You run in a separate context for this skill. When the task is complete, write a short report "
    "of the result. The report is the only text that goes back to the main conversation."
)


class Agent:
    def __init__(
        self,
        *,
        cwd: Path,
        client: ModelClient,
        emit: Emit,
        approver: Approver,
        settings: dict[str, Any] | None = None,
        history: list[dict[str, Any]] | None = None,
        tools: list[Tool] | None = None,
        summary: str | None = None,
        context_length: int = DEFAULT_CONTEXT_LENGTH,
        on_compact: OnCompact | None = None,
        skills: dict[str, Skill] | None = None,
        session_allow: list[str] | None = None,
        read_roots: tuple[Path, ...] | None = None,
        image_input: bool = False,
    ):
        self.cwd = Path(cwd).resolve()
        self.client = client
        self.image_input = image_input  # The model accepts images, for example screenshots.
        self.emit = emit
        self.settings = settings if settings is not None else load_settings(self.cwd)
        self.skills: dict[str, Skill] = dict(skills or {})
        if read_roots is None:
            read_roots = tuple(s.dir for s in self.skills.values())
        self.ctx = ToolContext(cwd=self.cwd, settings=self.settings, shell=detect_shell(self.settings.get("shell")),
                               read_roots=read_roots)
        tool_list = list(tools if tools is not None else default_tools())
        if any(s.model_invocable for s in self.skills.values()):
            tool_list.append(SkillTool(self.skills, self._activate_skill, self.run_fork))
        self.tools = {t.name: t for t in tool_list}
        self.gate = PermissionGate(self.cwd, approver, session_allow)
        self.history: list[dict[str, Any]] = list(history or [])
        self.instructions = load_project_instructions(self.cwd)
        self.summary = summary
        self.context_length = context_length
        self.on_compact = on_compact
        # The prompt tokens that the endpoint reported, and the history length at that time.
        self._known_tokens: tuple[int, int] | None = None
        self._rebuild_prompt()

    def _rebuild_prompt(self) -> None:
        self.system_prompt = build_system_prompt(
            self.ctx, self.client.label, self.instructions, self.summary, list(self.skills.values()))
        self._known_tokens = None

    def set_client(self, client: ModelClient, context_length: int | None = None,
                   image_input: bool | None = None) -> None:
        self.client = client
        if context_length:
            self.context_length = context_length
        if image_input is not None:
            self.image_input = image_input
            self._sync_preview_tools()
        self._rebuild_prompt()

    def enable_preview(self, host: Any) -> None:
        """Add the preview tools. ``host`` is the preview host of the session (preview.py)."""
        self.ctx.preview = host
        self._sync_preview_tools()
        self._rebuild_prompt()

    def _sync_preview_tools(self) -> None:
        for name in [n for n in self.tools if n.startswith("preview_")]:
            del self.tools[name]
        if self.ctx.preview is not None:
            # preview_screenshot is only for a model with image input.
            self.tools.update({t.name: t for t in preview_tools(self.image_input)})

    def reload_settings(self, settings: dict[str, Any]) -> None:
        """Use changed settings, for example "auto_verify" from the client."""
        self.settings.clear()
        self.settings.update(settings)
        self._rebuild_prompt()

    def clear(self) -> None:
        """Start a new context: no history and no summary."""
        self.history.clear()
        self.summary = None
        self._rebuild_prompt()

    def context_tokens(self) -> int:
        """The size of the next request, in tokens. Uses the endpoint count when it is known."""
        if self._known_tokens and self._known_tokens[1] <= len(self.history):
            known, length = self._known_tokens
            return known + estimate_tokens(self.history[length:])
        return estimate_tokens(self.messages()) + estimate_tokens(self.tool_schemas())

    def messages(self) -> list[dict[str, Any]]:
        """The messages for the model. Fields for the client only are removed.

        The newest image of a tool result in the current turn goes to the model in a user
        message after the tool results. Tool messages cannot hold images for most servers.
        Older images stay in the history for the client only, to save context.
        """
        image_at = self._current_image() if self.image_input else None
        history: list[dict[str, Any]] = []
        for i, m in enumerate(self.history):
            history.append({k: v for k, v in m.items() if k not in CLIENT_ONLY_FIELDS}
                           if any(k in m for k in CLIENT_ONLY_FIELDS) else m)
            last_result = i + 1 == len(self.history) or self.history[i + 1].get("role") != "tool"
            if image_at is not None and i >= image_at and last_result:
                image = self.history[image_at]
                history.append({"role": "user", "content": [
                    {"type": "text", "text": IMAGE_MESSAGE.format(tool=self._tool_name(image["tool_call_id"]))},
                    {"type": "image_url", "image_url": {"url": image["image"]}},
                ]})
                image_at = None
        return [{"role": "system", "content": self.system_prompt}, *history]

    def _current_image(self) -> int | None:
        """The index of the newest tool message with an image, if no user message comes after it."""
        for i in range(len(self.history) - 1, -1, -1):
            m = self.history[i]
            if m.get("role") == "user":
                return None
            if m.get("role") == "tool" and m.get("image"):
                return i
        return None

    def _tool_name(self, call_id: str) -> str:
        for m in reversed(self.history):
            for call in m.get("tool_calls") or []:
                if call["id"] == call_id:
                    return call["function"]["name"]
        return "tool"

    def _used_call_ids(self) -> set[str]:
        return {c["id"] for m in self.history for c in m.get("tool_calls") or []}

    def _unique_ids(self, calls: list[dict[str, str]]) -> list[dict[str, str]]:
        """Replace a tool call id that is already in the history.

        Some servers use the same id (for example "call_0") in each response. The
        client and the history need one id for one call.
        """
        used = self._used_call_ids()
        result = []
        for call in calls:
            if not call["id"] or call["id"] in used:
                call = {**call, "id": f"call_{uuid.uuid4().hex[:12]}"}
            used.add(call["id"])
            result.append(call)
        return result

    def tool_schemas(self) -> list[dict[str, Any]]:
        return [t.schema(self.ctx) for t in self.tools.values()]

    async def run_turn(self, text: str, *, display: str | None = None, allow: tuple[str, ...] = ()) -> str:
        """Run one user turn. Return the stop reason.

        ``display`` is the text that the client shows for the user message, for example
        "/review src" when ``text`` holds the skill instructions. ``allow`` holds rules
        that apply for this turn only, for example the allowed-tools of a skill.

        Stop reasons: ``end``, ``max_tool_calls``, ``denied``, ``interrupted``, ``error``.
        """
        message: dict[str, Any] = {"role": "user", "content": text}
        if display is not None:
            message["display"] = display
        self.history.append(message)
        self.gate.turn_allow = list(allow)
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "last_prompt_tokens": 0}
        max_calls = int(self.settings["max_tool_calls"])
        calls_used = 0
        streamed: list[str] = []
        open_calls: list[dict[str, str]] = []  # Tool calls that have no result yet.
        in_flight: str | None = None  # The id of the tool call that runs now.
        stop = "end"

        async def on_text(chunk: str) -> None:
            streamed.append(chunk)
            await self.emit({"type": "token", "text": chunk})

        try:
            while True:
                streamed.clear()
                if self.context_tokens() >= COMPACT_AT * self.context_length:
                    await self.compact("auto")
                response = await self.client.stream(self.messages(), self.tool_schemas(), on_text)
                if response.usage:
                    usage["prompt_tokens"] += response.usage.get("prompt_tokens", 0)
                    usage["completion_tokens"] += response.usage.get("completion_tokens", 0)
                    usage["last_prompt_tokens"] = response.usage.get("prompt_tokens", 0)

                response.tool_calls = self._unique_ids(response.tool_calls)
                message: dict[str, Any] = {"role": "assistant", "content": response.text or None}
                if response.tool_calls:
                    message["tool_calls"] = [
                        {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                        for c in response.tool_calls
                    ]
                self.history.append(message)
                streamed.clear()
                if response.usage and response.usage.get("prompt_tokens"):
                    total = response.usage["prompt_tokens"] + response.usage.get("completion_tokens", 0)
                    self._known_tokens = (total, len(self.history))
                if not response.tool_calls:
                    break

                open_calls = list(response.tool_calls)
                while open_calls:
                    call = open_calls[0]
                    if calls_used >= max_calls:
                        stop = "max_tool_calls"
                        self._close_open_calls(
                            open_calls,
                            f"Not run. The limit of {max_calls} tool calls for each turn is reached. "
                            "Stop and tell the user what is left to do.",
                        )
                        break
                    calls_used += 1
                    in_flight = call["id"]
                    result = await self._run_tool_call(call)
                    in_flight = None
                    self._add_tool_result(call["id"], result.output, result.is_error, result.diff, result.image)
                    open_calls.pop(0)
                    if result is _DENIED_RESULT:
                        stop = "denied"
                        self._close_open_calls(open_calls, SKIPPED_AFTER_DENY)
                        break
                if stop != "end":
                    break
        except asyncio.CancelledError:
            task = asyncio.current_task()
            if task is not None and hasattr(task, "uncancel"):
                task.uncancel()
            if streamed:
                self.history.append({"role": "assistant", "content": "".join(streamed)})
            self._close_open_calls(open_calls, INTERRUPTED)
            if in_flight is not None:
                await self.emit({"type": "tool.result", "id": in_flight, "output": INTERRUPTED, "is_error": True})
            stop = "interrupted"
        except ModelError as e:
            await self.emit({"type": "error", "message": str(e)})
            stop = "error"

        await self.emit({"type": "turn.end", "usage": self._usage(usage), "stop_reason": stop})
        return stop

    def _usage(self, usage: dict[str, int]) -> dict[str, int]:
        return {**usage, "context_tokens": self.context_tokens(), "context_length": self.context_length}

    # -- skills --------------------------------------------------------------------

    def _activate_skill(self, skill: Skill) -> None:
        """The allowed-tools of a skill run with no approval for the rest of the turn."""
        self.gate.turn_allow.extend(r for r in skill.allowed_tools if r not in self.gate.turn_allow)

    async def run_skill(self, skill: Skill, args: str) -> str:
        """Run a skill that the user started with /name. Return the stop reason."""
        display = f"/{skill.name} {args}".strip()
        if skill.context == "fork":
            return await self._run_fork_turn(skill, args, display)
        lead = f"The user started the skill /{skill.name}"
        lead += f" with these arguments: {args.strip()}." if args.strip() else "."
        text = f"{lead} Follow the skill instructions.\n\n{render_skill(skill, args, self.cwd)}"
        return await self.run_turn(text, display=display, allow=skill.allowed_tools)

    async def run_fork(self, skill: Skill, args: str) -> str:
        """Run a skill in a subagent with a new context. Return the report of the subagent."""
        async def forward(event: dict[str, Any]) -> None:
            if event["type"] not in SUBAGENT_HIDDEN_EVENTS:
                await self.emit({**event, "agent": skill.name})

        sub = Agent(
            cwd=self.cwd, client=self.client, emit=forward, approver=self.gate.approver,
            settings=self.settings, context_length=self.context_length,
            session_allow=list(skill.allowed_tools), read_roots=self.ctx.read_roots,
            image_input=self.image_input,
        )
        if self.ctx.preview is not None:
            sub.enable_preview(self.ctx.preview)
        prompt = f"{render_skill(skill, args, self.cwd)}\n\n{FORK_REPORT_REQUEST}"
        stop = await sub.run_turn(prompt)
        if stop == "interrupted":
            raise asyncio.CancelledError()
        report = next((m["content"] for m in reversed(sub.history)
                       if m.get("role") == "assistant" and m.get("content")), None)
        if stop == "error" and not report:
            raise ModelError(f"The skill {skill.name} failed in its subagent.")
        return report or f"The skill {skill.name} ended with no report (stop reason: {stop})."

    async def _run_fork_turn(self, skill: Skill, args: str, display: str) -> str:
        self.history.append({"role": "user", "content": f"Run the skill /{skill.name} {args}".strip(),
                             "display": display})
        stop = "end"
        try:
            report = await self.run_fork(skill, args)
            self.history.append({"role": "assistant", "content": report})
            await self.emit({"type": "token", "text": report})
        except asyncio.CancelledError:
            task = asyncio.current_task()
            if task is not None and hasattr(task, "uncancel"):
                task.uncancel()
            stop = "interrupted"
        except ModelError as e:
            await self.emit({"type": "error", "message": str(e)})
            stop = "error"
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "last_prompt_tokens": 0}
        await self.emit({"type": "turn.end", "usage": self._usage(usage), "stop_reason": stop})
        return stop

    # -- context ---------------------------------------------------------------------

    async def compact(self, reason: str) -> bool:
        """Summarize the old turns. Keep the last turns. Return True if the context changed.

        ``reason`` is ``auto`` (the context is near the limit) or ``manual`` (the /compact command).
        """
        turns = split_turns(self.history)
        keep = KEEP_TURNS if reason == "auto" else min(KEEP_TURNS, len(turns) - 1)
        removed = 0
        summary: str | None = None
        if keep >= 1 and len(turns) > keep:
            old = [m for turn in turns[:-keep] for m in turn]
            try:
                summary = await summarize(self.client, self.summary, old, self.context_length)
            except ModelError as e:
                await self.emit({"type": "error", "message": f"The context summary failed: {e}"})
            if summary:
                removed = len(old)
                self.history = [m for turn in turns[-keep:] for m in turn]
                self.summary = summary
                self._rebuild_prompt()
                if self.on_compact:
                    self.on_compact(removed, summary)

        # If the kept turns are still too large, remove old tool outputs. Keep the current turn.
        trimmed = 0
        if self.context_tokens() >= COMPACT_AT * self.context_length:
            last_turn = split_turns(self.history)[-1] if self.history else []
            trimmed = trim_tool_outputs(self.history, len(self.history) - len(last_turn))
            self._known_tokens = None

        if not removed and not trimmed:
            return False
        await self.emit({
            "type": "context.compacted",
            "reason": reason,
            "removed_messages": removed,
            "trimmed_outputs": trimmed,
            "summary": summary,
            "context_tokens": self.context_tokens(),
            "context_length": self.context_length,
        })
        return True

    async def run_compact(self) -> None:
        """The /compact command. Sends the same turn.end event as a turn."""
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "last_prompt_tokens": 0}
        stop = "end"
        try:
            if not await self.compact("manual"):
                await self.emit({"type": "command.result", "name": "compact",
                                 "text": "There is not enough history to summarize."})
        except asyncio.CancelledError:
            task = asyncio.current_task()
            if task is not None and hasattr(task, "uncancel"):
                task.uncancel()
            stop = "interrupted"
        await self.emit({"type": "turn.end", "usage": self._usage(usage), "stop_reason": stop})

    def _add_tool_result(self, call_id: str, output: str, is_error: bool, diff: str | None = None,
                         image: str | None = None) -> None:
        message = {"role": "tool", "tool_call_id": call_id, "content": output, "is_error": is_error}
        if diff:
            message["diff"] = diff
        if image:
            message["image"] = image
        self.history.append(message)

    def _close_open_calls(self, open_calls: list[dict[str, str]], output: str) -> None:
        for call in open_calls:
            self._add_tool_result(call["id"], output, True)
        open_calls.clear()

    async def _run_tool_call(self, call: dict[str, str]) -> ToolResult:
        call_id, name = call["id"], call["name"]
        args, parse_error = _parse_arguments(call["arguments"])
        await self.emit({"type": "tool.start", "id": call_id, "name": name, "input": args if args is not None else call["arguments"]})

        result = await self._execute(name, args, parse_error)
        if result is not _DENIED_RESULT:
            result.output = truncate(result.output, int(self.settings["max_output_chars"]))
        event = {"type": "tool.result", "id": call_id, "output": result.output, "is_error": result.is_error}
        if result.diff:
            event["diff"] = result.diff
        if result.image:
            event["image"] = result.image
        await self.emit(event)
        for path in result.changed_paths:
            await self.emit({"type": "fs.changed", "path": relpath(self.cwd, path), "hash": file_hash(path), "by": "agent"})
        return result

    async def _execute(self, name: str, args: dict[str, Any] | None, parse_error: str | None) -> ToolResult:
        tool = self.tools.get(name)
        if tool is None:
            return ToolResult(f"Unknown tool: {name}. The tools are: {', '.join(self.tools)}.", is_error=True)
        if args is None:
            return ToolResult(f"The tool arguments are not valid JSON: {parse_error}", is_error=True)
        try:
            tool.validate(args)
            approval = await tool.prepare(args, self.ctx)
            if not await self.gate.check(tool, args, approval):
                return _DENIED_RESULT
            return await tool.run(args, self.ctx)
        except ToolError as e:
            return ToolResult(str(e), is_error=True)
        except OSError as e:
            return ToolResult(f"{type(e).__name__}: {e}", is_error=True)


_DENIED_RESULT = ToolResult(DENIED, is_error=True)


def _parse_arguments(raw: str) -> tuple[dict[str, Any] | None, str | None]:
    if not raw or not raw.strip():
        return {}, None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as e:
        return None, str(e)
    if not isinstance(value, dict):
        return None, "The arguments must be a JSON object."
    return value, None
