"""MCP servers (SPEC.md section 5.7): the MCP client of a session and the MCP tools of the agent.

The server list comes from ``~/.harness/mcp.json`` (user) and ``<project>/.harness/mcp.json``
(project). A project server replaces a user server with the same name. The format is the
same as Claude Code and other MCP clients::

    { "mcpServers": {
        "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
        "search": { "type": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"} },
        "old":    { "type": "sse", "url": "http://127.0.0.1:8000/sse", "disabled": true } } }

- ``type``: ``stdio`` (the default with ``command``), ``http`` (streamable HTTP), or ``sse``.
- ``${VAR}`` and ``${VAR:-default}`` take values from the environment of the daemon.
- ``timeout``: seconds for one tool call. The default is 120.
- ``oauth``: OAuth for an http or sse server (mcp_auth.py). It is on by default when the headers
  have no ``Authorization``. A server that needs a sign-in has the state "needs_auth" until the
  user authenticates it (message ``mcp.auth``).
- ``connector``: the server comes from a connector (connectors.py). For a "token" connector, the
  daemon adds the token as the ``Authorization`` header at each connection, and OAuth is off. A
  "device" connector is a stdio server that keeps its own tokens.

Each MCP tool is a tool of the agent with the name ``mcp__<server>__<tool>``. It needs approval
by default. The rule ``mcp__<server>__*`` allows all the tools of one server.

The MCP clients run in their own thread with their own event loop, as the agent browser does.
On Windows, that loop is a ProactorEventLoop, because stdio servers are subprocesses.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import threading
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import __version__
from . import connectors, mcp_auth
from .config import ConfigError, harness_home, read_json
from .mcp_auth import AUTH_TIMEOUT, AuthCancelled, AuthRequired, OAuthConfig
from .tools.base import Approval, Tool, ToolContext, ToolError, ToolResult

log = logging.getLogger("harness.mcp")

Emit = Callable[[dict[str, Any]], Awaitable[None]]

CONNECT_TIMEOUT = 60  # npx can download a server on the first start.
CALL_TIMEOUT = 120
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
TOOL_NAME_MAX = 64  # The limit of OpenAI function names.
ENV_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
LOG_TAIL = 20
MAX_DESCRIPTION = 1024

TEMPLATE = {
    "mcpServers": {
        "example": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-everything"],
            "disabled": True,
        }
    }
}


def user_config_path() -> Path:
    return harness_home() / "mcp.json"


def project_config_path(project: Path) -> Path:
    return Path(project) / ".harness" / "mcp.json"


@dataclass
class ServerConfig:
    name: str
    scope: str  # "plugin", "user", or "project"
    transport: str  # "stdio", "http", or "sse"
    command: str | None = None
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    cwd: str | None = None
    url: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    disabled: bool = False
    timeout: float = CALL_TIMEOUT
    oauth: OAuthConfig | None = None  # OAuth for an http or sse server. None: off.
    connector: str | None = None  # The connector that gives the token (connectors.py).

    @property
    def auth_key(self) -> str:
        return mcp_auth.record_key(self.name, self.url or "")

    def describe(self) -> str:
        if self.transport == "stdio":
            return " ".join([self.command or "", *self.args]).strip()
        return self.url or ""


def _expand(value: str, missing: list[str]) -> str:
    def replace(match: re.Match) -> str:
        name, default = match.group(1), match.group(2)
        if name in os.environ:
            return os.environ[name]
        if default is not None:
            return default
        missing.append(name)
        return ""

    return ENV_RE.sub(replace, value)


def _parse_server(name: str, raw: Any, scope: str, project: Path | None) -> tuple[ServerConfig, list[str]]:
    """One server entry. Returns the config and the warnings."""
    if not NAME_RE.match(name):
        raise ConfigError(f"MCP server {name!r}: the name must have only letters, digits, '_', or '-'.")
    if not isinstance(raw, dict):
        raise ConfigError(f"MCP server {name}: the entry must be an object.")
    missing: list[str] = []
    kind = str(raw.get("type") or raw.get("transport") or ("stdio" if raw.get("command") else "http")).lower()
    kind = {"streamable-http": "http", "streamable_http": "http", "streamablehttp": "http"}.get(kind, kind)
    if kind not in ("stdio", "http", "sse"):
        raise ConfigError(f"MCP server {name}: the type must be stdio, http, or sse, not {kind}.")
    disabled = bool(raw.get("disabled")) or raw.get("enabled") is False
    timeout = raw.get("timeout", CALL_TIMEOUT)
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        raise ConfigError(f"MCP server {name}: the timeout must be a positive number of seconds.")
    config = ServerConfig(name=name, scope=scope, transport=kind, disabled=disabled, timeout=float(timeout))
    connector = raw.get("connector")
    if connector is not None:
        known = connectors.CONNECTORS.get(connector) if isinstance(connector, str) else None
        if isinstance(connector, str) and connector in connectors.RETIRED:
            raise ConfigError(f"MCP server {name}: Harness no longer has the {connectors.RETIRED[connector]} connector. "
                              f"Open the Connectors tab to remove the entry, or remove '{name}' from mcp.json.")
        if known is None:
            raise ConfigError(f"MCP server {name}: unknown connector {connector!r}.")
        local = known.kind in ("device", "mail")
        if local != (kind == "stdio"):
            raise ConfigError(f"MCP server {name}: the connector {connector} needs a "
                              f"{'stdio' if local else 'http'} server.")
        config.connector = connector
    if kind == "stdio":
        command = raw.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ConfigError(f"MCP server {name}: a stdio server needs a 'command'.")
        args = raw.get("args") or []
        if not isinstance(args, list) or not all(isinstance(a, (str, int, float)) for a in args):
            raise ConfigError(f"MCP server {name}: 'args' must be a list of strings.")
        env = raw.get("env") or {}
        if not isinstance(env, dict):
            raise ConfigError(f"MCP server {name}: 'env' must be an object.")
        config.command = _expand(command.strip(), missing)
        config.args = [_expand(str(a), missing) for a in args]
        config.env = {str(k): _expand(str(v), missing) for k, v in env.items()}
        cwd = raw.get("cwd")
        if cwd:
            path = Path(_expand(str(cwd), missing)).expanduser()
            if not path.is_absolute() and project is not None:
                path = project / path
            config.cwd = str(path)
        elif project is not None:
            config.cwd = str(project)
    else:
        url = raw.get("url")
        if not isinstance(url, str) or not re.match(r"^https?://", _expand(url, [])):
            raise ConfigError(f"MCP server {name}: an {kind} server needs a 'url' with http:// or https://.")
        headers = raw.get("headers") or {}
        if not isinstance(headers, dict):
            raise ConfigError(f"MCP server {name}: 'headers' must be an object.")
        config.url = _expand(url, missing)
        config.headers = {str(k): _expand(str(v), missing) for k, v in headers.items()}
        if config.connector is None:
            config.oauth = mcp_auth.parse_oauth(name, raw.get("oauth"), config.headers, lambda v: _expand(v, missing))
    warnings = [f"MCP server {name}: the environment variable {v} is not set." for v in dict.fromkeys(missing)]
    return config, warnings


def _servers_of(data: Any, path: Path) -> dict[str, Any]:
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must be a JSON object.")
    for key in ("mcpServers", "servers"):
        if isinstance(data.get(key), dict):
            return data[key]
    return {k: v for k, v in data.items() if isinstance(v, dict)}


def load_mcp_config(project: Path | None, plugin_servers: dict[str, Any] | None = None,
                    ) -> tuple[dict[str, ServerConfig], list[str]]:
    """The servers of the plugins, the user file, and the project file, and the problems (warnings and errors).

    A user or project server replaces a plugin server with the same name.
    """
    servers: dict[str, ServerConfig] = {}
    problems: list[str] = []
    for name, raw in (plugin_servers or {}).items():
        try:
            config, warnings = _parse_server(name, raw, "plugin", Path(project) if project else None)
        except ConfigError as e:
            problems.append(f"Plugin MCP server: {e}")
            continue
        servers[name] = config
        problems.extend(warnings)
    sources = [("user", user_config_path())]
    if project is not None:
        sources.append(("project", project_config_path(project)))
    for scope, path in sources:
        try:
            entries = _servers_of(read_json(path, None), path)
        except ConfigError as e:
            problems.append(str(e))
            continue
        for name, raw in entries.items():
            try:
                config, warnings = _parse_server(name, raw, scope, Path(project) if project else None)
            except ConfigError as e:
                problems.append(f"{path}: {e}")
                continue
            servers[name] = config  # A project server replaces a user server.
            problems.extend(warnings)
    return servers, problems


def tool_name(server: str, tool: str, taken: set[str]) -> str:
    """``mcp__<server>__<tool>``, with only the characters of a function name, and 64 characters or less."""
    name = re.sub(r"[^A-Za-z0-9_-]", "_", f"mcp__{server}__{tool}")
    if len(name) > TOOL_NAME_MAX or name in taken:
        digest = hashlib.sha1(f"{server}/{tool}".encode()).hexdigest()[:8]
        name = name[:TOOL_NAME_MAX - 9] + "_" + digest
    return name


def _error_text(error: BaseException) -> str:
    """The first real error in an exception group, as one line."""
    while isinstance(error, BaseExceptionGroup) and error.exceptions:
        error = error.exceptions[0]
    text = str(error).strip() or type(error).__name__
    return text.splitlines()[0][:500]


# -- the event loop thread ---------------------------------------------------------------------------


class LoopThread:
    """An event loop in its own thread. ``call`` runs a coroutine there from another loop."""

    def __init__(self, name: str):
        self.name = name
        self.loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def ensure(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self.loop is not None:
                return self.loop
            ready = threading.Event()

            def run() -> None:
                loop = asyncio.ProactorEventLoop() if os.name == "nt" else asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                self.loop = loop
                ready.set()
                try:
                    loop.run_forever()
                finally:
                    loop.close()

            threading.Thread(target=run, name=self.name, daemon=True).start()
            ready.wait()
            assert self.loop is not None
            return self.loop

    async def call(self, fn: Callable[[], Awaitable[Any]]) -> Any:
        future = asyncio.run_coroutine_threadsafe(fn(), self.ensure())
        return await asyncio.wrap_future(future)

    def stop(self) -> None:
        with self._lock:
            loop, self.loop = self.loop, None
        if loop is not None:
            loop.call_soon_threadsafe(loop.stop)


# -- one server -------------------------------------------------------------------------------------------


@dataclass
class ServerState:
    config: ServerConfig
    state: str = "stopped"  # starting, connected, failed, disabled, stopped, needs_auth, authenticating
    error: str | None = None
    tools: list[Any] = field(default_factory=list)  # mcp.types.Tool
    session: Any = None
    stop: asyncio.Event | None = None  # An event of the MCP loop.
    task: asyncio.Future | None = None
    log_path: Path | None = None
    server_name: str | None = None
    started: float = 0.0
    callback: mcp_auth.Callback | None = None  # The listener of an interactive sign-in.
    auth_url: str | None = None  # The sign-in page of an interactive sign-in.
    unauthorized: bool = False  # The server answered HTTP 401 (for a connector: a bad token).

    def log_tail(self) -> list[str]:
        if not self.log_path or not self.log_path.exists():
            return []
        try:
            lines = self.log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return []
        return [line for line in lines if line.strip()][-LOG_TAIL:]

    def to_json(self, tool_names: dict[str, str]) -> dict[str, Any]:
        c = self.config
        body: dict[str, Any] = {
            "name": c.name, "scope": c.scope, "transport": c.transport, "target": c.describe(),
            "state": self.state, "error": self.error, "server_name": self.server_name,
            "oauth": c.oauth is not None,
            "connector": c.connector,
            "signed_in": c.oauth is not None and mcp_auth.has_tokens(c.auth_key),
            "tools": [{"name": t.name, "agent_name": tool_names.get(t.name, ""),
                       "description": (t.description or "")[:300]} for t in self.tools],
        }
        if self.state == "failed":
            body["log"] = self.log_tail()
        if self.state == "authenticating" and self.auth_url:
            body["auth_url"] = self.auth_url
        return body


class McpManager:
    """The MCP servers of one session."""

    def __init__(self, project: Path, emit: Emit, on_tools: Callable[[list[Tool]], None],
                 plugin_servers: Callable[[], dict[str, Any]] | None = None):
        self.project = Path(project)
        self.plugin_servers = plugin_servers or dict  # The MCP servers of the plugins, now.
        self.emit = emit
        self.on_tools = on_tools
        self.servers: dict[str, ServerState] = {}
        self.problems: list[str] = []
        self.thread = LoopThread("mcp")
        self.main_loop: asyncio.AbstractEventLoop | None = None
        self._tools: list[McpTool] = []
        self._starting: asyncio.Event = asyncio.Event()
        self._starting.set()

    # -- start and stop --------------------------------------------------------------------------------

    async def start(self) -> None:
        """Read the configuration and connect to each server that is on."""
        self.main_loop = asyncio.get_running_loop()
        configs, self.problems = load_mcp_config(self.project, self.plugin_servers())
        self.servers = {name: ServerState(config) for name, config in configs.items()}
        wanted = [s for s in self.servers.values() if not s.config.disabled]
        for s in self.servers.values():
            if s.config.disabled:
                s.state = "disabled"
        if not wanted:
            self._update_tools()
            await self.send_status()
            return
        self._starting.clear()
        for s in wanted:
            s.state = "starting"
        await self.send_status()
        await asyncio.gather(*(self._connect(s) for s in wanted))
        self._starting.set()
        self._update_tools()
        await self.send_status()

    async def ready(self, timeout: float) -> None:
        """Wait until the servers are connected or failed. A slow server does not stop a turn for long."""
        try:
            await asyncio.wait_for(self._starting.wait(), timeout)
        except asyncio.TimeoutError:
            log.info("MCP servers are still starting after %s seconds.", timeout)

    async def _connect(self, s: ServerState, interactive: bool = False) -> None:
        s.error, s.tools, s.started = None, [], time.time()
        logs = harness_home() / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        s.log_path = logs / f"mcp-{s.config.name}.log"
        connected = asyncio.Event()

        def signal() -> None:  # From the MCP loop.
            assert self.main_loop is not None
            self.main_loop.call_soon_threadsafe(connected.set)

        loop = self.thread.ensure()
        s.task = asyncio.run_coroutine_threadsafe(self._run(s, signal, interactive), loop)  # type: ignore[assignment]
        wait = CONNECT_TIMEOUT + 5 + (AUTH_TIMEOUT if interactive else 0)
        try:
            await asyncio.wait_for(connected.wait(), wait)
        except asyncio.TimeoutError:
            s.state, s.error = "failed", f"No connection after {wait - 5} seconds."
            await self._stop_one(s)

    def _auth_provider(self, s: ServerState, interactive: bool) -> Any:
        """The OAuth provider of an http or sse server. Runs in the MCP loop."""
        c = s.config
        assert c.oauth is not None
        if interactive:
            assert s.callback is not None
            port = s.callback.port
        else:
            port = mcp_auth.callback_port(c.auth_key, c.oauth)
        storage = mcp_auth.FileTokenStorage(c.auth_key, c.oauth, mcp_auth.redirect_uri(port))

        async def redirect(url: str) -> None:
            if not interactive:
                raise AuthRequired(url)
            if not re.match(r"^https?://", url):
                raise AuthCancelled("The authorization server gave a sign-in URL that is not http or https.")
            s.auth_url = url
            if self.main_loop is not None:
                asyncio.run_coroutine_threadsafe(self._auth_started(s.config.name, url), self.main_loop)

        async def callback() -> Any:
            if s.callback is None:
                raise AuthRequired("")
            return await s.callback.wait()

        return mcp_auth.make_provider(c.url or "", storage, c.oauth, redirect, callback)

    async def _auth_started(self, name: str, url: str) -> None:
        """The sign-in page is ready: the client opens it in the browser."""
        await self.emit({"type": "mcp.auth_url", "name": name, "url": url})
        await self.send_status()

    async def _run(self, s: ServerState, signal: Callable[[], None], interactive: bool = False) -> None:
        """Runs in the MCP loop. The transport opens and closes in this task, as anyio requires."""
        from mcp import ClientSession, types

        s.stop = asyncio.Event()
        c = s.config
        try:
            async with AsyncExitStack() as stack:
                if c.transport == "stdio":
                    from mcp import StdioServerParameters
                    from mcp.client.stdio import stdio_client

                    errlog = stack.enter_context(open(s.log_path, "w", encoding="utf-8"))  # type: ignore[arg-type]
                    # A connector adds its secrets here (the passwords of the Email connector), not in mcp.json.
                    secret = await asyncio.to_thread(connectors.server_env, c.connector) if c.connector else {}
                    # A built-in server (the Email connector) runs the daemon itself, wherever it is installed.
                    command, args = (connectors.mail_command(c.connector) if c.connector else None) or (c.command, c.args)
                    params = StdioServerParameters(command=command, args=args,
                                                   env={**os.environ, **c.env, **secret}, cwd=c.cwd)
                    read, write = await stack.enter_async_context(stdio_client(params, errlog=errlog))
                else:
                    from mcp.client.streamable_http import create_mcp_http_client

                    auth = self._auth_provider(s, interactive) if c.oauth is not None else None
                    headers = dict(c.headers)
                    if c.connector is not None and connectors.get(c.connector).kind == "token":
                        value = await asyncio.to_thread(connectors.token, c.connector)
                        if value is None:
                            raise _ConnectorMissing()
                        headers["Authorization"] = f"Bearer {value}"
                    s.unauthorized = False

                    async def on_response(response: Any) -> None:
                        if response.status_code == 401:
                            s.unauthorized = True

                    def make_client(**kwargs: Any) -> Any:
                        client = create_mcp_http_client(**kwargs)
                        client.event_hooks["response"].append(on_response)
                        return client

                    if c.transport == "http":
                        from mcp.client.streamable_http import streamable_http_client

                        client = await stack.enter_async_context(make_client(headers=headers or None, auth=auth))
                        read, write = await stack.enter_async_context(streamable_http_client(c.url, http_client=client))
                    else:
                        from mcp.client.sse import sse_client

                        read, write = await stack.enter_async_context(
                            sse_client(c.url, headers=headers or None, auth=auth, httpx_client_factory=make_client))

                async def on_message(message: Any) -> None:
                    root = getattr(message, "root", message)
                    if isinstance(root, types.ToolListChangedNotification):
                        asyncio.ensure_future(self._relist(s))

                session = await stack.enter_async_context(ClientSession(
                    read, write, message_handler=on_message,
                    client_info=types.Implementation(name="harness", version=__version__)))
                # An interactive sign-in happens in the first request, so it gets more time.
                wait = CONNECT_TIMEOUT + (AUTH_TIMEOUT if interactive else 0)
                init = await asyncio.wait_for(session.initialize(), wait)
                info = getattr(init, "server_info", None) or getattr(init, "serverInfo", None)
                s.server_name = getattr(info, "name", None)
                s.tools = await self._list_tools(session)
                s.session, s.state = session, "connected"
                signal()
                await s.stop.wait()
        except BaseException as e:  # noqa: BLE001 - anyio raises exception groups.
            cancelled = mcp_auth.find_error(e, AuthCancelled)
            if c.connector is not None and (mcp_auth.find_error(e, _ConnectorMissing) is not None
                                            or s.unauthorized):
                name = connectors.get(c.connector).name
                missing = mcp_auth.find_error(e, _ConnectorMissing) is not None
                s.state = "needs_auth"
                s.error = (f"Connect {name} on the Connectors tab." if missing else
                           f"{name} refused the token. Connect {name} again on the Connectors tab.")
            elif mcp_auth.find_error(e, AuthRequired) is not None:
                s.state, s.error = "needs_auth", None
            elif cancelled is not None:
                s.state, s.error = "needs_auth", str(cancelled)
            elif not isinstance(e, asyncio.CancelledError):
                s.state, s.error = "failed", _error_text(e)
                if interactive and mcp_auth.find_error(e, _oauth_errors()) is not None:
                    s.error = f"The sign-in failed: {s.error}"
                log.info("MCP server %s failed: %s", c.name, s.error)
        finally:
            s.session = None
            s.auth_url = None
            if s.state == "connected":
                s.state = "stopped"
            signal()

    @staticmethod
    async def _list_tools(session: Any) -> list[Any]:
        from mcp import types

        tools: list[Any] = []
        cursor = None
        for _ in range(100):  # Pages.
            params = types.PaginatedRequestParams(cursor=cursor) if cursor else None
            result = await session.list_tools(params=params)
            tools.extend(result.tools)
            cursor = result.next_cursor
            if not cursor:
                break
        return tools

    async def _relist(self, s: ServerState) -> None:
        """The server sent tools/list_changed. Runs in the MCP loop."""
        if s.session is None:
            return
        try:
            s.tools = await self._list_tools(s.session)
        except Exception as e:  # noqa: BLE001
            log.info("MCP server %s: the tool list failed: %s", s.config.name, e)
            return
        if self.main_loop is not None:
            asyncio.run_coroutine_threadsafe(self._tools_changed(), self.main_loop)

    async def _tools_changed(self) -> None:
        self._update_tools()
        await self.send_status()

    async def _stop_one(self, s: ServerState) -> None:
        if s.callback is not None and self.thread.loop is not None:
            self.thread.loop.call_soon_threadsafe(s.callback.cancel)  # A sign-in that waits.
        if s.stop is not None and self.thread.loop is not None:
            self.thread.loop.call_soon_threadsafe(s.stop.set)
        if s.task is not None:
            try:
                await asyncio.wait_for(asyncio.wrap_future(s.task), 10)  # type: ignore[arg-type]
            except Exception:  # noqa: BLE001 - a server that does not stop.
                s.task.cancel()
        s.task = None

    async def restart(self, name: str | None = None) -> None:
        """Read the configuration again and connect again: one server, or all servers."""
        if name is None:
            await self.close()
            self.thread = LoopThread("mcp")
            await self.start()
            return
        configs, self.problems = load_mcp_config(self.project, self.plugin_servers())
        old = self.servers.get(name)
        if name not in configs:
            if old is None:
                raise ConfigError(f"Unknown MCP server: {name}")
            await self._stop_one(old)  # The configuration no longer has the server (a removed connector).
            del self.servers[name]
            self._update_tools()
            await self.send_status()
            return
        if old is not None:
            await self._stop_one(old)
        s = self.servers[name] = ServerState(configs[name])
        if s.config.disabled:
            s.state = "disabled"
        else:
            s.state = "starting"
            await self.send_status()
            await self._connect(s)
        self._update_tools()
        await self.send_status()

    # -- OAuth --------------------------------------------------------------------------------------------

    def _oauth_server(self, name: str) -> ServerState:
        s = self.servers.get(name)
        if s is None:
            raise ConfigError(f"Unknown MCP server: {name}")
        if s.config.oauth is None:
            raise ConfigError(f"The MCP server {name} does not use OAuth. Only an http or sse server with "
                              "no Authorization header can use it.")
        return s

    def is_connected(self, name: str) -> bool:
        s = self.servers.get(name)
        return s is not None and s.state == "connected"

    async def authenticate(self, name: str) -> None:
        """Sign in to an OAuth server: open the sign-in page in the browser, wait for the callback, and connect."""
        old = self.servers.get(name)
        if old is not None and old.state == "authenticating" and old.auth_url:
            await self._auth_started(name, old.auth_url)  # The sign-in already waits: open the page again.
            return
        configs, self.problems = load_mcp_config(self.project, self.plugin_servers())
        if name not in configs:
            raise ConfigError(f"Unknown MCP server: {name}")
        if configs[name].oauth is None:
            raise ConfigError(f"The MCP server {name} does not use OAuth. Only an http or sse server with "
                              "no Authorization header can use it.")
        if old is not None:
            await self._stop_one(old)
        s = self.servers[name] = ServerState(configs[name])
        c = s.config
        assert c.oauth is not None
        port = mcp_auth.callback_port(c.auth_key, c.oauth)
        listener = mcp_auth.Callback(port)
        try:
            await self.thread.call(listener.start)
        except OSError:
            if c.oauth.callback_port:
                s.state = "needs_auth"
                s.error = (f"The callback port {port} is in use. Close the other program, "
                           "or change 'oauth.callback_port' in mcp.json.")
                self._update_tools()
                await self.send_status()
                return
            port = mcp_auth.free_port()  # The saved port is in use: a new port, and a new registration.
            mcp_auth.update_record(c.auth_key, port=port, client=None)
            listener = mcp_auth.Callback(port)
            await self.thread.call(listener.start)
        s.callback, s.state = listener, "authenticating"
        await self.send_status()
        try:
            await self._connect(s, interactive=True)
        finally:
            s.callback = None
            await self.thread.call(listener.close)
        self._update_tools()
        await self.send_status()

    async def auth_code(self, name: str, url: str) -> str | None:
        """The user pasted the URL of the callback page. Return an error text, or None if it was accepted."""
        s = self._oauth_server(name)
        listener = s.callback
        if listener is None:
            return "No sign-in is waiting for this server. Click Authenticate first."
        return await self.thread.call(lambda: _call(lambda: listener.resolve(url)))

    async def auth_cancel(self, name: str) -> None:
        listener = self._oauth_server(name).callback
        if listener is not None:
            await self.thread.call(lambda: _call(listener.cancel))

    async def logout(self, name: str) -> None:
        """Remove the tokens and the client registration of a server, and connect again (it then needs a sign-in)."""
        s = self._oauth_server(name)
        mcp_auth.clear_record(s.config.auth_key)
        await self.restart(name)

    async def close(self) -> None:
        await asyncio.gather(*(self._stop_one(s) for s in self.servers.values()), return_exceptions=True)
        self.thread.stop()

    def close_now(self) -> None:
        """Stop the servers from any thread. For a daemon that stops."""
        loop = self.thread.loop
        if loop is None:
            return
        for s in self.servers.values():
            if s.stop is not None:
                loop.call_soon_threadsafe(s.stop.set)
        for s in self.servers.values():
            if s.task is not None:
                try:
                    s.task.result(timeout=3)  # type: ignore[union-attr]
                except Exception:  # noqa: BLE001
                    pass
        self.thread.stop()

    # -- tools --------------------------------------------------------------------------------------------

    def _update_tools(self) -> None:
        taken: set[str] = set()
        tools: list[McpTool] = []
        for s in self.servers.values():
            if s.state != "connected":
                continue
            for t in s.tools:
                name = tool_name(s.config.name, t.name, taken)
                taken.add(name)
                tools.append(McpTool(self, s.config.name, t, name))
        self._tools = tools
        self.on_tools(list(tools))

    def tools(self) -> list[Tool]:
        return list(self._tools)

    async def call(self, server: str, tool: str, arguments: dict[str, Any]) -> Any:
        s = self.servers.get(server)
        if s is None or s.session is None:
            state = s.state if s else "unknown"
            if state == "needs_auth" and s is not None and s.config.connector is not None:
                name = connectors.get(s.config.connector).name
                raise ToolError(f"The MCP server {server} needs a token. Ask the user to connect {name} on the "
                                "Connectors tab of the Capabilities page (/mcp).")
            if state in ("needs_auth", "authenticating"):
                raise ToolError(f"The MCP server {server} needs authentication. Ask the user to click Authenticate "
                                "for it on the MCP servers tab of the Capabilities page (/mcp).")
            raise ToolError(f"The MCP server {server} is not connected ({state}). Ask the user to restart it with /mcp.")
        session = s.session

        async def run() -> Any:
            return await session.call_tool(tool, arguments, read_timeout_seconds=s.config.timeout)

        try:
            return await asyncio.wait_for(self.thread.call(run), s.config.timeout + 5)
        except asyncio.TimeoutError:
            raise ToolError(f"The MCP tool {tool} did not answer in {s.config.timeout:g} seconds.") from None
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - a closed connection, or a protocol error.
            text = _error_text(e)
            if s.session is None or "closed" in text.lower():
                s.state, s.error = "failed", f"The connection closed: {text}"
                self._update_tools()
                await self.send_status()
            raise ToolError(f"The MCP server {server} failed: {text}") from None

    # -- the client ------------------------------------------------------------------------------------------

    def items(self) -> dict[str, Any]:
        names = {t.remote_name: t.name for t in self._tools}
        return {
            "type": "mcp",
            "items": [s.to_json({k: v for k, v in names.items()}) for s in self.servers.values()],
            "problems": self.problems,
            "paths": {"user": str(user_config_path()), "project": ".harness/mcp.json"},
        }

    async def send_status(self) -> None:
        await self.emit(self.items())


class _ConnectorMissing(Exception):
    """The connector of a server has no token."""


async def _call(fn: Callable[[], Any]) -> Any:
    """Run a plain function in the MCP loop (with LoopThread.call)."""
    return fn()


def _oauth_errors() -> tuple[type[BaseException], ...]:
    from mcp.client.auth import OAuthFlowError, OAuthRegistrationError, OAuthTokenError

    return (OAuthFlowError, OAuthRegistrationError, OAuthTokenError)


class McpTool(Tool):
    """One tool of an MCP server, as a tool of the agent."""

    needs_approval = True

    def __init__(self, manager: McpManager, server: str, tool: Any, name: str):
        self.manager = manager
        self.server = server
        self.remote_name = tool.name
        self.name = name
        text = (tool.description or getattr(tool, "title", None) or tool.name).strip()
        if len(text) > MAX_DESCRIPTION:
            text = text[:MAX_DESCRIPTION] + "..."
        self.description = f"[MCP server {server}] {text}"
        schema = tool.input_schema if isinstance(tool.input_schema, dict) else {}
        if schema.get("type") != "object":
            schema = {"type": "object", "properties": {}}
        schema = {k: v for k, v in schema.items() if k not in ("$schema", "title")}
        schema.setdefault("properties", {})
        self.parameters = schema

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        # "Always" adds a rule for this tool. mcp__<server>__* allows all the tools of the server.
        return Approval(key=json.dumps(args, sort_keys=True, ensure_ascii=False), rule=self.name)

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        result = await self.manager.call(self.server, self.remote_name, args)
        return convert_result(result)


def convert_result(result: Any) -> ToolResult:
    """An MCP CallToolResult as a tool result: text for the model, and the first image."""
    content = getattr(result, "content", None)
    if content is None:
        return ToolResult("The MCP server asked for more input. The harness does not support that yet.", is_error=True)
    texts: list[str] = []
    image: str | None = None
    for part in content:
        kind = getattr(part, "type", "")
        if kind == "text":
            texts.append(part.text)
        elif kind == "image":
            if image is None:
                image = f"data:{part.mime_type};base64,{part.data}"
            texts.append(f"[An image: {part.mime_type}]")
        elif kind == "audio":
            texts.append(f"[Audio: {part.mime_type}. The harness does not play audio.]")
        elif kind == "resource_link":
            texts.append(f"[A resource: {part.uri}{' - ' + part.name if getattr(part, 'name', None) else ''}]")
        elif kind == "resource":
            resource = part.resource
            text = getattr(resource, "text", None)
            texts.append(text if text is not None else f"[A binary resource: {resource.uri} ({resource.mime_type or 'unknown type'})]")
    structured = getattr(result, "structured_content", None)
    if not texts and structured is not None:
        texts.append(json.dumps(structured, indent=2, ensure_ascii=False))
    output = "\n".join(texts).strip() or "(The tool returned no content.)"
    return ToolResult(output, is_error=bool(getattr(result, "is_error", False)), image=image)
