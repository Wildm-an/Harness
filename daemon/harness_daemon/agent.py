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
import logging
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import ConfigError, load_settings
from .context import CHARS_PER_TOKEN, COMPACT_AT, KEEP_TURNS, estimate_tokens, split_turns, summarize, trim_tool_outputs
from .files import file_hash, relpath
from .auto_mode import AutoReviewer
from .permissions import Approver, PermissionGate
from .plugins.host import (
    Hooks, PluginHost, RequestErrorEvent, RequestEvent, StepEvent, StreamEvent, ToolCall, TurnEvent, TurnStoppingEvent,
)
from .prompt import build_system_prompt, load_project_instructions, system_prompt_parts
from .providers import DEFAULT_CONTEXT_LENGTH, ModelClient, ModelError, resolve_model
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

log = logging.getLogger("harness.agent")

Emit = Callable[[dict[str, Any]], Awaitable[None]]
# Called after a compaction with the number of removed history messages and the new summary.
OnCompact = Callable[[int, "str | None"], None]

INTERRUPTED = "The user interrupted the turn. The tool did not complete."
MAX_REQUEST_RETRIES = 3  # The retries that request.error handlers can ask for, for each model call.
MAX_STEER_CONTINUATIONS = 5  # The extra steps that turn.stopping handlers can add to one turn.
DENIED = "The user denied this tool call."
SKIPPED_AFTER_DENY = "Not run, because the user denied an earlier tool call."

# Fields of stored messages that only the client uses. The model does not get them.
# The model gets the "image" of a tool result in a separate message. See Agent.messages.
CLIENT_ONLY_FIELDS = ("is_error", "diff", "display", "image")

IMAGE_MESSAGE = "The image from the {tool} tool call:"

