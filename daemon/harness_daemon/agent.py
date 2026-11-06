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
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from .config import ConfigError, load_settings
from .context import CHARS_PER_TOKEN, COMPACT_AT, KEEP_TURNS, estimate_tokens, split_turns, summarize, trim_tool_outputs
from .created import before_call, created_files
from .files import file_hash, relpath
from .auto_mode import AutoReviewer
from .permissions import Approver, PermissionGate
from .plugins.host import (
    Hooks, PluginHost, RequestErrorEvent, RequestEvent, StepEvent, StreamEvent, ToolCall, TurnEvent, TurnStoppingEvent,
)
from .loop_guards import (
    MAX_STALL_NUDGES, STALL_NOTICE, STALL_NUDGE, is_stall, repair_tool_name, repaired_note, repeat_key, repeat_note,
)
from .prompt import build_system_prompt, load_project_instructions, system_prompt_parts
from .providers import DEFAULT_CONTEXT_LENGTH, DEFAULT_EFFORT, EFFORT_API, ModelClient, ModelError, resolve_model
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
from .tools.interact import AskUserQuestionTool, ExitPlanModeTool
from .agents import DEFAULT_TYPE as DEFAULT_AGENT_TYPE, AgentType, discover_agents
from .hooks import CommandHooks, HookOutcome
from .memory import MemoryStore
from .tools.chats import ConversationSearchTool
from .tools.memory import MemoryTool
from .tools.tool_search import ToolSearchTool

log = logging.getLogger("harness.agent")

Emit = Callable[[dict[str, Any]], Awaitable[None]]
# Called after a compaction with the number of removed history messages and the new summary.
OnCompact = Callable[[int, "str | None"], None]

INTERRUPTED = "The user interrupted the turn. The tool did not complete."
MAX_REQUEST_RETRIES = 3  # The retries that request.error handlers can ask for, for each model call.
# Tool search ("tool_search": "auto"): the MCP tools are sent by name only when their definitions are
# larger than this number of tokens, or this part of the context. A model server reads the definitions
# for each request: many MCP tools make each step slower.
TOOL_SEARCH_TOKENS = 4000
TOOL_SEARCH_SHARE = 0.10
MAX_STEER_CONTINUATIONS = 5  # The extra steps that turn.stopping handlers can add to one turn.
DENIED = "The user denied this tool call."
SKIPPED_AFTER_DENY = "Not run, because the user denied an earlier tool call."

# Fields of stored messages that only the client uses. The model does not get them.
# The model gets the "image" of a tool result in a separate message. See Agent.messages.
CLIENT_ONLY_FIELDS = ("is_error", "diff", "display", "image", "id", "ts", "origin", "images", "created", "card")
# A user message with images, for a model with no image input.
NO_IMAGE_NOTE = ("[The user attached {count} image(s). This model cannot read images, so you cannot see them. "
                 "Tell the user, if the images are important for the task.]")

# Called before the first change of a file in the turn of a user message: (message id, path, content or None).
OnCheckpoint = Callable[[str, str, "bytes | None"], None]

