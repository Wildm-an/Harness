"""The plugin host: it loads the plugin rows of one session and keeps what they register.

This is a Python port of the plugin model of DeepSeek Harness (Cordis):

- A plugin is a Python module with ``apply(ctx, config)``. It can also declare ``inject`` (the
  services that it needs), ``provide`` (the services that it gives to other plugins), and
  ``Config`` (the default values of its configuration).
- The plugin registers everything in code, with the services of ``ctx``: ``ctx.tools``,
  ``ctx.commands``, ``ctx.skills``, ``ctx.prompt``, ``ctx.hooks``, ``ctx.mcp``, and ``ctx.providers``.
- Each registration returns a disposer. The host keeps the disposers of each plugin. When the
  host unloads a plugin, it calls them in the reverse order. Thus a plugin needs no cleanup code.
  ``ctx.effect(fn)`` adds a disposer for other resources, for example a thread or a file.
- A plugin activates when all the services of its ``inject`` list exist. The row order does not
  set the load order.

Plugin code runs in the daemon process, with the same rights as the daemon. It is not in a sandbox.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import inspect
import json
import logging
import re
import sys
import traceback
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..config import ConfigError, harness_home
from ..providers import register_plugin_provider
from ..tools.base import Approval, Tool, ToolContext, ToolError, ToolResult
from .install import Installed, bundle_layers, installed_bundles
from .manifest import Bundle, icon_data
from .patch import Layer, Row, compose, project_patch_path, read_patch_file, user_patch_path

log = logging.getLogger("harness.plugins")

Disposer = Callable[[], Any]

EVENTS = ("tool.before", "tool.after", "turn.start", "turn.end", "turn.stopping", "step.before",
          "request.before", "request.error", "stream.text", "stream.end")
BUILTIN_SERVICES = ("tools", "commands", "skills", "prompt", "hooks", "mcp", "providers")
TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
COMMAND_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
RESERVED_TOOL_PREFIXES = ("mcp__", "preview_")
PACKAGE = "harness_plugins"


class PluginError(Exception):
    """A plugin used the API in a wrong way. The message tells the plugin author what to change."""


# -- the values that plugins get and return --------------------------------------------------------


@dataclass
class ToolCall:
    """The event of ``tool.before`` and ``tool.after``.

    ``tool.before`` handlers can change ``args``, or call ``block(reason)`` to stop the call.
    ``tool.after`` handlers can read or replace ``result``.
    """

    name: str
    args: dict[str, Any]
    cwd: Path
    result: ToolResult | None = None
    blocked: str | None = None
    asked: str | None = None  # ``ask(reason)``: the user approves the call, also if a rule allows it.
    contexts: list[str] = field(default_factory=list)  # User messages to add after the tool results.
    call_id: str = ""
    cancelled: bool = False  # ``block(reason, cancel=True)``: the turn stops after this call.

    def block(self, reason: str, cancel: bool = False) -> None:
        self.blocked = reason or "A plugin blocked the tool call."
        self.cancelled = cancel

    def ask(self, reason: str = "") -> None:
        self.asked = reason or "A plugin asks for approval."

    def add_context(self, text: str) -> None:
        """Add a user message after the tool results of this step."""
        if text:
            self.contexts.append(text)


@dataclass
class TurnEvent:
    """The event of ``turn.start`` (``text`` can change) and ``turn.end`` (``stop`` is the stop reason)."""

    text: str
    cwd: Path
    stop: str | None = None


@dataclass
class StepEvent:
    """The event of ``step.before``: it runs before each model call of a turn.

    ``messages`` are the new user messages of the step (the prompt at step 1, and messages from
    ``turn.stopping`` later). A handler can change them, or call ``reject(reason)`` to end the turn.
    """

    turn: int
    step: int
    messages: list[str]
    cwd: Path
    blocked: str | None = None

    def reject(self, reason: str = "") -> None:
        self.blocked = reason or "A plugin ended the turn."


@dataclass
class RequestEvent:
    """The event of ``request.before``: the model call. A handler can change these values."""

    turn: int
    step: int
    provider: str
    model: str
    cwd: Path
    temperature: float | None = None
    max_tokens: int | None = None
    stop: list[str] | None = None
    reasoning_effort: str | None = None


@dataclass
class RequestErrorEvent:
    """The event of ``request.error``: the model call failed. A handler can set ``retry``."""

    turn: int
    step: int
    provider: str
    error: str
    cwd: Path
    attempt: int = 1
    retry: bool = False


@dataclass
class TurnStoppingEvent:
    """The event of ``turn.stopping``: the turn is about to end. ``steer(text)`` adds a user message,
    and the turn continues with another model call."""

    turn: int
    cwd: Path
    steered: list[str] = field(default_factory=list)

    def steer(self, text: str) -> None:
        if text:
            self.steered.append(text)


@dataclass
class StreamEvent:
    """The events ``stream.text`` (one chunk of the reply) and ``stream.end`` (the reply is complete)."""

    turn: int
    step: int
    text: str
    cwd: Path


@dataclass
class Prompt:
    """A command handler returns a Prompt to send text to the agent as a user turn."""

    text: str


@dataclass
class Invocation:
    """What a command handler gets: the command name, the text after the name, and the project folder."""

    name: str
    args: str
    cwd: Path
    session_id: str | None = None


@dataclass
class Command:
    name: str
    description: str
    handler: Callable[[Invocation], Any]
    argument_hint: str
    plugin: str  # The row id.


class PluginTool(Tool):
    """A tool that a plugin registered with a function."""

    def __init__(self, name: str, description: str, parameters: dict[str, Any], run: Callable[..., Any],
                 needs_approval: bool, plugin: str):
        self.name = name
        self.description = description
        self.parameters = parameters
        self.needs_approval = needs_approval
        self.plugin = plugin
        self._run = run

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval | None:
        if not self.needs_approval:
            return None
        return Approval(key=json.dumps(args, sort_keys=True, ensure_ascii=False)[:500], rule=self.name)

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        try:
            value = await _maybe_await(self._run(args, ctx))
        except ToolError:
            raise
        except Exception as e:  # noqa: BLE001 - a plugin bug must not stop the turn.
            log.exception("The plugin tool %s failed", self.name)
            return ToolResult(f"The plugin tool failed: {type(e).__name__}: {e}", is_error=True)
        return to_result(value)


def to_result(value: Any) -> ToolResult:
    if isinstance(value, ToolResult):
        return value
    if value is None:
        return ToolResult("Done.")
    if isinstance(value, str):
        return ToolResult(value)
    return ToolResult(json.dumps(value, indent=2, ensure_ascii=False, default=str))


def object_schema(parameters: dict[str, Any] | None) -> dict[str, Any]:
    """A JSON schema for the tool arguments.

    A full schema (``{"type": "object", ...}``) stays the same. The short form is a dict of
    argument names, as in DeepSeek Harness: ``{"name": {"type": "string", "required": True}}``.
    """
    if not parameters:
        return {"type": "object", "properties": {}}
    if parameters.get("type") == "object":
        return parameters
    properties: dict[str, Any] = {}
    required: list[str] = []
    for key, spec in parameters.items():
        spec = dict(spec) if isinstance(spec, dict) else {"type": spec}
        if spec.pop("required", False):
            required.append(key)
        properties[key] = spec
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


# -- the hook bus -----------------------------------------------------------------------------------


class Hooks:
    """The event handlers of all plugins. Handlers run in the order of registration."""

    def __init__(self) -> None:
        self._handlers: dict[str, list[Callable[[Any], Any]]] = {e: [] for e in EVENTS}

    def add(self, event: str, fn: Callable[[Any], Any]) -> Disposer:
        if event not in self._handlers:
            raise PluginError(f"Unknown event {event!r}. The events are: {', '.join(EVENTS)}.")
        self._handlers[event].append(fn)
        return lambda: self._handlers[event].remove(fn) if fn in self._handlers[event] else None

    def count(self) -> int:
        return sum(len(h) for h in self._handlers.values())

    def has(self, event: str) -> bool:
        return bool(self._handlers.get(event))

    async def emit(self, event: str, payload: Any) -> Any:
        """Run the handlers in order. A handler that blocks or rejects stops the handlers after it."""
        blocked_before = getattr(payload, "blocked", None)
        for fn in list(self._handlers.get(event, [])):
            try:
                await _maybe_await(fn(payload))
            except Exception:  # noqa: BLE001 - a plugin bug must not stop the turn.
                log.exception("A %s handler of a plugin failed", event)
            if not blocked_before and getattr(payload, "blocked", None):
                break
        return payload


# -- the services that a plugin context gets -------------------------------------------------------


class _Service:
    def __init__(self, ctx: "Context"):
        self.ctx = ctx
        self.host = ctx.host

    def _own(self, dispose: Disposer) -> Disposer:
        return self.ctx.effect(dispose)


class ToolsService(_Service):
    """``ctx.tools``: tools for the agent."""

    def register(self, tool: Tool | None = None, *, name: str | None = None, description: str = "",
                 parameters: dict[str, Any] | None = None, run: Callable[..., Any] | None = None,
                 needs_approval: bool = False) -> Disposer:
        """Register a Tool object, or a function with ``name``, ``description``, ``parameters``, and ``run``.

        ``run(args, ctx)`` can be async. It returns a string, a JSON value, or a ToolResult.
        ``needs_approval``: the user approves each call, as for the edit and bash tools.
        """
        if tool is None:
            if not name or run is None:
                raise PluginError("tools.register needs a Tool object, or 'name' and 'run'.")
            tool = PluginTool(name, description or (inspect.getdoc(run) or ""), object_schema(parameters),
                              run, needs_approval, self.ctx.id)
        if not TOOL_NAME_RE.match(tool.name) or tool.name.startswith(RESERVED_TOOL_PREFIXES):
            raise PluginError(f"Not a valid tool name: {tool.name!r}. Use 1 to 64 characters: A-Z, a-z, 0-9, '_', '-'. "
                              f"Do not start it with {' or '.join(RESERVED_TOOL_PREFIXES)}.")
        tools = self.host._tools
        if tool.name in tools:
            raise PluginError(f"Another plugin already registered the tool {tool.name!r}.")
        tools[tool.name] = tool
        owners = self.host._owners
        owners[tool.name] = self.ctx.id

        def dispose() -> None:
            tools.pop(tool.name, None)
            owners.pop(tool.name, None)
        return self._own(dispose)

    def tool(self, name: str | None = None, *, description: str = "", parameters: dict[str, Any] | None = None,
             needs_approval: bool = False) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """A decorator: ``@ctx.tools.tool(parameters={...})`` registers the function. Its name is the tool name."""
        def wrap(fn: Callable[..., Any]) -> Callable[..., Any]:
            self.register(name=name or fn.__name__, description=description, parameters=parameters,
                          run=fn, needs_approval=needs_approval)
            return fn
        return wrap


class CommandsService(_Service):
    """``ctx.commands``: / commands for the user."""

    def register(self, name: str, description: str, handler: Callable[[Invocation], Any],
                 argument_hint: str = "") -> Disposer:
        """``handler(invocation)`` can be async. It returns text to show, a Prompt to start a turn, or None."""
        name = name.lstrip("/")
        if not COMMAND_NAME_RE.match(name):
            raise PluginError(f"Not a valid command name: {name!r}.")
        commands = self.host._commands
        if name in commands:
            raise PluginError(f"Another plugin already registered the command /{name}.")
        commands[name] = Command(name, description, handler, argument_hint, self.ctx.id)
        return self._own(lambda: commands.pop(name, None))

    def command(self, name: str | None = None, *, description: str = "",
                argument_hint: str = "") -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """A decorator: ``@ctx.commands.command()`` registers the function. Its name is the command name."""
        def wrap(fn: Callable[..., Any]) -> Callable[..., Any]:
            self.register(name or fn.__name__.replace("_", "-"), description or (inspect.getdoc(fn) or ""), fn,
                          argument_hint)
            return fn
        return wrap


class SkillsService(_Service):
    """``ctx.skills``: folders of SKILL.md skills. A plugin skill has a lower priority than user skills."""

    def add_root(self, folder: str | Path) -> Disposer:
        """Add a folder that holds skill folders (``<folder>/<skill>/SKILL.md``). A relative path is in the plugin folder."""
        path = Path(folder)
        if not path.is_absolute():
            path = self.ctx.dir / path
        entry = (path, self.ctx.bundle)
        roots = self.host._skill_roots
        roots.append(entry)
        return self._own(lambda: roots.remove(entry) if entry in roots else None)


class PromptService(_Service):
    """``ctx.prompt``: text for the system prompt of the agent."""

    def section(self, text: str | Callable[[], str]) -> Disposer:
        """Add a section. A function gives the text each time the daemon builds the system prompt."""
        sections = self.host._sections
        entry = (self.ctx.id, text)
        sections.append(entry)
        return self._own(lambda: sections.remove(entry) if entry in sections else None)


class HooksService(_Service):
    """``ctx.hooks``: handlers for the events ``tool.before``, ``tool.after``, ``turn.start``, and ``turn.end``."""

    def on(self, event: str, handler: Callable[[Any], Any]) -> Disposer:
        return self._own(self.host.hooks.add(event, handler))


class McpService(_Service):
    """``ctx.mcp``: MCP servers, in the format of mcp.json. A user or project server with the same name wins."""

    def add_server(self, name: str, config: dict[str, Any]) -> Disposer:
        servers = self.host._mcp
        if name in servers:
            raise PluginError(f"Another plugin already added the MCP server {name!r}.")
        if not isinstance(config, dict):
            raise PluginError("The MCP server config must be a dict, as in mcp.json.")
        servers[name] = dict(config)
        return self._own(lambda: servers.pop(name, None))


class ProvidersService(_Service):
    """``ctx.providers``: model providers, in the format of providers.json. A providers.json entry wins."""

    def register(self, name: str, entry: dict[str, Any]) -> Disposer:
        if not isinstance(entry, dict) or not isinstance(entry.get("base_url"), str):
            raise PluginError("A provider needs a dict with a 'base_url' string, as in providers.json.")
        self.host._providers.append(name)
        remove = register_plugin_provider(name, entry)

        def dispose() -> None:
            remove()
            if name in self.host._providers:
                self.host._providers.remove(name)
        return self._own(dispose)


SERVICE_TYPES: dict[str, type[_Service]] = {
    "tools": ToolsService, "commands": CommandsService, "skills": SkillsService, "prompt": PromptService,
    "hooks": HooksService, "mcp": McpService, "providers": ProvidersService,
}


# -- the plugin context -----------------------------------------------------------------------------


class Context:
    """The ``ctx`` of one plugin row.

    - ``ctx.id``, ``ctx.bundle``, ``ctx.dir``: the row id, the bundle name, and the bundle folder.
    - ``ctx.cwd``: the project folder of the session.
    - ``ctx.data_dir``: a folder for the files of the plugin (``~/.harness/plugin-data/<bundle>``).
    - ``ctx.log``: a logger. The daemon log shows its messages.
    - ``ctx.<service>``: a service. See BUILTIN_SERVICES, and the services of other plugins.
    """

    def __init__(self, host: "PluginHost", row: Row, bundle: Bundle, provide: list[str]):
        self.host = host
        self.id = row.id
        self.bundle = bundle.name
        self.dir = bundle.dir
        self.cwd = host.cwd
        self.log = logging.getLogger(f"harness.plugin.{row.id}")
        self._provide = provide
        self._effects: list[Disposer] = []
        self._services: dict[str, Any] = {}

    @property
    def data_dir(self) -> Path:
        path = harness_home() / "plugin-data" / self.bundle
        path.mkdir(parents=True, exist_ok=True)
        return path

    def effect(self, dispose: Disposer) -> Disposer:
        """Keep a disposer. The host calls it when it unloads the plugin. Return a function that calls it now."""
        self._effects.append(dispose)

        def run_now() -> None:
            if dispose in self._effects:
                self._effects.remove(dispose)
                dispose()
        return run_now

    def on(self, event: str, handler: Callable[[Any], Any]) -> Disposer:
        """A short form of ``ctx.hooks.on``."""
        return self.hooks.on(event, handler)

    def provide(self, name: str, value: Any) -> Disposer:
        """Give a service to other plugins. The module must list the name in ``provide``."""
        if name not in self._provide:
            raise PluginError(f"Add {name!r} to the 'provide' list of the plugin module.")
        if name in BUILTIN_SERVICES or name in self.host._services:
            raise PluginError(f"The service {name!r} already exists.")
        self.host._services[name] = value
        return self.effect(lambda: self.host._services.pop(name, None))

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in SERVICE_TYPES:
            service = self._services.get(name)
            if service is None:
                service = self._services[name] = SERVICE_TYPES[name](self)
            return service
        if name in self.host._services:
            return self.host._services[name]
        raise AttributeError(f"The plugin context has no service {name!r}. Add it to 'inject', "
                             "and check that the plugin that provides it is on.")

    def dispose(self) -> None:
        for dispose in reversed(self._effects):
            try:
                dispose()
            except Exception:  # noqa: BLE001
                log.exception("A disposer of the plugin %s failed", self.id)
        self._effects.clear()


# -- the host ---------------------------------------------------------------------------------------


@dataclass
class RowState:
    row: Row
    state: str = "pending"  # pending, active, disabled, failed, or idle (scan() ran no plugin code)
    error: str | None = None
    ctx: Context | None = None
    inject: list[str] = field(default_factory=list)
    provide: list[str] = field(default_factory=list)
    module: Any = None

    def to_json(self, host: "PluginHost") -> dict[str, Any]:
        mine = self.row.id
        return {
            "id": mine, "name": self.row.name, "bundle": self.row.bundle, "state": self.state,
            "error": self.error, "disabled": self.row.disabled, "config": self.row.config,
            "layer": self.row.layer, "overrides": self.row.overrides,
            "inject": self.inject, "provide": self.provide,
            "tools": sorted(n for n, owner in host._owners.items() if owner == mine),
            "commands": sorted(n for n, c in host._commands.items() if c.plugin == mine),
        }


class PluginHost:
    """The plugins of one session: the rows of the layers, and what the active plugins registered."""

    def __init__(self, cwd: Path | None):
        self.cwd = Path(cwd) if cwd is not None else None
        self.hooks = Hooks()
        self.rows: dict[str, RowState] = {}
        self.bundles: list[Installed] = []
        self.warnings: list[str] = []
        self._tools: dict[str, Tool] = {}
        self._owners: dict[str, str] = {}  # Tool name -> row id.
        self._commands: dict[str, Command] = {}
        self._skill_roots: list[tuple[Path, str]] = []
        self._sections: list[tuple[str, str | Callable[[], str]]] = []
        self._mcp: dict[str, dict[str, Any]] = {}
        self._providers: list[str] = []
        self._services: dict[str, Any] = {}
        self._loaded = False

    # -- what the session reads ----------------------------------------------------------------------

    def tools(self) -> list[Tool]:
        return list(self._tools.values())

    def commands(self) -> dict[str, Command]:
        """The / commands of the plugins."""
        return dict(self._commands)

    def skill_roots(self) -> list[tuple[Path, str]]:
        return list(self._skill_roots)

    def prompt_sections(self) -> list[str]:
        texts = []
        for row_id, text in self._sections:
            try:
                value = text() if callable(text) else text
            except Exception:  # noqa: BLE001
                log.exception("The prompt section of the plugin %s failed", row_id)
                continue
            if isinstance(value, str) and value.strip():
                texts.append(value.strip())
        return texts

    def mcp_servers(self) -> dict[str, dict[str, Any]]:
        return {name: dict(config) for name, config in self._mcp.items()}

    # -- load and unload -----------------------------------------------------------------------------

    def layers(self) -> list[Layer]:
        self.bundles = installed_bundles()
        layers, warnings = bundle_layers(self.bundles)
        self.warnings = list(warnings)
        files = [("user", user_patch_path())]
        if self.cwd is not None:
            files.append(("project", project_patch_path(self.cwd)))
        for label, path in files:
            try:
                layers.append(Layer(label, path, read_patch_file(path)))
            except ValueError as e:
                self.warnings.append(str(e))
        return layers

    async def load(self) -> None:
        """Compose the rows and activate each row that is on. A plugin error does not stop the others."""
        if self._loaded:
            await self.dispose()
        self._loaded = True
        rows, warnings = compose(self.layers())
        self.warnings.extend(warnings)
        bundles = {i.name: i for i in self.bundles if i.bundle is not None and i.enabled and not i.problem}
        self.rows = {row_id: RowState(row) for row_id, row in rows.items()}
        modules: dict[str, types.ModuleType] = {}
        for state in self.rows.values():
            row = state.row
            if row.disabled:
                state.state = "disabled"
                continue
            installed = bundles.get(row.bundle)
            if installed is None:
                self._fail(state, f"The plugin {row.bundle!r} is not installed, or it is off.")
                continue
            try:
                module = modules.get(row.name) or load_module(installed.bundle, row.name)  # type: ignore[arg-type]
                modules[row.name] = module
                state.inject = _names(row.inject if row.inject is not None else getattr(module, "inject", []), "inject")
                state.provide = _names(getattr(module, "provide", []), "provide")
                if not callable(getattr(module, "apply", None)):
                    raise PluginError("The module has no apply(ctx, config) function.")
            except Exception as e:  # noqa: BLE001 - a bad plugin must not stop the session.
                self._fail(state, _error_text(e))
                continue
            state.module = module
            state.ctx = Context(self, row, installed.bundle, state.provide)  # type: ignore[arg-type]
        await self._activate()

    def scan(self) -> None:
        """Compose the rows, but run no plugin code. For the Plugins screen when no session is open."""
        rows, warnings = compose(self.layers())
        self.warnings.extend(warnings)
        self.rows = {row_id: RowState(row, "disabled" if row.disabled else "idle") for row_id, row in rows.items()}

    async def _activate(self) -> None:
        """Activate the rows in rounds: a row starts when all the services of its inject list exist."""
        waiting = [s for s in self.rows.values() if s.state == "pending"]
        while waiting:
            ready = [s for s in waiting if all(n in BUILTIN_SERVICES or n in self._services for n in s.inject)]
            if not ready:
                break
            for state in ready:
                waiting.remove(state)
                await self._apply(state)
        for state in waiting:
            missing = [n for n in state.inject if n not in BUILTIN_SERVICES and n not in self._services]
            self._fail(state, f"No active plugin provides the service: {', '.join(missing)}.")

    async def _apply(self, state: RowState) -> None:
        ctx = state.ctx
        module = state.module
        assert ctx is not None and module is not None
        try:
            config = resolve_config(getattr(module, "Config", None), state.row.config)
            await _maybe_await(module.apply(ctx, config))
            missing = [n for n in state.provide if n not in self._services]
            if missing:
                raise PluginError(f"The plugin did not call ctx.provide() for: {', '.join(missing)}.")
        except Exception as e:  # noqa: BLE001
            ctx.dispose()
            self._fail(state, _error_text(e))
            return
        state.state = "active"

    def _fail(self, state: RowState, error: str) -> None:
        state.state, state.error = "failed", error
        log.warning("The plugin %s did not load: %s", state.row.id, error)

    async def dispose(self) -> None:
        """Unload all plugins: call their disposers in the reverse order of activation."""
        for state in reversed(list(self.rows.values())):
            if state.ctx is not None:
                state.ctx.dispose()
                state.ctx = None
        self._loaded = False

    # -- the Plugins screen ------------------------------------------------------------------------------

    def describe(self) -> dict[str, Any]:
        rows = [s.to_json(self) for s in self.rows.values()]
        bundles = []
        for item in self.bundles:
            body: dict[str, Any] = {"name": item.name, "dir": str(item.dir), "enabled": item.enabled,
                                    "source": item.source, "problem": item.problem}
            if item.bundle is not None:
                body.update(version=item.bundle.version, description=item.bundle.description,
                            icon=icon_data(item.bundle))
            body["rows"] = [r for r in rows if r["bundle"] == item.name]
            bundles.append(body)
        known = {b["name"] for b in bundles}
        return {
            "bundles": bundles,
            "orphans": [r for r in rows if r["bundle"] not in known],  # Rows of bundles that are not installed.
            "warnings": self.warnings,
            "paths": {
                "plugins": str(harness_home() / "plugins"),
                "user_patch": str(user_patch_path()),
                "project_patch": str(project_patch_path(self.cwd)) if self.cwd else None,
            },
            "counts": {"tools": len(self._tools), "commands": len(self._commands), "hooks": self.hooks.count(),
                       "skill_roots": len(self._skill_roots), "prompt_sections": len(self._sections),
                       "mcp_servers": len(self._mcp), "providers": len(self._providers)},
        }


def _names(value: Any, key: str) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)) or not all(isinstance(v, str) for v in value):
        raise PluginError(f"'{key}' must be a list of service names.")
    return list(value)


def _error_text(error: BaseException) -> str:
    if isinstance(error, (PluginError, ConfigError)):
        return str(error)
    frames = [f for f in traceback.extract_tb(error.__traceback__) if PACKAGE in (f.filename or "")
              or "plugin" in Path(f.filename or "").name]
    where = f" ({Path(frames[-1].filename).name}, line {frames[-1].lineno})" if frames else ""
    return f"{type(error).__name__}: {error}{where}"


def resolve_config(defaults: Any, given: Any) -> Any:
    """The row config merged over the ``Config`` defaults of the module. The types of the defaults are checked."""
    if defaults is None:
        return given if given is not None else {}
    if not isinstance(defaults, dict):
        raise PluginError("'Config' must be a dict of default values.")
    if given is None:
        given = {}
    if not isinstance(given, dict):
        raise PluginError("The row 'config' must be a mapping.")
    config = dict(defaults)
    for key, value in given.items():
        default = defaults.get(key)
        if default is not None and value is not None and not _same_type(default, value):
            raise PluginError(f"The config value {key!r} must be a {type(default).__name__}, "
                              f"not a {type(value).__name__}.")
        config[key] = value
    return config


def _same_type(default: Any, value: Any) -> bool:
    if isinstance(default, bool) or isinstance(value, bool):
        return isinstance(default, bool) and isinstance(value, bool)
    if isinstance(default, (int, float)):
        return isinstance(value, (int, float))
    return isinstance(value, type(default))


# -- module import -----------------------------------------------------------------------------------


def _package_name(bundle: str) -> str:
    return f"{PACKAGE}.{re.sub(r'[^A-Za-z0-9_]', '_', bundle)}"


def load_module(bundle: Bundle, name: str) -> types.ModuleType:
    """Import the module of a row: ``<bundle>`` is the main file, ``<bundle>/<module>`` is ``<module>.py``.

    The bundle folder is a package, so that the plugin can use relative imports (``from . import util``).
    Each load imports the code again. Thus a changed plugin file has an effect at the next load.
    """
    if PACKAGE not in sys.modules:
        root = types.ModuleType(PACKAGE)
        root.__path__ = []  # type: ignore[attr-defined]
        sys.modules[PACKAGE] = root
    package = _package_name(bundle.name)
    for key in [k for k in sys.modules if k == package or k.startswith(package + ".")]:
        del sys.modules[key]
    spec = importlib.machinery.ModuleSpec(package, None, is_package=True)
    spec.submodule_search_locations = [str(bundle.dir)]
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[package] = pkg

    _, _, sub = name.partition("/")
    if sub:
        if not re.match(r"^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$", sub):
            raise PluginError(f"Not a valid module name: {name!r}.")
        path = bundle.dir / f"{sub}.py"
        if not path.is_file():
            path = bundle.dir / sub / "__init__.py"
    else:
        path = bundle.dir / bundle.main
    if not path.is_file():
        raise PluginError(f"The module file of {name!r} does not exist: {path.name}")
    module_name = f"{package}.{path.stem if path.name != '__init__.py' else path.parent.name}"
    module_spec = importlib.util.spec_from_file_location(module_name, path)
    if module_spec is None or module_spec.loader is None:
        raise PluginError(f"Python cannot load {path}.")
    module = importlib.util.module_from_spec(module_spec)
    sys.modules[module_name] = module
    # Compile the source here, not with the loader: a .pyc file can hide a change in the same second.
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)  # noqa: S102 - the plugin code.
    return module


# -- what the server calls ---------------------------------------------------------------------------


async def run_command(command: Command, invocation: Invocation) -> Any:
    """Run a command handler. Return its value: text, a Prompt, or None."""
    return await _maybe_await(command.handler(invocation))


__all__ = [
    "BUILTIN_SERVICES", "Command", "Context", "EVENTS", "Hooks", "Invocation", "PluginError",
    "PluginHost", "PluginTool", "Prompt", "RequestErrorEvent", "RequestEvent", "StepEvent", "StreamEvent",
    "ToolCall", "TurnEvent", "TurnStoppingEvent", "object_schema", "run_command",
]