# Events of a subagent that the client does not get. The subagent report replaces its text.
SUBAGENT_HIDDEN_EVENTS = {"token", "turn.end", "turn.usage", "context.compacted", "command.result"}

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
        context_source: str = "default",
        plugins: PluginHost | None = None,
    ):
        self.cwd = Path(cwd).resolve()
        self.client = client
        self.image_input = image_input  # The model accepts images, for example screenshots.
        self.emit = emit
        self.settings = settings if settings is not None else load_settings(self.cwd)
        self.skills: dict[str, Skill] = dict(skills or {})
        if read_roots is None:
            read_roots = tuple(s.dir for s in self.skills.values() if s.has_files)
        self.ctx = ToolContext(cwd=self.cwd, settings=self.settings, shell=detect_shell(self.settings.get("shell")),
                               read_roots=read_roots)
        tool_list = list(tools if tools is not None else default_tools())
        if any(s.model_invocable for s in self.skills.values()):
            tool_list.append(SkillTool(self.skills, self._activate_skill, self.run_fork))
        self.tools = {t.name: t for t in tool_list}
        self.plugins: PluginHost | None = None
        self.hooks = Hooks()
        self._plugin_tools: list[str] = []  # The names of the plugin tools in self.tools.
        self._set_plugin_tools(plugins)
        self.gate = PermissionGate(self.cwd, approver, session_allow,
                                   mode=lambda: self.settings.get("permission_mode") or "default")
        self.gate.auto = AutoReviewer(self)
        self.history: list[dict[str, Any]] = list(history or [])
        self.instructions = load_project_instructions(self.cwd)
        self.summary = summary
        self.context_length = context_length
        self.context_source = context_source  # Where the context length came from, for the client.
        self.on_compact = on_compact
        # The prompt tokens that the endpoint reported, and the history length at that time.
        self._known_tokens: tuple[int, int] | None = None
        self.streamed: list[str] = []  # The reply text that streams now. It is not in the history yet.
        self.turn_number = 0
        self.in_turn = False
        # User messages from plugins (DeepSeek agent.steer) that wait for the next step.
        self.pending_steer: list[str] = []
        self._step_contexts: list[str] = []  # tool.after contexts: user messages after the tool results.
        self._cancel_turn = False  # A tool.before handler cancelled a call: the turn stops.
        self._rebuild_prompt()

    def _plugin_sections(self) -> list[str]:
        return self.plugins.prompt_sections() if self.plugins is not None else []

    def _rebuild_prompt(self) -> None:
        self.system_prompt = build_system_prompt(
            self.ctx, self.client.label, self.instructions, self.summary, list(self.skills.values()),
            self._plugin_sections())
        if self.settings.get("permission_mode") == "plan":
            self.system_prompt += PLAN_MODE_NOTE
        self._known_tokens = None

    def set_client(self, client: ModelClient, context_length: int | None = None,
                   image_input: bool | None = None, context_source: str | None = None) -> None:
        self.client = client
        if context_length:
            self.context_length = context_length
            self.context_source = context_source or "default"
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

    def set_mcp_tools(self, tools: list[Tool]) -> None:
        """Replace the MCP tools (``mcp__<server>__<tool>``). The MCP servers of the session change them."""
        for name in [n for n in self.tools if n.startswith("mcp__")]:
            del self.tools[name]
        self.tools.update({t.name: t for t in tools})
        self._known_tokens = None  # The tool schemas are part of the request size.

    def mcp_tools(self) -> list[Tool]:
        return [t for n, t in self.tools.items() if n.startswith("mcp__")]

    def _set_plugin_tools(self, host: PluginHost | None) -> None:
        for name in self._plugin_tools:
            self.tools.pop(name, None)
        self.plugins = host
        self.hooks = host.hooks if host is not None else Hooks()
        if host is not None and host.dsh is not None and host.dsh.agent is None:
            host.dsh.agent = self  # The main agent of the session, not a subagent of a skill.
        # A built-in tool, an MCP tool, or a preview tool wins over a plugin tool with the same name.
        added = [t for t in (host.tools() if host is not None else []) if t.name not in self.tools]
        self.tools.update({t.name: t for t in added})
        self._plugin_tools = [t.name for t in added]
        self._known_tokens = None  # The tool schemas are part of the request size.

    def set_plugins(self, host: PluginHost | None) -> None:
        """Use the plugins of a host that loaded again: their tools, prompt sections, and hooks."""
        self._set_plugin_tools(host)
        self._rebuild_prompt()

    def set_skills(self, skills: dict[str, Skill]) -> None:
        """Replace the skills, for example after a change of the plugins."""
        self.skills = dict(skills)
        self.ctx.read_roots = tuple(s.dir for s in self.skills.values() if s.has_files)
        self.tools.pop(SkillTool.name, None)
        if any(s.model_invocable for s in self.skills.values()):
            tool = SkillTool(self.skills, self._activate_skill, self.run_fork)
            self.tools[tool.name] = tool
        self._rebuild_prompt()

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

    def context_breakdown(self) -> dict[str, Any]:
        """The parts of the next request, in tokens, for the context view of the client.

        The parts are estimates, scaled so that their sum is context_tokens(). The endpoint
        count of the last request is exact, when the endpoint gives it.
        """
        def text_tokens(text: str) -> int:
            return int(len(text) / CHARS_PER_TOKEN) + 1

        sizes = {"system": 0, "instructions": 0, "skills": 0, "plugins": 0, "summary": 0}
        for kind, text in system_prompt_parts(self.ctx, self.client.label, self.instructions, self.summary,
                                              list(self.skills.values()), self._plugin_sections()):
            sizes[kind] += text_tokens(text)
        if self.settings.get("permission_mode") == "plan":
            sizes["system"] += text_tokens(PLAN_MODE_NOTE)
        schemas = self.tool_schemas()
        mcp = [s for name, s in zip(self.tools, schemas) if name.startswith("mcp__")]
        plugin = [s for name, s in zip(self.tools, schemas) if name in self._plugin_tools]
        builtin = [s for name, s in zip(self.tools, schemas)
                   if not name.startswith("mcp__") and name not in self._plugin_tools]
        sizes["tools"] = estimate_tokens(builtin) if builtin else 0
        sizes["mcp_tools"] = estimate_tokens(mcp) if mcp else 0
        sizes["plugins"] += estimate_tokens(plugin) if plugin else 0
        sizes["messages"] = estimate_tokens(self.messages()[1:])
        # The endpoint count is exact, and the parts are estimates. Scale the parts to the total.
        total = self.context_tokens()
        estimate = sum(sizes.values())
        if estimate > 0 and total > 0:
            sizes = {kind: round(tokens * total / estimate) for kind, tokens in sizes.items()}
            sizes["messages"] = max(0, sizes["messages"] + total - sum(sizes.values()))  # The rounding.
        total = sum(sizes.values())
        return {
            "tokens": total,
            "length": self.context_length,
            "compact_at": COMPACT_AT,
            "source": self.context_source,
            "parts": [{"kind": kind, "tokens": tokens} for kind, tokens in sizes.items()],
        }

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
        text = (await self.hooks.emit("turn.start", TurnEvent(text, self.cwd))).text
        message: dict[str, Any] = {"role": "user", "content": text}
        if display is not None:
            message["display"] = display
        self.history.append(message)
        self.gate.turn_allow = list(allow)
        self.turn_number += 1
        turn = self.turn_number
        step = 0
        continuations = 0
        new_messages = [message]  # The new user messages of the next step, for step.before.
        self.in_turn = True
        self._cancel_turn = False
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "last_prompt_tokens": 0}
        max_calls = int(self.settings["max_tool_calls"])
        calls_used = 0
        streamed: list[str] = []
        self.streamed = streamed  # A client that returns to the session reads it.
        open_calls: list[dict[str, str]] = []  # Tool calls that have no result yet.
        in_flight: str | None = None  # The id of the tool call that runs now.
        stop = "end"

        async def on_text(chunk: str) -> None:
            streamed.append(chunk)
            await self.emit({"type": "token", "text": chunk})
            if self.hooks.has("stream.text"):
                await self.hooks.emit("stream.text", StreamEvent(turn, step, chunk, self.cwd))

        try:
            while True:
                streamed.clear()
                step += 1
                new_messages += self._take_pending_steer()
                if self.hooks.has("step.before"):
                    event = await self.hooks.emit("step.before", StepEvent(
                        turn, step, [str(m.get("content") or "") for m in new_messages], self.cwd))
                    if event.blocked:
                        await self.emit({"type": "notice", "level": "info", "text": event.blocked})
                        stop = "blocked"
                        break
                    self._replace_new_messages(new_messages, event.messages)
                new_messages = []
                if self.context_tokens() >= COMPACT_AT * self.context_length:
                    await self.compact("auto")
                client, options = await self._request_config(turn, step)
                response = await self._stream_with_retries(client, options, on_text, streamed, turn, step)
                if self.hooks.has("stream.end"):
                    await self.hooks.emit("stream.end", StreamEvent(turn, step, response.text or "", self.cwd))
                if response.usage:
                    usage["prompt_tokens"] += response.usage.get("prompt_tokens", 0)
                    usage["completion_tokens"] += response.usage.get("completion_tokens", 0)
                    usage["last_prompt_tokens"] = response.usage.get("prompt_tokens", 0)
                    await self.emit({"type": "turn.usage", **usage})  # The working line shows the tokens.

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
                    # turn.stopping handlers can add messages: then the turn continues.
                    if self.hooks.has("turn.stopping") and continuations < MAX_STEER_CONTINUATIONS:
                        stopping = await self.hooks.emit("turn.stopping", TurnStoppingEvent(turn, self.cwd))
                        if stopping.steered:
                            continuations += 1
                            new_messages = [self._add_steered(t) for t in stopping.steered]
                            continue
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
                    if self._cancel_turn:
                        stop = "blocked"
                        self._close_open_calls(open_calls, "Not run, because a plugin cancelled an earlier tool call.")
                        break
                # tool.after contexts: user messages after the tool results of the step.
                for text in self._step_contexts:
                    new_messages.append(self._add_steered(text))
                self._step_contexts = []
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

        self.in_turn = False
        self._step_contexts = []
        await self.hooks.emit("turn.end", TurnEvent(text, self.cwd, stop))
        await self.emit({"type": "turn.end", "usage": self._usage(usage), "stop_reason": stop})
        return stop

    # -- plugin events of the loop ----------------------------------------------------------------

    def _take_pending_steer(self) -> list[dict[str, Any]]:
        texts, self.pending_steer = self.pending_steer, []
        return [self._add_steered(t) for t in texts]

    def _add_steered(self, text: str) -> dict[str, Any]:
        """Add a user message from a plugin. The client shows it as a notice."""
        message = {"role": "user", "content": text}
        self.history.append(message)
        asyncio.ensure_future(self.emit({"type": "notice", "level": "info", "text": f"A plugin added a message: {text}"}))
        return message

    def _replace_new_messages(self, messages: list[dict[str, Any]], texts: list[str]) -> None:
        """Use the new user messages that step.before handlers returned."""
        for message, text in zip(messages, texts):
            message["content"] = text
        for message in messages[len(texts):]:  # A handler removed messages.
            if message in self.history:
                self.history.remove(message)
        for text in texts[len(messages):]:  # A handler added messages.
            self.history.append({"role": "user", "content": text})

    async def _request_config(self, turn: int, step: int) -> tuple[ModelClient, dict[str, Any]]:
        """request.before handlers can change the model and the call options of one model call."""
        client = self.client
        if not self.hooks.has("request.before"):
            return client, {}
        event = await self.hooks.emit("request.before", RequestEvent(
            turn, step, client.provider.name, client.model, self.cwd))
        options = {"temperature": event.temperature, "max_tokens": event.max_tokens, "stop": event.stop}
        if (event.provider, event.model) != (client.provider.name, client.model):
            try:
                provider, model = resolve_model(f"{event.provider}/{event.model}")
                client = ModelClient(provider, model)
            except ConfigError as e:
                log.warning("A plugin selected the model %s/%s, which is not available: %s", event.provider, event.model, e)
        return client, options

    async def _stream_with_retries(self, client: ModelClient, options: dict[str, Any], on_text: Any,
                                   streamed: list[str], turn: int, step: int) -> Any:
        """One model call. request.error handlers can ask for a retry, up to MAX_REQUEST_RETRIES times."""
        attempt = 0
        while True:
            try:
                return await client.stream(self.messages(), self.tool_schemas(), on_text, options=options)
            except ModelError as e:
                attempt += 1
                if not self.hooks.has("request.error") or attempt > MAX_REQUEST_RETRIES:
                    raise
                event = await self.hooks.emit("request.error", RequestErrorEvent(
                    turn, step, client.provider.name, str(e), self.cwd, attempt))
                if not event.retry:
                    raise
                streamed.clear()

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
            image_input=self.image_input, plugins=self.plugins,
        )
        if self.ctx.preview is not None:
            sub.enable_preview(self.ctx.preview)
        sub.set_mcp_tools(self.mcp_tools())
        # Auto mode checks the calls of the subagent with the messages of the user in this session.
        sub.gate.auto = self.gate.auto
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

        result = await self._execute(name, args, parse_error, call_id)
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

    async def _execute(self, name: str, args: dict[str, Any] | None, parse_error: str | None,
                       call_id: str = "") -> ToolResult:
        tool = self.tools.get(name)
        if tool is None:
            return ToolResult(f"Unknown tool: {name}. The tools are: {', '.join(self.tools)}.", is_error=True)
        if args is None:
            return ToolResult(f"The tool arguments are not valid JSON: {parse_error}", is_error=True)
        call = await self.hooks.emit("tool.before", ToolCall(name, args, self.cwd, call_id=call_id))
        if call.blocked:
            if call.cancelled:
                self._cancel_turn = True
            # tool.after still runs, so that result observers see the blocked call (``call.blocked`` is set).
            call.result = ToolResult(f"A plugin blocked this tool call: {call.blocked}", is_error=True)
            call = await self.hooks.emit("tool.after", call)
            return call.result if isinstance(call.result, ToolResult) else ToolResult(str(call.result))
        args = call.args
        try:
            tool.validate(args)
            approval = await tool.prepare(args, self.ctx)
            allowed = await self.gate.check(tool, args, approval, force=call.asked)
            if isinstance(allowed, str):  # The permission mode blocked the action. The turn continues.
                return ToolResult(allowed, is_error=True)
            if not allowed:
                return _DENIED_RESULT
            call.result = await tool.run(args, self.ctx)
        except ToolError as e:
            call.result = ToolResult(str(e), is_error=True)
        except OSError as e:
            call.result = ToolResult(f"{type(e).__name__}: {e}", is_error=True)
        except Exception as e:  # noqa: BLE001 - a tool bug gives an error result. The turn continues.
            log.exception("The tool %s failed", name)
            call.result = ToolResult(f"The tool failed: {type(e).__name__}: {e}", is_error=True)
        call = await self.hooks.emit("tool.after", call)
        self._step_contexts.extend(call.contexts)
        return call.result if isinstance(call.result, ToolResult) else ToolResult(str(call.result))


_DENIED_RESULT = ToolResult(DENIED, is_error=True)

PLAN_MODE_NOTE = """

Plan mode is on. Do not change files. Read and search the project, then give the user a plan:
the steps, and the files that each step changes. Then stop. The user changes the mode to start the work."""


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