# The tools that change files. A checkpoint keeps the file content before the change.
FILE_TOOLS = ("edit", "write", "office_edit")  # Rewind keeps the file before these tools change it.

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
        user_facing: bool = True,
    ):
        self.cwd = Path(cwd).resolve()
        # True: the user talks to this agent, so its prompt has the agent instructions of the user.
        # A subagent gets False: the agent that made it tells it how to act.
        self.user_facing = user_facing
        self.role_prompt: str | None = None  # A subagent: the prompt of its agent type (agents.py).
        self.command_hooks: CommandHooks | None = None  # The hooks of the settings files (hooks.py).
        # The auto memory of the project (memory.py). Only the agent that the user talks to has it.
        self.memory: MemoryStore | None = None
        # The search of the past sessions of the project (Session sets it). None: no chat search.
        self.chat_search: Callable[[str, int], list[dict[str, Any]]] | None = None
        # The list of the other sessions of the project, for a harness note (Session sets it).
        self.session_context: Callable[[], str | None] | None = None
        self._told_sessions: str | None = None  # The last session list note in the conversation.
        self.client = client
        self.image_input = image_input  # The model accepts images, for example screenshots.
        self.emit = emit
        self.settings = settings if settings is not None else load_settings(self.cwd)
        self.skills: dict[str, Skill] = dict(skills or {})
        if read_roots is None:
            read_roots = tuple(s.dir for s in self.skills.values())
        self.ctx = ToolContext(cwd=self.cwd, settings=self.settings, shell=detect_shell(self.settings.get("shell")),
                               read_roots=read_roots, image_input=image_input)
        self.ctx.model = lambda: self.client.label  # The model can change during the session.
        self.command_hooks = CommandHooks(self.cwd, self.ctx.shell)
        tool_list = list(tools if tools is not None else default_tools())
        if any(s.model_invocable for s in self.skills.values()):
            tool_list.append(SkillTool(self.skills, self._activate_skill, self.run_fork))
        self.tools = {t.name: t for t in tool_list}
        # Tool search: MCP tools that the request sends by name only, until the model loads them.
        self._loaded_tools: list[str] = []  # In the order of the loads.
        self._tool_search = ToolSearchTool(lambda: {n: self.tools[n] for n in self._deferrable()}, self._load_tools)
        # The web_search tool, also while the "web_search" setting is "off" and the agent does not have it.
        self._web_search = self.tools.get("web_search")
        self._sync_web_search()
        # The agent that the user talks to can ask questions, and can give a plan for approval in plan mode.
        self.on_mode: Callable[[str], Awaitable[None]] | None = None  # The session saves a new mode.
        if self.user_facing:
            self.tools[AskUserQuestionTool.name] = AskUserQuestionTool()
            self.ctx.ask = self._ask_user
            self.ctx.set_mode = self._set_mode
        self._sync_plan_tool()
        if self.user_facing:
            self.memory = MemoryStore(self.cwd)
        self._sync_memory_tool()
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
        # User messages that wait for the next step: (id, text, display, origin). The client sends them
        # ("steer"), or a background task does (origin "task").
        self.user_steer: list[tuple[str, str, str | None, str | None]] = []
        # The task notes of steer messages that the turn did not take. The session gives them again.
        self.on_notes_returned: Callable[[list[tuple[str, str]]], None] | None = None
        # The user message of the work now: the prompt of the turn, or the last steer message.
        self.message_id: str | None = None
        self.on_checkpoint: OnCheckpoint | None = None  # The session stores the checkpoints.
        self._step_contexts: list[str] = []  # tool.after contexts: user messages after the tool results.
        self._cancel_turn = False  # A tool.before handler cancelled a call: the turn stops.
        self._repeat_counts: dict[str, int] = {}  # Identical calls with identical results in this turn.
        # The system prompt stays the same in a session, so the prompt cache of the endpoint stays valid.
        # Plan mode and memory changes go to the model as harness notes in the conversation.
        self._told_plan = False  # True: the last plan mode note told the model that plan mode is on.
        self._memory_text: str | None = None  # The memory of the system prompt: a snapshot.
        self._memory_loaded = False  # False: the next prompt build reads the memory again.
        self._harness_notes: list[str] = []  # Notes for the next step of a turn.
        self._turn_start = 0  # The history index of the user message of the turn.
        self._plan_nudged = False  # The turn got the reminder to show a task list.
        self._stale_nudges = (-1, 0)  # (history index of the last plan, reminders sent for it): PLAN_STALE_NOTE.
        self._rebuild_prompt()

    def _plugin_sections(self) -> list[str]:
        return self.plugins.prompt_sections() if self.plugins is not None else []

    def _rebuild_prompt(self) -> None:
        self.system_prompt = build_system_prompt(
            self.ctx, self.client.label, self.instructions, self.summary, list(self.skills.values()),
            self._plugin_sections(), user_facing=self.user_facing, tool_names=list(self.tools))
        if self.role_prompt:
            self.system_prompt += "\n\n" + self.role_prompt  # The prompt of the agent type of a subagent.
        memory = self._memory_snapshot()
        if memory:
            self.system_prompt += "\n\n" + memory
        self._known_tokens = None

    def set_client(self, client: ModelClient, context_length: int | None = None,
                   image_input: bool | None = None, context_source: str | None = None) -> None:
        self.client = client
        if context_length:
            self.context_length = context_length
            self.context_source = context_source or "default"
        if image_input is not None:
            self.image_input = image_input
            self.ctx.image_input = image_input
            self._sync_preview_tools()
        self._sync_tool_search()  # The context length decides it ("auto").
        self._rebuild_prompt()

    def enable_tasks(self, host: Any) -> None:
        """Add the background task tools. ``host`` is the task host of the session (tasks.py)."""
        from .tools.tasks import task_tools

        self.ctx.tasks = host
        self.tools.update({t.name: t for t in task_tools(self.run_subagent if self.user_facing else None)})
        if self.user_facing:  # A subagent has no user to approve a routine.
            from .tools.routines import routine_tools

            self.tools.update({t.name: t for t in routine_tools()})
        self._sync_agent_tool()
        self._rebuild_prompt()

    def _sync_agent_tool(self) -> None:
        """The "subagents" setting off removes the agent tool. A subagent never has it."""
        from .tools.tasks import AgentTool

        self.tools.pop(AgentTool.name, None)
        if self.user_facing and self.ctx.tasks is not None and self.settings.get("subagents", True) is not False:
            self.tools[AgentTool.name] = AgentTool(self.run_subagent)
        self._known_tokens = None  # The tool schemas are part of the request size.

    def _memory_on(self) -> bool:
        return self.memory is not None and self.settings.get("auto_memory", True) is not False

    def _memory_prompt(self) -> str | None:
        if not self._memory_on():
            return None
        assert self.memory is not None
        return self.memory.prompt(sensitive=self.settings.get("memory_sensitive") is True)

    def _sync_memory_tool(self) -> None:
        """The setting "auto_memory" off removes the memory tool and the memory part of the prompt."""
        self.tools.pop(MemoryTool.name, None)
        if self._memory_on():
            assert self.memory is not None
            self.tools[MemoryTool.name] = MemoryTool(self.memory)
        self._known_tokens = None

    def _memory_snapshot(self) -> str | None:
        """The memory for the system prompt. It is read one time, and again after a compaction or a clear.
        The memory tool changes the files during the session: the model knows these changes already."""
        if not self._memory_on():
            self._memory_text, self._memory_loaded = None, False
            return None
        if not self._memory_loaded:
            self._memory_text, self._memory_loaded = self._memory_prompt(), True
        return self._memory_text

    def memory_changed(self) -> None:
        """The user changed the memory in Settings. The next turn gives the new memory in a note.
        The system prompt keeps the snapshot until the next compaction."""
        memory = self._memory_prompt() if self._memory_on() else None
        if memory != self._memory_text:
            self._harness_notes.append(MEMORY_NOTE.format(memory=memory) if memory else MEMORY_OFF_NOTE)

    def enable_chat_search(self, search: Callable[[str, int], list[dict[str, Any]]]) -> None:
        """The session gives the search of its past sessions. Only the agent that the user talks to gets it."""
        if self.user_facing:
            self.chat_search = search
            self._sync_chat_tool()

    def enable_session_start(self, start: Callable[..., Any]) -> None:
        """The session gives the start of a nested session (tools/sessions.py). Only the agent that the user
        talks to gets it: a subagent has no user to approve the new session."""
        if self.user_facing:
            from .tools.sessions import StartSessionTool

            self.tools[StartSessionTool.name] = StartSessionTool(start)
            self._known_tokens = None

    def enable_session_context(self, note: Callable[[], str | None], read: Callable[[str], str],
                               find: Callable[[str], dict[str, Any] | None], send: Callable[..., Any] | None) -> None:
        """The other sessions of the project: a list note at the start of a turn when the list changed,
        session_read, and offer_session (tools/sessions.py). Only the agent that the user talks to gets them."""
        if not self.user_facing:
            return
        from .tools.sessions import OfferSessionTool, SessionReadTool

        self.session_context = note
        self.tools[SessionReadTool.name] = SessionReadTool(read)
        start = self.tools.get("start_session")
        self.tools[OfferSessionTool.name] = OfferSessionTool(getattr(start, "start", None), send, find)
        self._known_tokens = None

    def _session_note(self) -> str | None:
        """The session list note, when the list changed since the last note in the conversation."""
        if self.session_context is None:
            return None
        try:
            text = self.session_context()
        except Exception:  # noqa: BLE001 - a storage problem must not stop the turn.
            log.exception("The session list note failed")
            return None
        if not text or text == self._told_sessions:
            return None
        self._told_sessions = text
        return text

    def _sync_chat_tool(self) -> None:
        """The setting "chat_search" off removes the conversation_search tool."""
        self.tools.pop(ConversationSearchTool.name, None)
        if self.chat_search is not None and self.settings.get("chat_search", True) is not False:
            self.tools[ConversationSearchTool.name] = ConversationSearchTool(self.chat_search)
        self._known_tokens = None

    def _sync_plan_tool(self) -> None:
        """exit_plan_mode is only for the agent that the user talks to. It stays in the tool list in each
        mode, so that the tool list (a part of the prompt cache) does not change with the mode."""
        self.tools.pop(ExitPlanModeTool.name, None)
        if self.user_facing:
            self.tools[ExitPlanModeTool.name] = ExitPlanModeTool()
        self._known_tokens = None

    async def _ask_user(self, request: dict[str, Any]) -> Any:
        """A question card or a plan card. The reply is a dict, or a text if the turn stopped."""
        return await self.gate.approver(request)

    async def _set_mode(self, mode: str) -> None:
        """The user accepted a plan in this mode. The session saves it and tells the client."""
        if self.on_mode is not None:
            await self.on_mode(mode)
        else:
            self.settings["permission_mode"] = mode
            self._sync_plan_tool()
            self._rebuild_prompt()

    def _sync_web_search(self) -> None:
        """The "web_search" setting "off" removes the web_search tool."""
        if self._web_search is None:
            return
        self.tools.pop(self._web_search.name, None)
        if self.settings.get("web_search") != "off":
            self.tools[self._web_search.name] = self._web_search
        self._known_tokens = None

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
        self._sync_tool_search()
        self._known_tokens = None  # The tool schemas are part of the request size.

    def _deferrable(self) -> list[str]:
        """The MCP tools that the request sends by name only (tool_search), loaded or not.

        The setting "tool_search": "auto" (the default) defers them when their definitions are larger than
        TOOL_SEARCH_TOKENS or TOOL_SEARCH_SHARE of the context, "on" always, "off" never.
        """
        mode = str(self.settings.get("tool_search") or "auto").lower()
        mcp = [n for n in self.tools if n.startswith("mcp__")]
        if not mcp or mode == "off":
            return []
        if mode != "on":
            size = estimate_tokens([self.tools[n].schema(self.ctx) for n in mcp])
            if size <= min(TOOL_SEARCH_TOKENS, self.context_length * TOOL_SEARCH_SHARE):
                return []
        return mcp

    def _sync_tool_search(self) -> None:
        if self._deferrable():
            self.tools.setdefault(self._tool_search.name, self._tool_search)
        else:
            self.tools.pop(self._tool_search.name, None)

    def _load_tools(self, names: list[str]) -> None:
        self._loaded_tools.extend(n for n in names if n not in self._loaded_tools)
        self._known_tokens = None  # The loaded tools make the next request larger.

    def _sent_tool_names(self) -> list[str]:
        """The tools of the request. With tool search, the MCP tools that the model loaded come at the end,
        in the order of the loads: the start of the request stays the same."""
        deferrable = set(self._deferrable())
        if not deferrable:
            return list(self.tools)
        return [n for n in self.tools if n not in deferrable] + [n for n in self._loaded_tools if n in deferrable]

    def mcp_tools(self) -> list[Tool]:
        return [t for n, t in self.tools.items() if n.startswith("mcp__")]

    def _set_plugin_tools(self, host: PluginHost | None) -> None:
        for name in self._plugin_tools:
            self.tools.pop(name, None)
        self.plugins = host
        self.hooks = host.hooks if host is not None else Hooks()
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
        self.ctx.read_roots = tuple(s.dir for s in self.skills.values())
        self.tools.pop(SkillTool.name, None)
        if any(s.model_invocable for s in self.skills.values()):
            tool = SkillTool(self.skills, self._activate_skill, self.run_fork)
            self.tools[tool.name] = tool
        self._rebuild_prompt()

    def reload_settings(self, settings: dict[str, Any]) -> None:
        """Use changed settings, for example "auto_verify" from the client."""
        if settings.get("memory_sensitive") != self.settings.get("memory_sensitive"):
            self._memory_loaded = False  # The memory part of the prompt has other rules now.
        self.settings.clear()
        self.settings.update(settings)
        self._sync_agent_tool()
        self._sync_web_search()
        self._sync_plan_tool()
        self._sync_memory_tool()
        self._sync_chat_tool()
        self._sync_tool_search()
        self._rebuild_prompt()

    def clear(self) -> None:
        """Start a new context: no history and no summary."""
        self.history.clear()
        self.summary = None
        self._memory_loaded = False
        self._told_plan = False
        self._told_sessions = None
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
                                              list(self.skills.values()), self._plugin_sections(),
                                              user_facing=self.user_facing):
            sizes[kind] += text_tokens(text)
        memory = self._memory_snapshot()
        if memory:
            sizes["instructions"] += text_tokens(memory)
        names = self._sent_tool_names()
        schemas = [self.tools[n].schema(self.ctx) for n in names]
        mcp = [s for name, s in zip(names, schemas) if name.startswith("mcp__") or name == self._tool_search.name]
        plugin = [s for name, s in zip(names, schemas) if name in self._plugin_tools]
        builtin = [s for name, s in zip(names, schemas)
                   if not name.startswith("mcp__") and name != self._tool_search.name and name not in self._plugin_tools]
        sizes["tools"] = estimate_tokens(builtin) if builtin else 0
        sizes["mcp_tools"] = estimate_tokens(mcp) if mcp else 0
        sizes["plugins"] += estimate_tokens(plugin) if plugin else 0
        # The messages of the turns, without the system prompt. The tool results are a part of their own.
        sent = self.messages()[1:]
        results = [m for m in sent if m.get("role") == "tool"]
        talk = [m for m in sent if m.get("role") != "tool"]
        sizes["messages"] = estimate_tokens(talk) if talk else 0
        sizes["tool_results"] = estimate_tokens(results) if results else 0
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
        replay = getattr(self.client, "replays_reasoning", False)
        history: list[dict[str, Any]] = []
        for i, m in enumerate(self.history):
            clean = ({k: v for k, v in m.items() if k not in CLIENT_ONLY_FIELDS}
                     if any(k in m for k in CLIENT_ONLY_FIELDS) else m)
            if m.get("role") == "assistant":
                if replay and "reasoning_content" not in clean:
                    # DeepSeek needs the field on each reply. A reply of another model has no reasoning.
                    clean = {**clean, "reasoning_content": ""}
                elif not replay and "reasoning_content" in clean:
                    clean = {k: v for k, v in clean.items() if k != "reasoning_content"}
            if m.get("role") == "user" and m.get("images"):
                clean = self._with_images(clean, m["images"])
            if (m.get("origin") == "harness" and history and history[-1].get("role") == "user"
                    and isinstance(clean.get("content"), str)):
                # One user message: some chat templates reject two user messages in sequence.
                before = history[-1].get("content")
                if isinstance(before, str):
                    history[-1] = {**history[-1], "content": before + "\n\n" + clean["content"]}
                    continue
                if isinstance(before, list):  # A message with images: the note is one more text part.
                    history[-1] = {**history[-1], "content": [*before, {"type": "text", "text": clean["content"]}]}
                    continue
            history.append(clean)
            last_result = i + 1 == len(self.history) or self.history[i + 1].get("role") != "tool"
            if image_at is not None and i >= image_at and last_result:
                image = self.history[image_at]
                history.append({"role": "user", "content": [
                    {"type": "text", "text": IMAGE_MESSAGE.format(tool=self._tool_name(image["tool_call_id"]))},
                    {"type": "image_url", "image_url": {"url": image["image"]}},
                ]})
                image_at = None
        return [{"role": "system", "content": self.system_prompt}, *history]

    def _with_images(self, message: dict[str, Any], images: list[str]) -> dict[str, Any]:
        """A user message with the images that the user pasted, for the model."""
        text = message.get("content") or ""
        if not self.image_input:
            note = NO_IMAGE_NOTE.format(count=len(images))
            return {**message, "content": f"{text}\n\n{note}" if text else note}
        parts: list[dict[str, Any]] = [{"type": "text", "text": text or "(The user sent images.)"}]
        parts += [{"type": "image_url", "image_url": {"url": url}} for url in images]
        return {**message, "content": parts}

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
        return [self.tools[n].schema(self.ctx) for n in self._sent_tool_names()]

    async def run_turn(self, text: str, *, display: str | None = None, allow: tuple[str, ...] = (),
                       message_id: str | None = None, origin: str | None = None,
                       images: list[str] | None = None) -> str:
        """Run one user turn. Return the stop reason.

        ``display`` is the text that the client shows for the user message, for example
        "/review src" when ``text`` holds the skill instructions. ``allow`` holds rules
        that apply for this turn only, for example the allowed-tools of a skill.

        ``origin`` "task": the message is a note of a background task, not a message of the user.
        ``images``: data URLs that the user pasted. A model with image input gets them.

        Stop reasons: ``end``, ``max_tool_calls``, ``denied``, ``interrupted``, ``error``.
        """
        text = (await self.hooks.emit("turn.start", TurnEvent(text, self.cwd))).text
        if self.user_facing and origin != "task" and self.command_hooks is not None:
            hooked = await self._prompt_hooks(text)
            if hooked is None:
                usage0 = {"prompt_tokens": 0, "completion_tokens": 0, "last_prompt_tokens": 0}
                await self.emit({"type": "turn.end", "usage": self._usage(usage0), "stop_reason": "blocked"})
                return "blocked"
            if hooked != text:
                display = display or text
                text = hooked
        message = user_message(text, display, message_id, origin)
        if images:
            message["images"] = list(images)
        self.history.append(message)
        self.message_id = message["id"]
        self._turn_start = len(self.history) - 1  # The plan reminders look at the calls of this turn.
        self._plan_nudged = False
        self.gate.turn_allow = list(allow)
        self.turn_number += 1
        turn = self.turn_number
        step = 0
        continuations = 0
        stop_hooks = 0  # The times that a Stop hook made the turn continue.
        new_messages = [message]  # The new user messages of the next step, for step.before.
        self.in_turn = True
        self._cancel_turn = False
        self._repeat_counts = {}
        stall_nudges = 0  # The times that the turn continued after a reply with a plan and no tool call.
        usage ={"prompt_tokens": 0, "completion_tokens": 0, "last_prompt_tokens": 0}
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
                steered = await self._take_user_steer()
                new_messages += steered
                notes = self._step_notes(step)
                plan_note = self._plan_note(step, any(m.get("origin") != "task" for m in steered), calls_used, origin)
                if plan_note:
                    notes.append(plan_note)
                new_messages += [self._add_harness_note(t) for t in notes]
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
                if response.reasoning:
                    message["reasoning_content"] = response.reasoning
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
                    if self.user_steer:
                        continue  # The user steered the turn during this step: the model reads the message.
                    # A reply that says what the model will do now, with no tool call: ask it to do the step.
                    if self.tools and stall_nudges < MAX_STALL_NUDGES and is_stall(response.text):
                        stall_nudges += 1
                        new_messages = [self._add_harness_note(STALL_NUDGE)]
                        await self.emit({"type": "notice", "level": "info", "text": STALL_NOTICE})
                        continue
                    # turn.stopping handlers can add messages: then the turn continues.
                    if self.hooks.has("turn.stopping") and continuations < MAX_STEER_CONTINUATIONS:
                        stopping = await self.hooks.emit("turn.stopping", TurnStoppingEvent(turn, self.cwd))
                        if stopping.steered:
                            continuations += 1
                            new_messages = [self._add_steered(t) for t in stopping.steered]
                            continue
                    # A Stop hook of the settings can make the agent continue.
                    if (self.user_facing and self.command_hooks is not None and stop_hooks < MAX_STEER_CONTINUATIONS
                            and self.command_hooks.has("Stop")):
                        outcome = await self.command_hooks.run("Stop", {"stop_hook_active": stop_hooks > 0,
                                                                        "permission_mode": self._mode()})
                        await self._hook_errors(outcome)
                        if outcome.blocked:
                            stop_hooks += 1
                            new_messages = [self._add_steered(f"A Stop hook asks you to continue: {outcome.blocked}")]
                            continue
                    break

                open_calls = list(response.tool_calls)
                while open_calls:
                    call = open_calls[0]
                    if calls_used >= max_calls and self.settings.get("limit_tool_calls", True) is not False:
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
                    self._add_tool_result(call["id"], result.output, result.is_error, result.diff, result.image,
                                          result.created, result.card)
                    open_calls.pop(0)
                    if result is _DENIED_RESULT or result.stop_turn:
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
        await self._return_user_steer()
        await self.hooks.emit("turn.end", TurnEvent(text, self.cwd, stop))
        await self.emit({"type": "turn.end", "usage": self._usage(usage), "stop_reason": stop})
        return stop

    # -- the hooks of the settings files (hooks.py) ----------------------------------------------------

    def _mode(self) -> str:
        return str(self.settings.get("permission_mode") or "default")

    async def _hook_errors(self, outcome: HookOutcome) -> None:
        for error in outcome.errors:
            await self.emit({"type": "notice", "level": "warning", "text": error})

    async def _prompt_hooks(self, text: str) -> str | None:
        """SessionStart (before the first prompt) and UserPromptSubmit. None: a hook blocked the prompt."""
        hooks = self.command_hooks
        assert hooks is not None
        context: list[str] = []
        if not any(m.get("role") == "user" for m in self.history) and hooks.has("SessionStart"):
            start = await hooks.run("SessionStart", {"source": "startup", "permission_mode": self._mode()})
            await self._hook_errors(start)
            context += start.context
        if hooks.has("UserPromptSubmit"):
            submit = await hooks.run("UserPromptSubmit", {"prompt": text, "permission_mode": self._mode()})
            await self._hook_errors(submit)
            if submit.blocked:
                await self.emit({"type": "error", "message": f"A UserPromptSubmit hook blocked the prompt: {submit.blocked}"})
                return None
            context += submit.context
        if not context:
            return text
        return text + "\n\n" + "\n\n".join(f"<hook-context>\n{c}\n</hook-context>" for c in context)

    async def _tool_hooks(self, event: str, name: str, args: dict[str, Any],
                          result: ToolResult | None = None) -> HookOutcome | None:
        hooks = self.command_hooks
        if hooks is None or not hooks.has(event):
            return None
        tool_input = dict(args)
        if isinstance(args.get("path"), str):
            try:
                tool_input.setdefault("file_path", str(self.ctx.resolve(args["path"], read_only=True)))
            except ToolError:
                pass
        payload: dict[str, Any] = {"tool_input": tool_input, "permission_mode": self._mode()}
        if result is not None:
            payload["tool_response"] = {"output": result.output, "is_error": result.is_error}
        outcome = await hooks.run(event, payload, name)
        await self._hook_errors(outcome)
        return outcome

    # -- plugin events of the loop ----------------------------------------------------------------

    def _checkpoint(self, args: dict[str, Any]) -> None:
        """Keep the content of the file before an edit or write tool changes it."""
        if self.on_checkpoint is None or self.message_id is None:
            return
        try:
            path = self.ctx.resolve(args.get("path"))
        except ToolError:
            return  # The tool gives the error.
        try:
            content: bytes | None = path.read_bytes()
        except FileNotFoundError:
            content = None
        except OSError:
            return
        self.on_checkpoint(self.message_id, relpath(self.cwd, path), content)

    def rewind(self, index: int) -> None:
        """Remove the history from ``index``: a user message and all after it."""
        self.history = self.history[:index]
        self._known_tokens = None

    def steer(self, steer_id: str, text: str, display: str | None = None, origin: str | None = None) -> bool:
        """Add a user message to the running turn. The model reads it at the next step.

        Return False if no turn runs: the client then sends the message as a prompt.
        """
        if not self.in_turn:
            return False
        self.user_steer.append((steer_id, text, display, origin))
        return True

    async def _take_user_steer(self) -> list[dict[str, Any]]:
        taken, self.user_steer = self.user_steer, []
        messages: list[dict[str, Any]] = []
        for steer_id, text, display, origin in taken:
            message = user_message(text, display, steer_id, origin)
            self.history.append(message)
            self.message_id = steer_id
            messages.append(message)
            event: dict[str, Any] = {"type": "steer.taken", "id": steer_id, "text": display or text}
            if origin:
                event["origin"] = origin
            await self.emit(event)
        return messages

    async def _return_user_steer(self) -> None:
        """The turn ended before the next step. The client sends the messages as prompts."""
        left, self.user_steer = self.user_steer, []
        notes = [(text, display or text) for _, text, display, origin in left if origin == "task"]
        if notes and self.on_notes_returned is not None:
            self.on_notes_returned(notes)
        ids = [steer_id for steer_id, _, _, origin in left if origin != "task"]
        if ids:
            await self.emit({"type": "steer.returned", "ids": ids})

    def _add_steered(self, text: str) -> dict[str, Any]:
        """Add a user message from a plugin. The client shows it as a notice."""
        message = {"role": "user", "content": text}
        self.history.append(message)
        asyncio.ensure_future(self.emit({"type": "notice", "level": "info", "text": f"A plugin added a message: {text}"}))
        return message

    def _step_notes(self, step: int) -> list[str]:
        """The harness notes for the next step: plan mode (at the start of each turn in plan mode, and
        when the mode changes) and the notes that wait, for example a memory change."""
        notes, self._harness_notes = self._harness_notes, []
        plan = self.settings.get("permission_mode") == "plan"
        if plan and (step == 1 or not self._told_plan):
            notes.insert(0, PLAN_ON_NOTE)
        elif not plan and self._told_plan:
            notes.insert(0, PLAN_OFF_NOTE)
        self._told_plan = plan
        if step == 1:
            sessions = self._session_note()
            if sessions:
                notes.append(sessions)
        return notes

    def _plan_calls(self, start: int = 0) -> list[list[dict[str, Any]]]:
        """The step lists of the update_plan calls in the history after ``start``, oldest first."""
        plans: list[list[dict[str, Any]]] = []
        for m in self.history[start:]:
            for call in m.get("tool_calls") or [] if m.get("role") == "assistant" else []:
                fn = call.get("function") or {}
                if fn.get("name") != "update_plan":
                    continue
                try:
                    items = json.loads(fn.get("arguments") or "{}").get("items")
                except (ValueError, AttributeError):
                    continue
                if isinstance(items, list):
                    plans.append([i for i in items if isinstance(i, dict)])
        return plans

    def _plan_note(self, step: int, steered: bool, calls: int, origin: str | None) -> str | None:
        """A reminder to show and update the task list (update_plan), as Claude Code does:

        - a new prompt of the user while the last plan has steps that are not completed,
        - a message of the user during the turn (a steer), when a plan exists,
        - three tool calls in a turn with no plan (one time in the turn),
        - each PLAN_STALE_CALLS tool calls in a turn with no plan update while the plan has open steps.
          Some models finish many steps and then mark them all completed at the end.
        """
        if not self.user_facing or "update_plan" not in self.tools or origin == "task":
            return None
        plans = self._plan_calls()
        last = plans[-1] if plans else None
        open_steps = [str(i.get("content") or "") for i in last or [] if i.get("status") != "completed"]
        in_turn = self._plan_calls(self._turn_start)
        if steered and last is not None:
            return PLAN_STEER_NOTE
        if step == 1 and open_steps:
            return PLAN_OPEN_NOTE.format(steps="; ".join(open_steps[:6]))
        if not in_turn and calls >= PLAN_NUDGE_CALLS and not self._plan_nudged:
            self._plan_nudged = True
            return PLAN_START_NOTE
        if open_steps:
            stale = self._stale_plan_note()
            if stale:
                return stale
        return None

    def _stale_plan_note(self) -> str | None:
        """PLAN_STALE_NOTE after each PLAN_STALE_CALLS tool calls in the turn since the last update_plan."""
        last = self._turn_start
        for i in range(len(self.history) - 1, self._turn_start, -1):
            m = self.history[i]
            if m.get("role") == "assistant" and any(
                    (c.get("function") or {}).get("name") == "update_plan" for c in m.get("tool_calls") or []):
                last = i
                break
        since = sum(1 for m in self.history[last + 1:] if m.get("role") == "assistant"
                    for c in m.get("tool_calls") or []
                    if (c.get("function") or {}).get("name") not in ("update_plan", "wrap_up"))
        index, sent = self._stale_nudges if self._stale_nudges[0] == last else (last, 0)
        if since < PLAN_STALE_CALLS * (sent + 1):
            return None
        self._stale_nudges = (index, sent + 1)
        return PLAN_STALE_NOTE.format(calls=since)

    def _add_harness_note(self, text: str) -> dict[str, Any]:
        """Add a user message from the loop guards. The client does not show it in the chat."""
        message = {"role": "user", "content": text, "origin": "harness"}
        self.history.append(message)
        return message

    def _rename_call(self, call_id: str, name: str) -> None:
        """Put the repaired tool name in the history, for servers that check the names."""
        for m in reversed(self.history):
            for call in m.get("tool_calls") or []:
                if call["id"] == call_id:
                    call["function"]["name"] = name
                    return

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
        """request.before handlers can change the model and the call options of one model call.
        The "effort" setting (the model menu) gives reasoning_effort. No setting: High, as in the Claude app."""
        client = self.client
        effort = EFFORT_API.get(str(self.settings.get("effort") or DEFAULT_EFFORT), EFFORT_API[DEFAULT_EFFORT])
        if not self.hooks.has("request.before"):
            return client, {"reasoning_effort": effort} if effort else {}
        event = await self.hooks.emit("request.before", RequestEvent(
            turn, step, client.provider.name, client.model, self.cwd, reasoning_effort=effort))
        options = {"temperature": event.temperature, "max_tokens": event.max_tokens, "stop": event.stop,
                   "reasoning_effort": event.reasoning_effort}
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
                return await client.stream(self.messages(), self.tool_schemas(), on_text, options=options,
                                           on_reasoning=lambda: self.emit({"type": "thinking"}))
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

    def _subagent(self, emit: Emit, allow: list[str], approver: Approver | None = None,
                  kind: AgentType | None = None) -> "Agent":
        """A subagent with a new context, the tools of this agent, and no agent tool of its own.

        ``kind``: the agent type (agents.py). It gives the prompt, the tools, and the model of the subagent.
        """
        client = self.client
        if kind is not None and kind.model:
            try:
                client = ModelClient(*resolve_model(kind.model))
            except ConfigError as e:
                raise ModelError(f"The agent type {kind.name} uses the model {kind.model}: {e}") from None
        sub = Agent(
            cwd=self.cwd, client=client, emit=emit, approver=approver or self.gate.approver,
            settings=self.settings, context_length=self.context_length,
            session_allow=allow, read_roots=self.ctx.read_roots,
            image_input=self.image_input, plugins=self.plugins, user_facing=False,
        )
        if self.ctx.preview is not None:
            sub.enable_preview(self.ctx.preview)
        sub.set_mcp_tools(self.mcp_tools())
        # Auto mode checks the calls of the subagent with the messages of the user in this session.
        sub.gate.auto = self.gate.auto
        if kind is not None:
            for name in [n for n in sub.tools if not kind.allows(n)]:
                del sub.tools[name]
            if kind.prompt:
                sub.role_prompt = kind.prompt
                sub._rebuild_prompt()
        return sub

    @staticmethod
    def _report(sub: "Agent") -> str | None:
        return next((m["content"] for m in reversed(sub.history)
                     if m.get("role") == "assistant" and m.get("content")), None)

    def _forward(self, label: str) -> Emit:
        async def forward(event: dict[str, Any]) -> None:
            if event["type"] not in SUBAGENT_HIDDEN_EVENTS:
                await self.emit({**event, "agent": label})
        return forward

    async def run_fork(self, skill: Skill, args: str) -> str:
        """Run a skill in a subagent with a new context. Return the report of the subagent."""
        sub = self._subagent(self._forward(skill.name), list(skill.allowed_tools))
        prompt = f"{render_skill(skill, args, self.cwd)}\n\n{FORK_REPORT_REQUEST}"
        stop = await sub.run_turn(prompt)
        if stop == "interrupted":
            raise asyncio.CancelledError()
        report = self._report(sub)
        if stop == "error" and not report:
            raise ModelError(f"The skill {skill.name} failed in its subagent.")
        return report or f"The skill {skill.name} ended with no report (stop reason: {stop})."

    async def run_subagent(self, prompt: str, description: str, background: bool,
                           agent_type: str = DEFAULT_AGENT_TYPE) -> str:
        """The agent tool: run a task in a subagent with a new context.

        In the foreground, return its report. In the background, start a task (tasks.py) and return
        at once: the report comes to this agent as a note when the subagent ends.
        """
        label = description.strip() or "subagent"
        types = discover_agents(self.cwd)
        kind = types.get(agent_type) or next((t for n, t in types.items() if n.lower() == agent_type.lower()), None)
        if kind is None:
            raise ModelError(f"Unknown agent type: {agent_type}. The types are: {', '.join(types)}.")
        text = f"{prompt.strip()}\n\n{FORK_REPORT_REQUEST}"
        if not background:
            sub = self._subagent(self._forward(label), [], kind=kind)
            stop = await sub.run_turn(text)
            if stop == "interrupted":
                raise asyncio.CancelledError()
            report = self._report(sub)
            if stop == "error" and not report:
                raise ModelError(f"The subagent ({label}) failed.")
            return report or f"The subagent ended with no report (stop reason: {stop})."

        host = self.ctx.tasks
        if host is None:
            raise ModelError("Background agents are not available here. Run the agent without run_in_background.")

        async def job(task: Any) -> int:
            async def log(event: dict[str, Any]) -> None:
                # The task output shows the steps of the subagent. The chat does not show them.
                if event["type"] == "tool.start":
                    task.append(f"> {event.get('name')}: {_short(event.get('input'))}\n")
                elif event["type"] == "error":
                    task.append(f"[Error: {event.get('message')}]\n")

            async def approve(request: dict[str, Any]) -> str:
                # The card stays open after the turn of the main agent ends.
                return await self.gate.approver({**request, "agent": label, "background": True})

            sub = self._subagent(log, [], approve, kind)
            stop = await sub.run_turn(text)
            report = self._report(sub) or f"(no report, stop reason: {stop})"
            task.result = report
            task.append(f"\n{report}\n")
            return 0 if stop == "end" else 1

        from .tasks import TaskError

        try:
            task = host.start_job("agent", prompt.strip(), label, job)
        except TaskError as e:
            raise ModelError(str(e)) from e
        return task.id

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
                self._memory_loaded = False  # A new prompt cache starts here: the memory can be new.
                self._told_sessions = None  # The summary replaced the session list note.
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
                         image: str | None = None, created: list[str] | None = None,
                         card: dict[str, Any] | None = None) -> None:
        # ts: the end time of the call, for the step times of the task list in the client.
        message = {"role": "tool", "tool_call_id": call_id, "content": output, "is_error": is_error, "ts": time.time()}
        if diff:
            message["diff"] = diff
        if image:
            message["image"] = image
        if created:
            message["created"] = list(created)
        if card:
            message["card"] = card
        self.history.append(message)

    def _close_open_calls(self, open_calls: list[dict[str, str]], output: str) -> None:
        for call in open_calls:
            self._add_tool_result(call["id"], output, True)
        open_calls.clear()

    async def _run_tool_call(self, call: dict[str, str]) -> ToolResult:
        call_id, called = call["id"], call["name"]
        name = repair_tool_name(called, self.tools) or called  # For example "Bash" or "read_file".
        if name != called:
            self._rename_call(call_id, name)
        args, parse_error = _parse_arguments(call["arguments"])
        await self.emit({"type": "tool.start", "id": call_id, "name": name, "input": args if args is not None else call["arguments"]})

        # The new PDF and Word files of the call get a card in the chat (created.py).
        snapshot = await asyncio.to_thread(before_call, self.cwd, name, args) if args is not None else None
        result = await self._execute(name, args, parse_error, call_id)
        if result is not _DENIED_RESULT:
            result.output = truncate(result.output, int(self.settings["max_output_chars"]))
            if snapshot is not None:
                result.created = await asyncio.to_thread(created_files, self.cwd, snapshot, result.changed_paths)
            key = repeat_key(name, args, result.output)
            self._repeat_counts[key] = self._repeat_counts.get(key, 0) + 1
            notes = [repaired_note(called, name)] if name != called else []
            repeat = repeat_note(name, self._repeat_counts[key])
            if repeat:
                notes.append(repeat)
            if notes:
                result.output = "\n\n".join([result.output, *notes]) if result.output else "\n\n".join(notes)
        event = {"type": "tool.result", "id": call_id, "output": result.output, "is_error": result.is_error}
        if result.diff:
            event["diff"] = result.diff
        if result.image:
            event["image"] = result.image
        if result.created:
            event["created"] = result.created
        if result.card:
            event["card"] = result.card
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
        ran = False
        try:
            tool.validate(args)
            approval = await tool.prepare(args, self.ctx)
            pre = await self._tool_hooks("PreToolUse", name, args)
            if pre is not None and pre.blocked:
                call.result = ToolResult(f"A PreToolUse hook blocked this tool call: {pre.blocked}", is_error=True)
            else:
                if pre is not None and pre.decision == "allow" and call.asked is None:
                    # The hook allows the call with no question. A deny rule still denies it.
                    allowed: bool | str = not (approval is not None and self.gate.rules.denies(
                        approval.tool or tool.name, approval.key))
                else:
                    asked = call.asked or ("A PreToolUse hook asks for approval." if pre is not None and pre.decision == "ask" else None)
                    allowed = await self.gate.check(tool, args, approval, force=asked)
                if isinstance(allowed, str):  # The permission mode blocked the action. The turn continues.
                    return ToolResult(allowed, is_error=True)
                if not allowed:
                    return _DENIED_RESULT
                if name in FILE_TOOLS:
                    self._checkpoint(args)
                call.result = await tool.run(args, self.ctx)
                ran = True
        except ToolError as e:
            call.result = ToolResult(str(e), is_error=True)
        except OSError as e:
            call.result = ToolResult(f"{type(e).__name__}: {e}", is_error=True)
        except Exception as e:  # noqa: BLE001 - a tool bug gives an error result. The turn continues.
            log.exception("The tool %s failed", name)
            call.result = ToolResult(f"The tool failed: {type(e).__name__}: {e}", is_error=True)
        if ran and isinstance(call.result, ToolResult):
            post = await self._tool_hooks("PostToolUse", name, args, call.result)
            if post is not None:
                if post.blocked:
                    call.result.output += f"\n\n[A PostToolUse hook says: {post.blocked}]"
                call.contexts.extend(post.context)
        call = await self.hooks.emit("tool.after", call)
        self._step_contexts.extend(call.contexts)
        return call.result if isinstance(call.result, ToolResult) else ToolResult(str(call.result))


_DENIED_RESULT = ToolResult(DENIED, is_error=True)


def _short(value: Any, limit: int = 120) -> str:
    """A short one-line form of tool arguments, for the output of a background agent."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit] + "..."


def user_message(text: str, display: str | None, message_id: str | None,
                 origin: str | None = None) -> dict[str, Any]:
    """A user message of the history. The id and the time are for the client: rewind and fork use the id.
    ``origin`` "task": the note of a background task. The client shows it as a notification."""
    message: dict[str, Any] = {"role": "user", "content": text}
    if display is not None:
        message["display"] = display
    if origin:
        message["origin"] = origin
    message["id"] = message_id or uuid.uuid4().hex
    message["ts"] = time.time()
    return message

PLAN_ON_NOTE = (
    "[Harness: Plan mode is on. Do not change files. Read and search the project, and ask the user with "
    "ask_user_question if a choice is not clear. Then call exit_plan_mode with the plan: the steps, and "
    "the files that each step changes. The user accepts the plan (then you start the work), asks for "
    "changes, or rejects it.]")
# The task list reminders (_plan_note).
PLAN_NUDGE_CALLS = 3
PLAN_START_NOTE = ("[Harness: This task has more than one step, and you showed no task list. Call update_plan "
                   "now with the whole plan, and keep it current while you work.]")
PLAN_STEER_NOTE = ("[Harness: The user sent a message during your work. If it changes the work, call update_plan "
                   "with the new whole list first: keep the steps that still apply, add the new work, and mark the "
                   "finished steps completed.]")
PLAN_OPEN_NOTE = ("[Harness: The task list under your last message has steps that are not completed: {steps}. If "
                  "the new message continues or changes this work, call update_plan with the new whole list first. "
                  "If it is a short question, answer it.]")
PLAN_STALE_CALLS = 8
PLAN_STALE_NOTE = ("[Harness: You made {calls} tool calls since your last update_plan. When a step finishes, call "
                   "update_plan at once with that step completed and the next step in_progress. Do not wait to "
                   "mark many steps completed at the end. If the current step is still in progress, continue.]")
PLAN_OFF_NOTE = "[Harness: Plan mode is off. You can change files again. Stay in the scope of the request.]"
MEMORY_NOTE = ("[Harness: The user changed the memory in Settings. This memory replaces the memory in the "
               "system prompt.]\n\n{memory}")
MEMORY_OFF_NOTE = "[Harness: The user turned off or cleared the memory. Do not use the memory in the system prompt.]"


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
