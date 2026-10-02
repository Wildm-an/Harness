"""The WebSocket server. See docs/PROTOCOL.md for the message types."""

from __future__ import annotations

import asyncio
import base64
import binascii
import getpass
import hmac
import json
import logging
import mimetypes
import os
import platform
import secrets
import socket
import string
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from . import __version__
from .agent import Agent
from .config import ConfigError, harness_home, load_settings, project_settings_path, read_json, write_json
from .files import PathError, file_hash, hash_bytes, is_binary, relpath, resolve_in_cwd
from .permissions import DECISIONS, MODES, PermissionRules
from .plugins import Invocation, PluginHost, Prompt, run_command
from .plugins.dsh import BRIDGE as DSH, INSTALL_TIMEOUT as DSH_INSTALL_TIMEOUT, DshError
from .plugins.install import InstallError, install as install_plugin, remove as remove_plugin, set_bundle_enabled
from .plugins.patch import set_row_disabled
from .preview import PreviewHost
from . import provider_config
from .mcp_client import TEMPLATE as MCP_TEMPLATE, McpManager, project_config_path
from .cookbook import hosts as cookbook_hosts
from .cookbook.hosts import HostError
from .cookbook.hub import HubError
from .cookbook.service import COOKBOOK, CookbookError
from .providers import (
    DEFAULT_CONTEXT_LENGTH,
    ContextInfo,
    ModelClient,
    endpoint,
    image_input,
    load_providers,
    model_capabilities,
    resolve_context_length,
    resolve_model,
)
from .tools.base import ToolError
from .tools.grep import search_project
from .tools.search import find_paths
from .tunnels import TUNNELS, TunnelError
from .launch import load_launch, propose, save_launch
from .references import expand_references, session_ids
from .servers import ServerManager
from .prstatus import pr_status
from . import update
from .session import Session
from .keepawake import AWAKE
from .sidechat import NO_TOOLS_REPLY, clean_side_history, side_messages
from .tasks import TaskError, TaskHost
from .skills import Skill, discover_skills, inline_skill_text
from .storage import Storage
from .terminal import TerminalError, TerminalHost
from .suggestions import suggest_prompt
from .titles import summarize_title

log = logging.getLogger("harness.daemon")

AUTH_TIMEOUT = 10
WATCH_INTERVAL = 1.5
MAX_WATCHED = 200
AUTH_FAILED = 4401
MAX_EDITOR_FILE = 5 * 1024 * 1024
HIDDEN_NAMES = {".git"}

BUILTIN_COMMANDS: dict[str, str] = {
    "clear": "Start a new context in the same session.",
    "compact": "Summarize the context.",
    "model": "Show the model, or change it: /model <provider>/<model>.",
    "skills": "Open the Skills panel: the skills and their sources.",
    "local-models": "Open the Local Models screen: find, download, serve, and delete local models.",
    "connections": "Open the Connections screen: the model endpoints and their API keys.",
    "mcp": "Open the MCP panel: the MCP servers of the project and their tools.",
    "plugins": "Open the Plugins screen: install, turn on or off, and remove plugins.",
    "servers": "Open the Servers pane.",
    "preview": "Start the default server and open it in the Browser pane.",
    "help": "List the commands.",
}

BUILTIN_HINTS = {"model": "<provider>/<model>"}
# The old names of commands. They work, but the / menu does not show them.
COMMAND_ALIASES = {"cookbook": "local-models", "providers": "connections"}
# The client panel that a command opens. The panel names stay the same as in the protocol.
PANEL_COMMANDS = {"local-models": "cookbook", "connections": "providers", "servers": "servers", "mcp": "mcp",
                  "plugins": "plugins"}

# Message types of later build phases.
NOT_AVAILABLE: dict[str, str] = {}

# Project files for the Browser pane: a random token for each session -> the project folder.
FILE_ROOTS: dict[str, Path] = {}
# The server managers of all connections. The daemon stops their servers when it stops.
MANAGERS: set[ServerManager] = set()
# The preview hosts of all connections. The daemon stops their agent browsers when it stops.
PREVIEWS: set[PreviewHost] = set()
# The MCP clients of all connections. The daemon stops their servers when it stops.
MCPS: set[McpManager] = set()
MCP_WAIT = 20  # Seconds that the first turn waits for the MCP servers.
# The model checks of a session start: (provider, URL, kind, model, context_length setting) ->
# (the time, the capabilities, the context length). A change to the providers clears it.
MODEL_CHECKS: dict[tuple[Any, ...], tuple[float, list[str] | None, ContextInfo]] = {}
MODEL_CHECKS_TTL = 600

# Project settings that the client can change with "settings.set", and their types.
CLIENT_SETTINGS: dict[str, type] = {"auto_verify": bool, "permission_mode": str}


class ProtocolError(Exception):
    pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    TUNNELS.close_all()  # Close the SSH tunnels to model endpoints.
    stop_all_servers()


def stop_all_servers() -> None:
    """Stop the local servers and the agent browsers of all sessions at once. For a daemon that stops."""
    for manager in list(MANAGERS):
        manager.kill_all_now()
    for host in list(PREVIEWS):
        host.close_now()
    COOKBOOK.stop_all()  # The downloads can continue after the next start. Served models keep running.
    for manager in list(MCPS):
        manager.close_now()
    DSH.stop_now()  # The DeepSeek plugin host.


def create_app(token: str, storage: Storage | None = None) -> FastAPI:
    app = FastAPI(title="harness-daemon", version=__version__, lifespan=lifespan)
    app.state.storage = storage or Storage(harness_home() / "harness.db")

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.websocket("/ws")
    async def ws_endpoint(websocket: WebSocket):
        await websocket.accept()
        try:
            first = json.loads(await asyncio.wait_for(websocket.receive_text(), AUTH_TIMEOUT))
            given = first.get("token") if isinstance(first, dict) and first.get("type") == "auth" else None
        except (asyncio.TimeoutError, json.JSONDecodeError, WebSocketDisconnect):
            given = None
        if not isinstance(given, str) or not hmac.compare_digest(given.encode(), token.encode()):
            # The client can close first, for example a page reload before the auth message.
            try:
                await websocket.close(code=AUTH_FAILED, reason="Bad token")
            except (RuntimeError, WebSocketDisconnect):
                pass
            return
        conn = Connection(websocket, app.state.storage)
        await conn.send({"type": "auth.ok", "version": __version__, "host": host_info(),
                         "updatable": update.refusal() is None})
        await conn.run()

    @app.websocket("/forward")
    async def forward_endpoint(websocket: WebSocket):
        """Forward a TCP connection to a server of launch.json (SPEC.md section 8.6, remote mode).

        Messages: {"type": "auth", "token"}, then {"type": "forward", "session_id", "server"}.
        The daemon replies {"type": "forward.ok"}. Then the binary messages carry the TCP bytes.
        Only the ports of the servers in launch.json can be reached.
        """
        await websocket.accept()
        try:
            first = json.loads(await asyncio.wait_for(websocket.receive_text(), AUTH_TIMEOUT))
            given = first.get("token") if isinstance(first, dict) and first.get("type") == "auth" else None
            if not isinstance(given, str) or not hmac.compare_digest(given.encode(), token.encode()):
                await websocket.close(code=AUTH_FAILED, reason="Bad token")
                return
            request = json.loads(await asyncio.wait_for(websocket.receive_text(), AUTH_TIMEOUT))
            port = _forward_port(app.state.storage, request)
        except (asyncio.TimeoutError, json.JSONDecodeError, WebSocketDisconnect, RuntimeError):
            return
        except ProtocolError as e:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
            await websocket.close(code=4404)
            return
        await _pipe(websocket, port)

    @app.get("/files/{file_token}/{rel_path:path}")
    async def project_file(file_token: str, rel_path: str):
        """A project file for the Browser pane: HTML, PDF, images, and video. Read only."""
        root = FILE_ROOTS.get(file_token)
        if root is None:
            raise HTTPException(status_code=404)
        try:
            path = resolve_in_cwd(root, rel_path or "index.html")
        except PathError:
            raise HTTPException(status_code=404) from None
        if path.is_dir():
            path = path / "index.html"
        if not path.is_file():
            raise HTTPException(status_code=404)
        media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"}
        if media_type in ("text/html", "image/svg+xml"):
            # The page runs in a sandbox with its own origin: it cannot read other daemon URLs.
            headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms allow-popups allow-modals"
        return FileResponse(path, media_type=media_type, headers=headers)

    return app


def _forward_port(storage: Storage, request: Any) -> int:
    if not isinstance(request, dict) or request.get("type") != "forward":
        raise ProtocolError("The second message must be a forward request.")
    row = storage.get_session(str(request.get("session_id") or ""))
    if row is None:
        raise ProtocolError("Unknown session.")
    project = Path(row["cwd"])
    name = request.get("server")
    # A running server can have another port than launch.json (for example, Vite picks a free port).
    for manager in MANAGERS:
        if manager.project == project and name in manager.servers:
            server = manager.servers[name]
            if server.port:
                return server.port
    configs = load_launch(project) or []
    config = next((c for c in configs if c.name == name), None)
    if config is None or not config.port:
        raise ProtocolError(f"The server {name!r} is not in launch.json, or it has no port.")
    return config.port


async def _pipe(websocket: WebSocket, port: int) -> None:
    """Copy bytes between the WebSocket and the local server port."""
    reader = writer = None
    for host in ("127.0.0.1", "::1"):
        try:
            reader, writer = await asyncio.open_connection(host, port)
            break
        except OSError:
            continue
    if writer is None:
        await websocket.send_text(json.dumps({"type": "error", "message": f"Nothing listens on port {port}."}))
        await websocket.close(code=4502)
        return
    await websocket.send_text(json.dumps({"type": "forward.ok"}))

    async def upstream() -> None:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            data = message.get("bytes")
            if data:
                writer.write(data)
                await writer.drain()

    async def downstream() -> None:
        while True:
            data = await reader.read(65536)
            if not data:
                return
            await websocket.send_bytes(data)

    tasks = [asyncio.create_task(upstream()), asyncio.create_task(downstream())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except Exception:  # noqa: BLE001 - one side closed.
        pass
    finally:
        for task in tasks:
            task.cancel()
        writer.close()
        try:
            await websocket.close()
        except (RuntimeError, WebSocketDisconnect):
            pass


def host_info() -> dict[str, str]:
    """The computer that the daemon runs on. The client shows it, because it can be a remote computer."""
    try:
        user = getpass.getuser()
    except Exception:  # noqa: BLE001 - getuser fails in some containers.
        user = ""
    return {
        "hostname": socket.gethostname(),
        "platform": f"{platform.system()} {platform.release()}",
        "user": user,
        "home": str(Path.home()),
        "sep": os.sep,
    }


Handler = Callable[["Connection", dict[str, Any]], Awaitable[None]]
HANDLERS: dict[str, Handler] = {}


def handler(name: str):
    def register(fn: Handler) -> Handler:
        HANDLERS[name] = fn
        return fn
    return register


class LiveSession:
    """A session that is open in a connection: its agent, its turn, its permission requests, and
    its servers, MCP servers, agent browser, and plugins.

    The client sees the events of the current session only. When the client goes to another
    session, a session with a running turn stays open in the background. The connection closes
    it when its turn ends. The client can return to it before that time.
    """

    def __init__(self, conn: Connection):
        self.conn = conn
        self.session: Session | None = None
        self.turn: asyncio.Task | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.requests: dict[str, dict[str, Any]] = {}  # The open permission requests, for a client that returns.
        self.servers: ServerManager | None = None
        self.preview: PreviewHost | None = None
        self.mcp: McpManager | None = None
        self.plugins: PluginHost | None = None  # make_agent loads them.
        self.files_token: str | None = None
        self.terminal: TerminalHost | None = None  # The shell of the terminal pane.
        # The running turn: its start time (epoch seconds) and its output tokens, for the working line.
        self.turn_started: float | None = None
        self.turn_tokens = 0
        self.title_task: asyncio.Task | None = None
        self.suggestion_task: asyncio.Task | None = None  # The next prompt of the user (suggestions.py).
        self.side_tasks: dict[str, asyncio.Task] = {}  # The answers of the side chat that run, by question id.
        self.tasks: TaskHost | None = None  # The background tasks that the agent started (tasks.py).
        # "Keep computer awake" (keepawake.py): only for this session, while the daemon keeps it open.
        self.keep_awake = False

    @property
    def id(self) -> str | None:
        return self.session.id if self.session is not None else None

    @property
    def running(self) -> bool:
        return self.turn is not None and not self.turn.done()

    @property
    def working(self) -> bool:
        """A turn or a background task runs."""
        return self.running or (self.tasks is not None and bool(self.tasks.running))

    @property
    def keep_open(self) -> bool:
        """A session in the background stays open while its turn, a background task, or its shell runs."""
        return self.working or (self.terminal is not None and self.terminal.alive)

    def update_awake(self) -> None:
        """Keep the computer awake while this session works, if its switch is on."""
        AWAKE.hold(self, self.keep_awake and self.working and self.session is not None)

    def tasks_message(self) -> dict[str, Any]:
        items = [t.summary() for t in self.tasks.tasks.values()] if self.tasks is not None else []
        return {"type": "tasks", "items": items}

    def _tasks_changed(self) -> None:
        """A background task started or ended: tell the client, and check the awake state."""
        self.update_awake()
        asyncio.ensure_future(self.send(self.tasks_message()))
        asyncio.ensure_future(self.conn.close_if_done(self))

    async def send(self, message: dict[str, Any]) -> None:
        """Send an event of this session, with its session_id. Only the current session sends to the client."""
        if message.get("type") == "turn.usage":
            self.turn_tokens = int(message.get("completion_tokens") or 0)
        if self.conn.current is self and self.session is not None:
            await self.conn.send({**message, "session_id": self.session.id})

    async def error(self, message: str, ref: str | None = None) -> None:
        body: dict[str, Any] = {"type": "error", "message": message}
        if ref:
            body["ref"] = ref
        await self.send(body)

    async def approve(self, request: dict[str, Any]) -> str:
        fut = asyncio.get_running_loop().create_future()
        request_id = request["request_id"]
        self.pending[request_id] = fut
        self.requests[request_id] = request
        await self.conn.send_running()  # The sidebar shows that the session waits for a decision.
        try:
            await self.send({"type": "permission.request", **request})
            return await fut
        finally:
            self.pending.pop(request_id, None)
            self.requests.pop(request_id, None)
            await self.conn.send_running()

    async def stop_turn(self) -> None:
        if self.turn is not None and not self.turn.done():
            self.turn.cancel()
            try:
                await self.turn
            except asyncio.CancelledError:
                pass
        for fut in self.pending.values():
            if not fut.done():
                fut.set_result("deny")
        self.pending.clear()

    def cancel_suggestion(self) -> None:
        if self.suggestion_task is not None and not self.suggestion_task.done():
            self.suggestion_task.cancel()
        self.suggestion_task = None

    def cancel_side(self, question_id: str | None = None) -> None:
        """Stop one answer of the side chat, or all of them."""
        for key in [question_id] if question_id is not None else list(self.side_tasks):
            task = self.side_tasks.pop(key, None)
            if task is not None and not task.done():
                task.cancel()

    async def close(self) -> None:
        """Stop the shell, the MCP servers, the agent browser, the servers, and the plugins of the
        session, and end its file URLs."""
        self.cancel_suggestion()
        self.cancel_side()
        if self.tasks is not None:
            self.tasks.close()
        AWAKE.hold(self, False)
        if self.terminal is not None:
            self.terminal.close()
            self.terminal = None
        if self.plugins is not None:
            host, self.plugins = self.plugins, None
            await host.dispose()
        if self.mcp is not None:
            manager, self.mcp = self.mcp, None
            MCPS.discard(manager)
            await manager.close()
        if self.preview is not None:
            await self.preview.close()
            PREVIEWS.discard(self.preview)
            self.preview = None
        if self.servers is not None:
            await self.servers.stop_all()
            MANAGERS.discard(self.servers)
            self.servers = None
        if self.files_token:
            FILE_ROOTS.pop(self.files_token, None)
            self.files_token = None

    def start(self) -> None:
        """Start the servers, the agent browser, and the MCP servers of the session."""
        session = self.session
        assert session is not None
        self.plugins = session.agent.plugins
        self.servers = ServerManager(session.cwd, session.agent.ctx.shell, self.send)
        MANAGERS.add(self.servers)
        self.preview = PreviewHost(self.servers, self.send)
        PREVIEWS.add(self.preview)
        session.agent.enable_preview(self.preview)
        self.files_token = secrets.token_urlsafe(24)
        FILE_ROOTS[self.files_token] = session.cwd
        self.tasks = TaskHost(session.cwd, session.agent.ctx.shell, on_change=self._tasks_changed)
        session.agent.enable_tasks(self.tasks)
        self.terminal = TerminalHost(session.cwd, self.send,
                                     on_exit=lambda: asyncio.ensure_future(self.conn.close_if_done(self)))
        # The MCP servers connect in the background. The first turn waits for them (MCP_WAIT).
        host = self.plugins
        self.mcp = McpManager(session.cwd, self.send, session.agent.set_mcp_tools,
                              host.mcp_servers if host is not None else None)
        MCPS.add(self.mcp)
        asyncio.create_task(self._start_mcp(self.mcp))

    async def _start_mcp(self, manager: McpManager) -> None:
        try:
            await manager.start()
        except Exception as e:  # noqa: BLE001 - a bad mcp.json must not stop the session.
            log.exception("The MCP servers did not start")
            await self.error(f"The MCP servers did not start: {e}", ref="mcp")

    async def wait_for_mcp(self) -> None:
        if self.mcp is not None:
            await self.mcp.ready(MCP_WAIT)


def _delegate(name: str) -> property:
    """A Connection attribute that reads and writes the attribute of the current session."""
    def get(conn: Connection) -> Any:
        return getattr(conn.current, name) if conn.current is not None else None

    def set_(conn: Connection, value: Any) -> None:
        if conn.current is None:
            raise ProtocolError("No session. Send 'session.new' or 'session.resume' first.")
        setattr(conn.current, name, value)
    return property(get, set_)


class Connection:
    # The attributes of the current session. A handler acts on the session that the client shows.
    session = _delegate("session")
    turn = _delegate("turn")
    servers = _delegate("servers")
    preview = _delegate("preview")
    mcp = _delegate("mcp")
    plugins = _delegate("plugins")
    files_token = _delegate("files_token")

    def __init__(self, websocket: WebSocket, storage: Storage):
        self.ws = websocket
        self.storage = storage
        self.current: LiveSession | None = None  # The session that the client shows.
        self.live: dict[str, LiveSession] = {}  # The open sessions: the current session and the background sessions.
        self._send_lock = asyncio.Lock()
        self._open = True
        # The files that the editor has open: relative path -> the last known hash.
        self.watched: dict[str, str | None] = {}
        self._watcher: asyncio.Task | None = None
        self._running_sent: list[dict[str, Any]] | None = None
        # The plugins of the project on the start screen, for its / menu. A session loads its own plugins.
        self._start_plugins: PluginHost | None = None

    @property
    def pending(self) -> dict[str, asyncio.Future]:
        return self.current.pending if self.current is not None else {}

    async def send(self, message: dict[str, Any]) -> None:
        if not self._open:
            return
        if message.get("type") == "fs.changed" and message.get("path") in self.watched:
            # The agent changed an open file. The watcher must not report it again.
            self.watched[message["path"]] = message.get("hash")
        async with self._send_lock:
            try:
                await self.ws.send_text(json.dumps(message))
            except (WebSocketDisconnect, RuntimeError):
                self._open = False

    async def error(self, message: str, ref: str | None = None, data: dict[str, Any] | None = None) -> None:
        body: dict[str, Any] = {"type": "error", "message": message}
        if ref:
            body["ref"] = ref
        if data:
            body["data"] = data
        await self.send(body)

    async def watch_files(self) -> None:
        """Report changes to the open files that the agent tools and the editor did not make.

        A change during a turn is probably from a bash command of the agent.
        """
        while self._open:
            await asyncio.sleep(WATCH_INTERVAL)
            session = self.session
            if session is None or not self.watched:
                continue
            for rel, known in list(self.watched.items())[:MAX_WATCHED]:
                try:
                    path = resolve_in_cwd(session.cwd, rel)
                    current = await asyncio.to_thread(file_hash, path)
                except (PathError, OSError):
                    continue
                if rel in self.watched and current != self.watched[rel]:
                    self.watched[rel] = current
                    running = self.turn is not None and not self.turn.done()
                    await self.send({"type": "fs.changed", "path": rel, "hash": current,
                                     "by": "agent" if running else "external"})

    async def run(self) -> None:
        self._watcher = asyncio.create_task(self.watch_files())
        COOKBOOK.listen(self.send)  # Download and serve events of the Cookbook.
        try:
            while True:
                try:
                    raw = await self.ws.receive_text()
                except (WebSocketDisconnect, RuntimeError):
                    break
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await self.error("The message is not valid JSON.")
                    continue
                if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
                    await self.error("The message must be a JSON object with a 'type' field.")
                    continue
                kind = msg["type"]
                fn = HANDLERS.get(kind)
                if fn is None:
                    reason = f"'{kind}' is part of {NOT_AVAILABLE[kind]}, which is not in this build yet." \
                        if kind in NOT_AVAILABLE else f"Unknown message type: {kind}"
                    await self.error(reason, ref=kind)
                    continue
                try:
                    await fn(self, msg)
                except (ProtocolError, ConfigError, PathError, HostError, HubError, CookbookError, InstallError,
                        TerminalError) as e:
                    await self.error(str(e), ref=kind)
                except Exception as e:  # noqa: BLE001 - report the error and keep the connection.
                    log.exception("Handler %s failed", kind)
                    await self.error(f"Internal error: {type(e).__name__}: {e}", ref=kind)
        finally:
            self._open = False
            COOKBOOK.unlisten(self.send)
            if self._watcher:
                self._watcher.cancel()
            for live in list(self.live.values()):
                await live.stop_turn()
                await live.close()
            self.live.clear()
            self.current = None
            await self.drop_start_plugins()

    # -- helpers ---------------------------------------------------------

    def require_session(self) -> Session:
        if self.session is None:
            raise ProtocolError("No session. Send 'session.new' or 'session.resume' first.")
        return self.session

    def require_live(self) -> LiveSession:
        if self.current is None or self.current.session is None:
            raise ProtocolError("No session. Send 'session.new' or 'session.resume' first.")
        return self.current

    async def leave_current(self) -> None:
        """The client goes away from the current session. A session with a running turn or shell stays open."""
        live, self.current = self.current, None
        self.watched.clear()
        if live is not None and not live.keep_open:
            await self.close_live(live)

    async def close_if_done(self, live: LiveSession) -> None:
        """Close a session in the background when its turn and its shell have stopped."""
        if live is not self.current and not live.keep_open:
            await self.close_live(live)

    async def close_live(self, live: LiveSession) -> None:
        if live.id is not None and self.live.get(live.id) is live:
            del self.live[live.id]
        await live.close()

    async def open_session(self, live: LiveSession) -> None:
        """Make a new session the current session, and start its servers."""
        await self.leave_current()
        assert live.session is not None
        self.live[live.session.id] = live
        live.start()
        self.current = live

    async def send_running(self) -> None:
        """Tell the client which sessions have a running turn. The sidebar shows them."""
        for live in self.live.values():
            live.update_awake()  # A turn started or ended.
        items = [{"session_id": sid, "waiting": bool(live.pending)}
                 for sid, live in self.live.items() if live.running]
        if items != self._running_sent:
            self._running_sent = items
            await self.send({"type": "sessions.running", "items": items})

    def require_servers(self) -> ServerManager:
        self.require_session()
        assert self.servers is not None
        return self.servers

    async def approve_server(self, name: str) -> bool:
        """The first start of a server command needs approval. "Always" adds a server(<command>) rule."""
        session = self.require_session()
        config = self.require_servers().get(name).config
        rules = PermissionRules(session.cwd)
        if rules.denies("server", config.command):
            return False
        if rules.allows("server", config.command):
            return True
        rule = f"server({config.command})"
        decision = await self.require_live().approve({
            "request_id": secrets.token_hex(16),
            "tool": "server",
            "input": {"name": name, "command": config.command, "cwd": config.cwd},
            "diff": None,
            "rule": rule,
        })
        if decision == "allow_always":
            rules.add_allow(rule)
        return decision in ("allow_once", "allow_always")

    async def start_server(self, name: str) -> None:
        manager = self.require_servers()
        try:
            manager.get(name)
        except KeyError:
            raise ProtocolError(f"Unknown server: {name}. The servers are in .harness/launch.json.") from None
        if not await self.approve_server(name):
            await self.send({**manager.get(name).status(), "error": "You denied the start of this server."})
            return
        await manager.start(name)

    def require_idle(self) -> None:
        if self.turn is not None and not self.turn.done():
            raise ProtocolError("A turn is running. Send 'interrupt' first, or wait for 'turn.end'.")

    async def make_agent(self, live: LiveSession, cwd: Path, provider_name: str | None, model: str | None,
                         history: list[dict] | None = None, summary: str | None = None) -> tuple[Agent, list[str]]:
        settings = load_settings(cwd)
        await self.drop_start_plugins()  # The session loads its own plugins.
        # The plugins load first: a plugin can register the provider of the model.
        plugins = PluginHost(cwd)
        await plugins.load()
        try:
            provider, model_name = resolve_model(model or settings.get("default_model"), provider_name)
            warnings, context, images = await self.model_checks(provider, model_name, settings)
            agent = Agent(cwd=cwd, client=ModelClient(provider, model_name), emit=live.send,
                          approver=live.approve, settings=settings, history=history,
                          summary=summary, context_length=context.length,
                          skills=discover_skills(cwd, plugins.skill_roots(), plugins.dsh_skills()),
                          image_input=images, context_source=context.source, plugins=plugins)
        except BaseException:
            await plugins.dispose()
            raise
        warnings += [f"The plugin {s.row.id} did not load: {s.error}" for s in plugins.rows.values()
                     if s.state == "failed"]
        return agent, warnings

    @staticmethod
    async def model_checks(provider, model: str, settings: dict[str, Any]) -> tuple[list[str], ContextInfo, bool]:
        """Check tool support, find the context length, and find if the model accepts images.

        Return the warnings, the context length with its source, and the image input flag.
        """
        try:
            reachable = await endpoint(provider)  # Opens the SSH tunnel of the provider, if it has one.
        except TunnelError as e:
            configured = settings.get("context_length") or provider.context_length
            context = ContextInfo(int(configured), "settings") if configured else ContextInfo(DEFAULT_CONTEXT_LENGTH, "default")
            return [str(e)], context, image_input(provider, model, settings, None)
        # The checks send requests to the endpoint (up to a few seconds). A session switch uses the saved result.
        key = (provider.name, reachable.base_url, reachable.kind, model, settings.get("context_length"))
        saved = MODEL_CHECKS.get(key)
        if saved is not None and time.monotonic() - saved[0] < MODEL_CHECKS_TTL:
            caps, context = saved[1], saved[2]
        else:
            caps, context = await asyncio.gather(
                model_capabilities(reachable, model), resolve_context_length(reachable, model, settings))
            MODEL_CHECKS[key] = (time.monotonic(), caps, context)
        support = None if caps is None else "tools" in caps
        warnings = []
        if provider.key_missing:
            warnings.append(f"The provider {provider.name} has no API key. {provider.key_missing} "
                            "Open the Connections screen to enter the key.")
        if support is False:
            warnings.append(f"The model {model} does not support tool calls. "
                            "The agent cannot read files, edit files, or run commands.")
        if context.warning:
            warnings.append(context.warning)
        # "provider" (not "reachable"): the models of providers.json use the configured name.
        return warnings, context, image_input(provider, model, settings, caps)

    async def send_ready(self, warnings: list[str]) -> None:
        """Send the current session to the client. Build the message before the first await:
        the events of a running turn that come after it go to the client after it."""
        live = self.require_live()
        s = live.session
        assert s is not None
        running = live.running
        await self.send({
            "type": "session.ready",
            "session_id": s.id,
            "cwd": str(s.cwd),
            "model": s.agent.client.label,
            "title": s.title,
            "warnings": warnings,
            "history": s.agent.history,
            "summary": s.agent.summary,
            "context_length": s.agent.context_length,
            "context_tokens": s.agent.context_tokens(),
            "context_source": s.agent.context_source,
            "instructions": s.agent.instructions.name if s.agent.instructions else None,
            "files_token": live.files_token,
            "project": _project_ref(self.storage, s.cwd),
            "auto_verify": bool(s.agent.settings.get("auto_verify")),
            "permission_mode": _permission_mode(s.agent.settings),
            "image_input": s.agent.image_input,
            "keep_awake": live.keep_awake,  # The switch of this session. It is not saved.
            # A client that returns to a session with a running turn: the reply text that streams
            # now, and the permission requests that wait for a decision.
            "running": running,
            "partial": "".join(s.agent.streamed) if running and s.agent.streamed else None,
            "requests": list(live.requests.values()) if running else [],
            "turn_started_at": live.turn_started if running else None,
            "turn_tokens": live.turn_tokens if running else 0,
        })

    async def run_turn(self, live: LiveSession, text: str, display: str | None = None,
                       message_id: str | None = None) -> None:
        """Run a prompt. ``display`` is the text that the user sees, if it is not ``text``: the client
        shows a session reference with its name, and sends it with its id."""
        session = live.session
        assert session is not None
        if session.set_title_from(display or text):
            self.start_title(live, display or text)
        # "@" references: add the files, lines, and sessions to the prompt. Load the referenced
        # sessions here: the file reads run in a thread, and the database stays in this loop.
        stored = {}
        for sid in session_ids(text):
            row = self.storage.get_session(sid)
            if row is not None and sid != session.id:
                stored[sid] = (row, self.storage.load_messages(sid))
        expanded = await asyncio.to_thread(expand_references, text, session.cwd, stored.get)
        await live.wait_for_mcp()
        await self.refresh_dsh(live)
        # "/name" skills in the typed text (not in the referenced files): add their instructions.
        # Read the skills after refresh_dsh, so that the skills of a DeepSeek plugin are current.
        if live.tasks is not None:
            notes = live.tasks.take_ended_notes()
            if notes:
                expanded = f"{expanded}\n\n" + "\n".join(f"[{note}]" for note in notes)
        allow: tuple[str, ...] = ()
        if "/" in text:
            def skill_block() -> tuple[str, tuple[str, ...]]:
                # The same skills as the / menu: a built-in or plugin command hides a skill.
                hidden = set(BUILTIN_COMMANDS) | set(live.plugins.commands() if live.plugins is not None else ())
                skills = {n: s for n, s in self.skills(live).items() if n not in hidden}
                return inline_skill_text(text, skills, session.cwd)

            block, allow = await asyncio.to_thread(skill_block)
            if block:
                expanded = f"{expanded}\n\n{block}"
        try:
            shown = display or text
            stop = await session.agent.run_turn(expanded, display=shown if expanded != shown else None, allow=allow,
                                                message_id=message_id)
        finally:
            session.persist()
        if stop == "end":
            self.start_suggestion(live)

    async def start_turn(self, work: Callable[[LiveSession], Awaitable[None]]) -> None:
        """Start a turn in the current session. The turn continues if the client goes to another session."""
        live = self.require_live()
        self.require_idle()
        live.cancel_suggestion()  # The model can start the turn at once.
        live.turn_started = time.time()
        live.turn_tokens = 0
        live.turn = asyncio.create_task(self.guarded(live, work(live)))
        await self.send_running()

    def start_title(self, live: LiveSession, prompt: str) -> None:
        """Ask the model for a short title of the first prompt. It runs next to the turn."""
        session = live.session
        assert session is not None

        async def work() -> None:
            title = await summarize_title(session.agent.client, prompt)
            if not title:
                return
            session.title = title
            self.storage.update_session(session.id, title=title)
            # Not a session event: the sidebar shows the title also when the session is in the background.
            await self.send({"type": "session.title", "id": session.id, "title": title})

        live.title_task = asyncio.create_task(work())

    def start_suggestion(self, live: LiveSession) -> None:
        """After a turn, ask the model for the next prompt of the user. The client shows it in the
        empty prompt box. The "prompt_suggestions" setting can switch it off."""
        session = live.session
        assert session is not None
        if not session.agent.settings.get("prompt_suggestions", True):
            return
        history = list(session.agent.history)

        async def work() -> None:
            text = await suggest_prompt(session.agent.client, history)
            if text and not live.running:
                await live.send({"type": "prompt.suggestion", "text": text})

        live.cancel_suggestion()
        live.suggestion_task = asyncio.create_task(work())

    async def guarded(self, live: LiveSession, work: Awaitable[None]) -> None:
        """Run a turn. An unexpected error ends the turn with an error, so the client does not wait forever.

        After the turn, close the session if the client went to another session.
        """
        try:
            await work
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("The turn failed")
            await live.error(f"Internal error in the turn: {type(e).__name__}: {e}")
            usage: dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0, "last_prompt_tokens": 0,
                                     "context_tokens": 0, "context_length": 0}
            if live.session is not None:
                usage.update(context_tokens=live.session.agent.context_tokens(),
                             context_length=live.session.agent.context_length)
            await live.send({"type": "turn.end", "usage": usage, "stop_reason": "error"})
        finally:
            if live.turn is asyncio.current_task():
                live.turn = None  # The session is idle now. A new prompt can start.
            await self.send_running()
            await self.close_if_done(live)

    def skills(self, live: LiveSession | None = None) -> dict[str, Skill]:
        """The skills now on disk. The user can add a skill during a session."""
        live = live or self.current
        session = live.session if live is not None else None
        host = live.plugins if live is not None else None
        return discover_skills(session.cwd if session else None,
                               host.skill_roots() if host is not None else None,
                               host.dsh_skills() if host is not None else None)

    async def refresh_dsh(self, live: LiveSession) -> None:
        """Before a turn: read the DeepSeek plugin tools, commands, skills, and prompt text again.

        A DeepSeek plugin can change them at any time, and a prompt section can be a function.
        """
        session, host = live.session, live.plugins
        if session is None or host is None or host.dsh is None:
            return
        try:
            await host.dsh.refresh()
        except DshError as e:
            log.warning("The DeepSeek plugins did not refresh: %s", e)
            return
        session.agent.set_plugins(host)
        session.agent.set_skills(self.skills(live))

    async def start_plugins(self, folder: Path) -> PluginHost:
        """The plugins of a project with no session, for the / menu of the start screen.
        They stay loaded while the start screen shows the same project."""
        host = self._start_plugins
        if host is not None and host.cwd == folder:
            return host
        await self.drop_start_plugins()
        host = PluginHost(folder)
        await host.load()
        self._start_plugins = host
        return host

    async def drop_start_plugins(self) -> None:
        host, self._start_plugins = self._start_plugins, None
        if host is not None:
            await host.dispose()

    async def reload_plugins(self) -> None:
        """Load the plugins of the session again, after an install or a change of the plugin files."""
        await self.drop_start_plugins()  # The start screen loads them again for its next / menu.
        session, host = self.session, self.plugins
        if session is None or host is None:
            return
        self.require_idle()
        old_mcp = host.mcp_servers()
        await host.load()
        session.agent.set_plugins(host)
        session.agent.set_skills(self.skills())
        if self.mcp is not None and host.mcp_servers() != old_mcp:
            manager = self.mcp

            async def restart() -> None:
                await manager.restart()
            _background(self, "mcp.restart", restart)

    async def run_plugin_command(self, name: str, args: str) -> bool:
        """Run the / command of a plugin. Return False if no plugin has the command."""
        command = self.plugins.commands().get(name) if self.plugins is not None else None
        if command is None:
            return False
        session = self.require_session()
        try:
            value = await run_command(command, Invocation(name, args, session.cwd, session.id))
        except Exception as e:  # noqa: BLE001 - a plugin bug must not close the connection.
            log.exception("The plugin command /%s failed", name)
            raise ProtocolError(f"The plugin command /{name} failed: {type(e).__name__}: {e}") from None
        if isinstance(value, Prompt):
            display = f"/{name} {args}".strip()
            await self.start_turn(lambda live: self.run_turn(live, value.text, display))
            return True
        text = "" if value is None else value if isinstance(value, str) else json.dumps(value, indent=2, default=str)
        await self.send({"type": "command.result", "name": name, "text": text})
        return True

    async def run_skill(self, live: LiveSession, skill: Skill, args: str) -> None:
        session = live.session
        assert session is not None
        session.set_title_from(f"/{skill.name} {args}")
        await live.wait_for_mcp()
        await self.refresh_dsh(live)
        try:
            await session.agent.run_skill(skill, args)
        finally:
            session.persist()

    async def run_compact(self, live: LiveSession) -> None:
        session = live.session
        assert session is not None
        try:
            await session.agent.run_compact()
        finally:
            session.persist()


def _project_ref(storage: Storage, cwd: Path) -> dict[str, str] | None:
    """The saved project of a session folder: its id and name."""
    found = storage.find_project(str(cwd))
    return {"id": found["id"], "name": found["name"]} if found else None


def _project_dir(value: Any) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ProtocolError("'cwd' is required.")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ProtocolError("'cwd' must be an absolute path.")
    if not path.is_dir():
        raise ProtocolError(f"The folder does not exist: {value}")
    return path.resolve()


def _text_arg(msg: dict[str, Any], key: str) -> str:
    value = msg.get(key)
    if not isinstance(value, str):
        raise ProtocolError(f"'{key}' must be a string.")
    return value


# -- sessions ----------------------------------------------------------------


# A session with a running turn stays open when the client goes to another session or to the
# start screen. "session.resume" of an open session shows it again, with its running turn.


@handler("session.new")
async def on_session_new(conn: Connection, msg: dict[str, Any]) -> None:
    cwd = _project_dir(msg.get("cwd"))
    mode = msg.get("permission_mode")
    if mode is not None:
        # The mode of the start page. It is a project setting, as with settings.set.
        if mode not in MODES:
            raise ProtocolError(f"'permission_mode' must be one of: {', '.join(MODES)}.")
        path = project_settings_path(cwd)
        data = read_json(path, {})
        if (data.get("permission_mode") or "default") != mode:
            data["permission_mode"] = mode
            write_json(path, data)
    live = LiveSession(conn)
    agent, warnings = await conn.make_agent(live, cwd, msg.get("provider"), msg.get("model"))
    session_id = conn.storage.create_session(str(cwd), agent.client.provider.name, agent.client.model)
    conn.storage.touch_project(str(cwd))  # A new folder becomes a project.
    live.session = Session(conn.storage, session_id, agent)
    await conn.open_session(live)
    await conn.send_ready(warnings)


@handler("session.resume")
async def on_session_resume(conn: Connection, msg: dict[str, Any]) -> None:
    session_id = _text_arg(msg, "session_id")
    live = conn.live.get(session_id)
    if live is not None:
        # The session is open: the current session, or a session with a running turn.
        if live is not conn.current:
            await conn.leave_current()
            conn.current = live
        await conn.send_ready([])  # No await between the change of the current session and the message.
        return
    await _open_stored(conn, session_id)


async def _open_stored(conn: Connection, session_id: str) -> None:
    """Open a stored session in its folder, and make it the current session."""
    row = conn.storage.get_session(session_id)
    if row is None:
        raise ProtocolError(f"Unknown session: {session_id}")
    cwd = _project_dir(row["cwd"])
    history = conn.storage.load_messages(session_id)
    live = LiveSession(conn)
    agent, warnings = await conn.make_agent(live, cwd, row["provider"], row["model"], history, row["summary"])
    conn.storage.touch_project(str(cwd))
    live.session = Session(conn.storage, session_id, agent, title=row["title"])
    await conn.open_session(live)
    await conn.send_ready(warnings)


@handler("session.move")
async def on_session_move(conn: Connection, msg: dict[str, Any]) -> None:
    """Move a session to another folder: {"session_id", "cwd"}. The history stays. Not during a turn.

    The session opens again in the new folder: its servers, MCP servers, and shell start there.
    """
    session_id = _text_arg(msg, "session_id")
    cwd = _project_dir(msg.get("cwd"))
    if conn.storage.get_session(session_id) is None:
        raise ProtocolError(f"Unknown session: {session_id}")
    live = conn.live.get(session_id)
    if live is not None:
        if live.running:
            raise ProtocolError("A turn is running. Send 'interrupt' first, or wait for 'turn.end'.")
        if live is conn.current:
            conn.current = None
            conn.watched.clear()
        await conn.close_live(live)
    conn.storage.update_session(session_id, cwd=str(cwd))
    await _open_stored(conn, session_id)


MAX_TITLE = 120


@handler("session.update")
async def on_session_update(conn: Connection, msg: dict[str, Any]) -> None:
    """Rename, pin, or archive a session: {"session_id", "title"?, "pinned"?, "archived"?}. The age of the session stays."""
    session_id = _text_arg(msg, "session_id")
    if conn.storage.get_session(session_id) is None:
        raise ProtocolError(f"Unknown session: {session_id}")
    fields: dict[str, Any] = {}
    if "title" in msg:
        title = _text_arg(msg, "title").strip()
        if not title:
            raise ProtocolError("The name of the session is empty.")
        fields["title"] = title[:MAX_TITLE]
    if "pinned" in msg:
        if not isinstance(msg["pinned"], bool):
            raise ProtocolError("'pinned' must be true or false.")
        fields["pinned"] = int(msg["pinned"])
    if "archived" in msg:
        if not isinstance(msg["archived"], bool):
            raise ProtocolError("'archived' must be true or false.")
        fields["archived"] = int(msg["archived"])
    if not fields:
        raise ProtocolError("Give 'title', 'pinned', or 'archived'.")
    conn.storage.update_session(session_id, touch=False, **fields)
    live = conn.live.get(session_id)
    if live is not None and live.session is not None and "title" in fields:
        live.session.title = fields["title"]
    row = conn.storage.get_session(session_id)
    await conn.send({"type": "session.updated", "id": session_id, "title": row["title"], "pinned": bool(row["pinned"]),
                     "archived": bool(row["archived"])})


@handler("session.delete")
async def on_session_delete(conn: Connection, msg: dict[str, Any]) -> None:
    """Delete a session and its messages. A running turn and a shell of the session stop."""
    session_id = _text_arg(msg, "session_id")
    if conn.storage.get_session(session_id) is None:
        raise ProtocolError(f"Unknown session: {session_id}")
    live = conn.live.get(session_id)
    if live is not None:
        if live is conn.current:
            conn.current = None
            conn.watched.clear()
        await live.stop_turn()
        await conn.close_live(live)
        await conn.send_running()
    conn.storage.delete_session(session_id)
    await conn.send({"type": "session.deleted", "id": session_id})


@handler("session.leave")
async def on_session_leave(conn: Connection, msg: dict[str, Any]) -> None:
    """The client shows the start screen. A running turn of the session continues in the background."""
    await conn.leave_current()


# -- the terminal pane ------------------------------------------------------------------------------


def _term_size(msg: dict[str, Any]) -> tuple[int, int]:
    cols, rows = msg.get("cols"), msg.get("rows")
    if not isinstance(cols, int) or not isinstance(rows, int) or not (2 <= cols <= 1000 and 1 <= rows <= 500):
        raise ProtocolError("'cols' and 'rows' must be the size of the terminal.")
    return cols, rows


def _terminal(conn: Connection) -> TerminalHost:
    live = conn.require_live()
    assert live.terminal is not None
    return live.terminal


@handler("term.open")
async def on_term_open(conn: Connection, msg: dict[str, Any]) -> None:
    """Show a shell of the session: a running shell with its last output, or a new shell.

    "id": the shell of a tab. "new": true starts a new shell, for a new tab. With neither, the
    first running shell. "since": the number of the last output that the client has for the shell
    "id" (0: none). The reply has only the output after it, or all the kept output with "reset":
    true. "ref" comes back in the reply, so that the client knows the tab of a new shell.
    """
    live = conn.require_live()
    host = _terminal(conn)
    cols, rows = _term_size(msg)
    since = msg.get("since") if isinstance(msg.get("since"), int) else 0
    wanted = msg.get("id") if isinstance(msg.get("id"), str) else None
    shell = live.session.agent.settings.get("terminal_shell") if live.session else None
    terminal, new = host.open(cols, rows, shell if isinstance(shell, str) and shell else None,
                              terminal_id=wanted, new=msg.get("new") is True)
    replay, seq, reset = terminal.replay(0 if new or wanted != terminal.id else since)
    reply = {"type": "term.opened", "id": terminal.id, "new": new, "replay": replay, "seq": seq, "reset": reset}
    if isinstance(msg.get("ref"), str):
        reply["ref"] = msg["ref"]
    await live.send(reply)


# -- background tasks (tasks.py) and "Keep computer awake" (keepawake.py) ---------------------------


def _tasks(conn: Connection) -> TaskHost:
    live = conn.require_live()
    assert live.tasks is not None
    return live.tasks


@handler("tasks.list")
async def on_tasks_list(conn: Connection, msg: dict[str, Any]) -> None:
    """The background tasks of the session. The daemon also sends "tasks" when a task starts or ends."""
    _tasks(conn)
    await conn.current.send(conn.current.tasks_message())  # type: ignore[union-attr]


@handler("task.get")
async def on_task_get(conn: Connection, msg: dict[str, Any]) -> None:
    """One background task with its output, for the Background tasks pane."""
    try:
        task = _tasks(conn).get(_text_arg(msg, "id"))
    except TaskError as e:
        raise ProtocolError(str(e)) from None
    await conn.current.send({"type": "task", **task.summary(), "output": task.output,  # type: ignore[union-attr]
                             "dropped": task.dropped})


@handler("task.stop")
async def on_task_stop(conn: Connection, msg: dict[str, Any]) -> None:
    try:
        await _tasks(conn).stop(_text_arg(msg, "id"))
    except TaskError as e:
        raise ProtocolError(str(e)) from None


@handler("session.keep_awake")
async def on_keep_awake(conn: Connection, msg: dict[str, Any]) -> None:
    """The "Keep computer awake" switch of the session. It is not saved: only for this session."""
    live = conn.require_live()
    live.keep_awake = msg.get("on") is True
    live.update_awake()
    await live.send({"type": "keep_awake", "on": live.keep_awake, "active": AWAKE.active})


# -- the side chat (sidechat.py) -------------------------------------------------------------------

MAX_SIDE_QUESTIONS = 4  # Answers of the side chat that run at the same time.


@handler("side.ask")
async def on_side_ask(conn: Connection, msg: dict[str, Any]) -> None:
    """A quick question beside the main thread. The model sees the full session, and nothing is
    added to it. The answer streams as "side.token", then "side.done" or "side.error". It can
    run during a turn of the session."""
    live = conn.require_live()
    session = live.session
    assert session is not None
    question_id = _text_arg(msg, "id")
    question = _text_arg(msg, "question").strip()
    if not question or len(question_id) > 64:
        raise ProtocolError("'question' must not be empty, and 'id' must have at most 64 characters.")
    live.side_tasks = {k: t for k, t in live.side_tasks.items() if not t.done()}
    if len(live.side_tasks) >= MAX_SIDE_QUESTIONS:
        raise ProtocolError("Too many side questions run now. Wait for an answer, or stop one.")
    agent = session.agent
    # A copy of the session now: the main thread can change during the answer.
    messages = side_messages(agent.messages(), clean_side_history(msg.get("history")), question)
    tools = agent.tool_schemas()

    async def token(text: str) -> None:
        await live.send({"type": "side.token", "id": question_id, "text": text})

    async def work() -> None:
        try:
            response = await agent.client.stream(messages, tools, token)
            text = response.text
            if not text.strip() and response.tool_calls:
                text = NO_TOOLS_REPLY
                await token(text)
            await live.send({"type": "side.done", "id": question_id, "text": text})
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - report the error in the side chat.
            log.info("A side question failed: %s", e)
            await live.send({"type": "side.error", "id": question_id, "message": str(e) or type(e).__name__})
        finally:
            live.side_tasks.pop(question_id, None)

    live.cancel_side(question_id)
    live.side_tasks[question_id] = asyncio.create_task(work())


@handler("side.cancel")
async def on_side_cancel(conn: Connection, msg: dict[str, Any]) -> None:
    """Stop an answer of the side chat."""
    conn.require_live().cancel_side(_text_arg(msg, "id"))


@handler("term.close")
async def on_term_close(conn: Connection, msg: dict[str, Any]) -> None:
    """The user closed a tab of the terminal pane: stop its shell."""
    _terminal(conn).close_one(_text_arg(msg, "id"))


@handler("term.input")
async def on_term_input(conn: Connection, msg: dict[str, Any]) -> None:
    _terminal(conn).get(_text_arg(msg, "id")).write(_text_arg(msg, "data"))


@handler("term.resize")
async def on_term_resize(conn: Connection, msg: dict[str, Any]) -> None:
    cols, rows = _term_size(msg)
    _terminal(conn).get(_text_arg(msg, "id")).resize(cols, rows)


MAX_SESSION_LIST = 500


@handler("session.list")
async def on_session_list(conn: Connection, msg: dict[str, Any]) -> None:
    """The stored sessions, newest first. "limit" is 50 by default (at most 500)."""
    cwd = msg.get("cwd")
    limit = msg.get("limit")
    limit = min(limit, MAX_SESSION_LIST) if isinstance(limit, int) and limit > 0 else 50
    items = conn.storage.list_sessions(cwd if isinstance(cwd, str) else None, limit=limit)
    await conn.send({"type": "sessions", "items": items, "cwd": cwd if isinstance(cwd, str) else None})


@handler("git.pr_status")
async def on_git_pr_status(conn: Connection, msg: dict[str, Any]) -> None:
    """The branch and the pull request of project folders: {"paths"}. The reply is "pr_status".

    It runs as a task: gh can be slow, and the connection stays free for other messages.
    """
    paths = [p for p in _str_list(msg, "paths") if p.strip()][:MAX_PR_PATHS]

    async def work() -> None:
        try:
            items = await pr_status(paths)
        except Exception as e:  # noqa: BLE001 - the sidebar shows no status.
            log.exception("PR status failed")
            await conn.error(f"Internal error: {type(e).__name__}: {e}", ref="git.pr_status")
            return
        await conn.send({"type": "pr_status", "items": items})

    asyncio.create_task(work())


# -- projects: saved project folders (the start screen) -----------------------------------

MAX_PROJECT_NAME = 80
MAX_PR_PATHS = 100


async def _send_projects(conn: Connection, saved: str | None = None) -> None:
    items = conn.storage.list_projects()
    for item in items:
        item["exists"] = Path(item["path"]).is_dir()
    body: dict[str, Any] = {"type": "projects", "items": items}
    if saved:
        body["saved"] = saved
    await conn.send(body)


@handler("projects.list")
async def on_projects_list(conn: Connection, msg: dict[str, Any]) -> None:
    await _send_projects(conn)


@handler("projects.save")
async def on_projects_save(conn: Connection, msg: dict[str, Any]) -> None:
    """Add or change a project: {"id"?, "name"?, "path", "create"?}. "create" makes a missing folder."""
    raw = _text_arg(msg, "path").strip()
    if not raw:
        raise ProtocolError("Give the project folder.")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ProtocolError("The project folder must be an absolute path.")
    if not path.exists():
        if not msg.get("create"):
            raise ProtocolError(f"The folder does not exist: {path}. Select \"Create the folder\" to make it.")
        try:
            path.mkdir(parents=True)
        except OSError as e:
            raise ProtocolError(f"The daemon cannot create the folder: {e}") from None
    if not path.is_dir():
        raise ProtocolError(f"Not a folder: {path}")
    path = path.resolve()
    name = str(msg.get("name") or "").strip() or path.name or str(path)
    if len(name) > MAX_PROJECT_NAME:
        raise ProtocolError(f"The name can have {MAX_PROJECT_NAME} characters or less.")
    project_id = msg.get("id") if isinstance(msg.get("id"), str) else None
    try:
        saved = conn.storage.save_project(name, str(path), project_id)
    except ValueError as e:
        raise ProtocolError(str(e)) from None
    await _send_projects(conn, saved)


# -- MCP servers (SPEC.md section 5.7) ---------------------------------------------------------------


def _require_mcp(conn: Connection) -> McpManager:
    conn.require_session()
    if conn.mcp is None:
        raise ProtocolError("The MCP client of the session is not ready.")
    return conn.mcp


@handler("mcp.list")
async def on_mcp_list(conn: Connection, msg: dict[str, Any]) -> None:
    await conn.send(_require_mcp(conn).items())


@handler("mcp.restart")
async def on_mcp_restart(conn: Connection, msg: dict[str, Any]) -> None:
    """Read mcp.json again and connect again: one server ("name"), or all servers (no name)."""
    manager = _require_mcp(conn)
    conn.require_idle()
    name = msg.get("name") if isinstance(msg.get("name"), str) else None

    async def work() -> None:
        await manager.restart(name)

    _background(conn, "mcp.restart", work)


@handler("mcp.init")
async def on_mcp_init(conn: Connection, msg: dict[str, Any]) -> None:
    """Create .harness/mcp.json of the project from a template, if it does not exist."""
    session = conn.require_session()
    path = project_config_path(session.cwd)
    created = not path.exists()
    if created:
        write_json(path, MCP_TEMPLATE)
    await conn.send({"type": "mcp.init", "path": relpath(session.cwd, path), "created": created})


# -- plugins (docs/PLUGINS.md) -----------------------------------------------------------------------
#
# Two kinds of plugins share the Plugins screen: Harness plugins (Python, plugins/host.py) and
# DeepSeek Harness plugins (npm bundles in the Node plugin host, plugins/dsh.py). A message about
# a DeepSeek plugin has "kind": "deepseek".


async def _send_plugins(conn: Connection, **extra: Any) -> None:
    """The Plugins screen. With a session: the loaded plugins. With no session: the rows only, with no plugin code."""
    host = conn.plugins
    if host is None:
        host = PluginHost(None)
        host.scan()
    try:
        deepseek = await DSH.describe()
    except DshError as e:
        deepseek = {"available": True, "running": False, "error": str(e), "bundles": [], "orphans": [], "warnings": []}
    await conn.send({"type": "plugins", "loaded": conn.plugins is not None, **host.describe(), "deepseek": deepseek,
                     **extra})


async def _plugins_changed(conn: Connection, **extra: Any) -> None:
    await conn.reload_plugins()
    await _send_plugins(conn, **extra)


def _plugin_changes_allowed(conn: Connection) -> None:
    # The plugins load again after a change. A running turn must not lose its tools.
    if conn.session is not None:
        conn.require_idle()


def _plugin_kind(msg: dict[str, Any]) -> str:
    kind = msg.get("kind") or "harness"
    if kind not in ("harness", "deepseek"):
        raise ProtocolError("'kind' must be \"harness\" or \"deepseek\".")
    return kind


def _dsh_error(e: DshError) -> ProtocolError:
    return ProtocolError(str(e))


@handler("plugins.list")
async def on_plugins_list(conn: Connection, msg: dict[str, Any]) -> None:
    await _send_plugins(conn)


@handler("plugins.reload")
async def on_plugins_reload(conn: Connection, msg: dict[str, Any]) -> None:
    """Load the plugins of the session again, for example after a change to a plugin file.

    A running DeepSeek plugin host starts again, because Node keeps the old module code.
    """
    _plugin_changes_allowed(conn)
    if DSH.running:
        try:
            await DSH.restart()
        except DshError as e:
            raise _dsh_error(e) from None
    await _plugins_changed(conn)


@handler("plugins.install")
async def on_plugins_install(conn: Connection, msg: dict[str, Any]) -> None:
    """Install a bundle. A git clone or a registry download can be slow, so the work runs as a task.

    Harness: {"source": <folder or git URL>, "replace"?: bool}.
    DeepSeek: {"kind": "deepseek", "source": <npm name, git address, URL, or local path>,
    "approved_builds"?: [<keys that pnpm printed>], "use_mirror"?: bool}. If the install needs build
    scripts, the error has "data": {"pending_builds": [...]}, and the client can send the install again
    with them. If the npm registry cannot be reached, the error has "data": {"mirror": <address>}, and
    the client can ask the user and send the install again with "use_mirror": true.
    """
    source = _text_arg(msg, "source")
    kind = _plugin_kind(msg)
    replace = bool(msg.get("replace"))
    approved = msg.get("approved_builds") or []
    if not isinstance(approved, list) or not all(isinstance(k, str) for k in approved):
        raise ProtocolError("'approved_builds' must be a list of strings.")
    use_mirror = msg.get("use_mirror") is True
    _plugin_changes_allowed(conn)

    async def run() -> None:
        try:
            if kind == "deepseek":
                result = await DSH.request("plugins.install",
                                           {"spec": source, "approvedBuilds": approved, "useMirror": use_mirror},
                                           timeout=DSH_INSTALL_TIMEOUT)
                await DSH.restart()  # The new package code loads in a new process.
                await _plugins_changed(conn, installed=result.get("name"), installed_kind="deepseek")
            else:
                item = await asyncio.to_thread(install_plugin, source, replace)
                await _plugins_changed(conn, installed=item.name, installed_kind="harness")
        except DshError as e:
            data = e.data if isinstance(e.data, dict) else {}
            details: dict[str, Any] = {}
            if data.get("pendingBuilds"):
                details["pending_builds"] = data["pendingBuilds"]
            if data.get("mirror"):
                details["mirror"] = data["mirror"]
            if details:  # The client sends the install again: with the same source and registry.
                details.update(source=source, use_mirror=use_mirror)
            await conn.error(str(e), ref="plugins.install", data=details or None)
        except (InstallError, ConfigError, ProtocolError) as e:
            await conn.error(str(e), ref="plugins.install")
        except Exception as e:  # noqa: BLE001
            log.exception("The plugin install failed")
            await conn.error(f"Internal error: {type(e).__name__}: {e}", ref="plugins.install")

    asyncio.create_task(run())


@handler("plugins.remove")
async def on_plugins_remove(conn: Connection, msg: dict[str, Any]) -> None:
    name = _text_arg(msg, "name")
    kind = _plugin_kind(msg)
    _plugin_changes_allowed(conn)
    if conn.plugins is not None:
        await conn.plugins.dispose()  # Stop the plugin code before its files go.
    if kind == "deepseek":
        try:
            await DSH.request("plugins.remove", {"name": name}, timeout=DSH_INSTALL_TIMEOUT)
            await DSH.restart()
        except DshError as e:
            await conn.reload_plugins()
            raise _dsh_error(e) from None
    else:
        await asyncio.to_thread(remove_plugin, name)
    await _plugins_changed(conn, removed=name)


@handler("plugins.set_bundle")
async def on_plugins_set_bundle(conn: Connection, msg: dict[str, Any]) -> None:
    """Turn a bundle on or off: {"name", "enabled", "kind"?}.

    Harness bundles: the state is in ~/.harness/plugins.json. DeepSeek bundles: the bundle list of
    the profile, ~/.harness/dsh/package.json.
    """
    name = _text_arg(msg, "name")
    if not isinstance(msg.get("enabled"), bool):
        raise ProtocolError("'enabled' must be true or false.")
    kind = _plugin_kind(msg)
    _plugin_changes_allowed(conn)
    if kind == "deepseek":
        try:
            await DSH.request("plugins.set_bundle", {"name": name, "enabled": msg["enabled"]})
        except DshError as e:
            raise _dsh_error(e) from None
    else:
        set_bundle_enabled(name, msg["enabled"])
    await _plugins_changed(conn)


@handler("plugins.set_plugin")
async def on_plugins_set_plugin(conn: Connection, msg: dict[str, Any]) -> None:
    """Turn one plugin row on or off: {"id", "enabled", "kind"?}.

    Harness rows: the value goes to a patch layer (patch.py). DeepSeek rows: the user layer of the
    profile, ~/.harness/dsh/cordis.patch.yml.
    """
    row_id = _text_arg(msg, "id")
    if not isinstance(msg.get("enabled"), bool):
        raise ProtocolError("'enabled' must be true or false.")
    kind = _plugin_kind(msg)
    _plugin_changes_allowed(conn)
    if kind == "deepseek":
        try:
            await DSH.request("plugins.set_row", {"id": row_id, "enabled": msg["enabled"]})
        except DshError as e:
            raise _dsh_error(e) from None
    else:
        try:
            set_row_disabled(row_id, not msg["enabled"], conn.session.cwd if conn.session else None)
        except ValueError as e:
            raise ProtocolError(str(e)) from None
    await _plugins_changed(conn)


# -- the Cookbook (SPEC.md section 7) ----------------------------------------------------------------


COOKBOOK_ERRORS = (ProtocolError, ConfigError, HostError, HubError, CookbookError)


def _background(conn: Connection, kind: str, work: Callable[[], Awaitable[dict[str, Any] | None]]) -> None:
    """Run slow Cookbook work (SSH, Hugging Face) as a task. The connection stays free for other messages."""
    async def run() -> None:
        try:
            reply = await work()
            if reply is not None:
                await conn.send(reply)
        except COOKBOOK_ERRORS as e:
            await conn.error(str(e), ref=kind)
        except Exception as e:  # noqa: BLE001
            log.exception("Cookbook task %s failed", kind)
            await conn.error(f"Internal error: {type(e).__name__}: {e}", ref=kind)

    asyncio.create_task(run())


def _str_list(msg: dict[str, Any], key: str) -> list[str]:
    value = msg.get(key)
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ProtocolError(f"'{key}' must be a list of file names.")
    return value


async def _send_hosts(conn: Connection) -> None:
    hosts = cookbook_hosts.load_hosts()
    await conn.send({"type": "cookbook.hosts", "items": [h.to_json() for h in hosts.values()],
                     "public_key": cookbook_hosts.public_key(), "key_path": str(cookbook_hosts.key_path())})


@handler("cookbook.hosts")
async def on_cookbook_hosts(conn: Connection, msg: dict[str, Any]) -> None:
    await _send_hosts(conn)


@handler("cookbook.host.save")
async def on_cookbook_host_save(conn: Connection, msg: dict[str, Any]) -> None:
    """Add or change a host: {"name", "ssh", "python"?, "llama_server"?, "previous"?}."""
    previous = msg.get("previous") if isinstance(msg.get("previous"), str) else None
    cookbook_hosts.save_host(_text_arg(msg, "name").strip(), msg.get("ssh"), msg.get("python"),
                             msg.get("llama_server"), previous)
    COOKBOOK.hardware.pop(_text_arg(msg, "name").strip(), None)
    await _send_hosts(conn)


@handler("cookbook.host.delete")
async def on_cookbook_host_delete(conn: Connection, msg: dict[str, Any]) -> None:
    cookbook_hosts.delete_host(_text_arg(msg, "name"))
    await _send_hosts(conn)


@handler("cookbook.ssh_key")
async def on_cookbook_ssh_key(conn: Connection, msg: dict[str, Any]) -> None:
    """Make the SSH key of the harness in ~/.harness/ssh/, if it does not exist."""
    await asyncio.to_thread(cookbook_hosts.public_key, True)
    await _send_hosts(conn)


@handler("cookbook.hardware")
async def on_cookbook_hardware(conn: Connection, msg: dict[str, Any]) -> None:
    host = msg.get("host")

    async def work() -> dict[str, Any]:
        info = await COOKBOOK.get_hardware(host, bool(msg.get("refresh")))
        return {"type": "hardware", "host": host or cookbook_hosts.LOCAL, "info": info}

    _background(conn, "cookbook.hardware", work)


@handler("hf.token")
async def on_hf_token(conn: Connection, msg: dict[str, Any]) -> None:
    """The Hugging Face token from the keychain of the client. The daemon keeps it in memory only."""
    token = msg.get("token")
    if token is not None and not isinstance(token, str):
        raise ProtocolError("'token' must be a string or null.")
    COOKBOOK.hub.set_token(token.strip() if token else None)
    await conn.send({"type": "hf.token", "set": COOKBOOK.hub.token is not None})


@handler("hf.search")
async def on_hf_search(conn: Connection, msg: dict[str, Any]) -> None:
    _background(conn, "hf.search", lambda: COOKBOOK.search(msg))


@handler("hf.model")
async def on_hf_model(conn: Connection, msg: dict[str, Any]) -> None:
    repo_id = _text_arg(msg, "repo_id")
    _background(conn, "hf.model", lambda: COOKBOOK.detail(repo_id, msg.get("host")))


@handler("hf.download")
async def on_hf_download(conn: Connection, msg: dict[str, Any]) -> None:
    repo_id = _text_arg(msg, "repo_id")
    files = _str_list(msg, "files")

    async def work() -> None:
        await COOKBOOK.start_download(msg.get("host"), repo_id, files)

    _background(conn, "hf.download", work)


@handler("downloads.list")
async def on_downloads_list(conn: Connection, msg: dict[str, Any]) -> None:
    await conn.send({"type": "downloads", "items": COOKBOOK.download_items()})


@handler("download.pause")
async def on_download_pause(conn: Connection, msg: dict[str, Any]) -> None:
    await COOKBOOK.pause(_text_arg(msg, "id"))


@handler("download.resume")
async def on_download_resume(conn: Connection, msg: dict[str, Any]) -> None:
    await COOKBOOK.resume(_text_arg(msg, "id"))


@handler("download.cancel")
async def on_download_cancel(conn: Connection, msg: dict[str, Any]) -> None:
    download_id = _text_arg(msg, "id")
    _background(conn, "download.cancel", lambda: _none(COOKBOOK.cancel(download_id)))


async def _none(coro: Awaitable[Any]) -> None:
    await coro
    return None


@handler("models.installed")
async def on_models_installed(conn: Connection, msg: dict[str, Any]) -> None:
    _background(conn, "models.installed", lambda: COOKBOOK.installed(msg.get("host")))


@handler("models.delete")
async def on_models_delete(conn: Connection, msg: dict[str, Any]) -> None:
    """Delete model files. "source" is "hf" (the Cookbook downloads, the default), "ollama", or "lmstudio"."""
    source = msg.get("source") or "hf"
    if source == "hf":
        repo_id = _text_arg(msg, "repo_id")
        files = _str_list(msg, "files")
    elif source in ("ollama", "lmstudio"):
        name = _text_arg(msg, "name")
    else:
        raise ProtocolError("'source' must be hf, ollama, or lmstudio.")

    async def work() -> dict[str, Any]:
        if source == "hf":
            await COOKBOOK.delete(msg.get("host"), repo_id, files)
        else:
            await COOKBOOK.delete_other(msg.get("host"), source, name)
        return await COOKBOOK.installed(msg.get("host"))

    _background(conn, "models.delete", work)


@handler("serve.list")
async def on_serve_list(conn: Connection, msg: dict[str, Any]) -> None:
    _background(conn, "serve.list", lambda: COOKBOOK.serves(msg.get("host")))


@handler("serve.start")
async def on_serve_start(conn: Connection, msg: dict[str, Any]) -> None:
    """Start llama-server for a downloaded GGUF file: {"host", "repo_id", "file", "context"?, "port"?}."""
    async def work() -> None:
        await COOKBOOK.serve_start(msg)

    _background(conn, "serve.start", work)


@handler("serve.stop")
async def on_serve_stop(conn: Connection, msg: dict[str, Any]) -> None:
    name = _text_arg(msg, "name")
    _background(conn, "serve.stop", lambda: _none(COOKBOOK.serve_stop(msg.get("host"), name)))


@handler("serve.output")
async def on_serve_output(conn: Connection, msg: dict[str, Any]) -> None:
    name = _text_arg(msg, "name")
    _background(conn, "serve.output", lambda: COOKBOOK.serve_output(msg.get("host"), name))


@handler("projects.delete")
async def on_projects_delete(conn: Connection, msg: dict[str, Any]) -> None:
    """Remove a project from the list. The folder, its files, and its sessions stay."""
    conn.storage.delete_project(_text_arg(msg, "id"))
    await _send_projects(conn)


# -- turns ---------------------------------------------------------------------


@handler("prompt")
async def on_prompt(conn: Connection, msg: dict[str, Any]) -> None:
    conn.require_session()
    conn.require_idle()
    text = _text_arg(msg, "text")
    if not text.strip():
        raise ProtocolError("The prompt is empty.")
    display = msg.get("display")
    shown = display.strip() if isinstance(display, str) and display.strip() else None
    message_id = msg.get("id") if isinstance(msg.get("id"), str) and msg.get("id") else None
    await conn.start_turn(lambda live: conn.run_turn(live, text, shown, message_id))


@handler("steer")
async def on_steer(conn: Connection, msg: dict[str, Any]) -> None:
    """A user message for the running turn. The model reads it at the next step, and the turn continues."""
    session = conn.require_session()
    steer_id = _text_arg(msg, "id")
    text = _text_arg(msg, "text")
    if not text.strip():
        raise ProtocolError("The message is empty.")
    display = msg.get("display")
    shown = display.strip() if isinstance(display, str) and display.strip() else None
    if not session.agent.steer(steer_id, text, shown):
        await conn.require_live().send({"type": "steer.returned", "ids": [steer_id]})  # No turn runs.


@handler("session.rewind")
async def on_session_rewind(conn: Connection, msg: dict[str, Any]) -> None:
    """Go back to the time before a user message: {"id", "conversation": bool, "code": bool}.

    With "conversation", the message and all after it go away, and the client gets the message text
    for the prompt box. With "code", the files that the agent changed after the message get their old content.
    """
    session = conn.require_session()
    conn.require_idle()
    message_id = _text_arg(msg, "id")
    conversation = msg.get("conversation") is not False
    code = msg.get("code") is True
    if not conversation and not code:
        raise ProtocolError("Rewind needs 'conversation', 'code', or both.")
    try:
        text, restored = session.rewind(message_id, conversation, code)
    except ValueError as e:
        raise ProtocolError(str(e)) from None
    live = conn.require_live()
    for path in restored:
        await live.send({"type": "fs.changed", "path": relpath(session.cwd, path), "hash": file_hash(path), "by": "agent"})
    if conversation:
        await conn.send_ready([])
        await live.send({"type": "prompt.fill", "text": text})
    if code:
        count = len(restored)
        files = "No files changed" if count == 0 else f"{count} {'file' if count == 1 else 'files'} restored"
        await live.send({"type": "notice", "level": "info", "text": f"Rewind: {files}. Changes of commands are not restored."})


@handler("session.fork")
async def on_session_fork(conn: Connection, msg: dict[str, Any]) -> None:
    """A new session with the conversation before a user message. The client gets the message text for the prompt box."""
    source = conn.require_session()
    message_id = _text_arg(msg, "id")
    try:
        index = source.user_index(message_id)
    except ValueError as e:
        raise ProtocolError(str(e)) from None
    message = source.agent.history[index]
    history = json.loads(json.dumps(source.agent.history[:index]))
    summary = source.agent.summary
    client = source.agent.client
    live = LiveSession(conn)
    agent, warnings = await conn.make_agent(live, source.cwd, client.provider.name, client.model, history, summary)
    session_id = conn.storage.create_session(str(source.cwd), agent.client.provider.name, agent.client.model)
    conn.storage.append_messages(session_id, history)
    title = f"{source.title} (fork)" if source.title else None
    conn.storage.update_session(session_id, summary=summary, title=title)
    copied = [m["id"] for m in history if m.get("role") == "user" and m.get("id")]
    conn.storage.copy_checkpoints(source.id, session_id, copied)
    conn.storage.touch_project(str(source.cwd))
    live.session = Session(conn.storage, session_id, agent, title=title)
    await conn.open_session(live)
    await conn.send_ready(warnings)
    await live.send({"type": "prompt.fill", "text": message.get("display") or message.get("content") or ""})


@handler("interrupt")
async def on_interrupt(conn: Connection, msg: dict[str, Any]) -> None:
    if conn.turn is not None and not conn.turn.done():
        conn.turn.cancel()


@handler("permission.reply")
async def on_permission_reply(conn: Connection, msg: dict[str, Any]) -> None:
    request_id = _text_arg(msg, "request_id")
    decision = msg.get("decision")
    if decision not in DECISIONS:
        raise ProtocolError(f"'decision' must be one of: {', '.join(DECISIONS)}.")
    fut = conn.pending.get(request_id)
    if fut is None or fut.done():
        raise ProtocolError(f"No open permission request: {request_id}")
    fut.set_result(decision)


# -- commands ------------------------------------------------------------------


@handler("command")
async def on_command(conn: Connection, msg: dict[str, Any]) -> None:
    name = _text_arg(msg, "name").strip().lstrip("/")
    name = COMMAND_ALIASES.get(name, name)
    args = msg.get("args") or ""
    if not isinstance(args, str):
        raise ProtocolError("'args' must be a string.")
    if name not in BUILTIN_COMMANDS:
        # Built-in commands have priority over plugin commands. Plugin commands have priority over skills.
        if await conn.run_plugin_command(name, args):
            return
        skill = conn.skills().get(name)
        if skill is None:
            raise ProtocolError(f"Unknown command: /{name}")
        if not skill.user_invocable:
            raise ProtocolError(f"The skill {name} is for the model only. It is not a / command.")
        await conn.start_turn(lambda live: conn.run_skill(live, skill, args))
        return

    async def result(**fields: Any) -> None:
        await conn.send({"type": "command.result", "name": name, **fields})

    if name == "help":
        commands = dict(BUILTIN_COMMANDS)
        for c in (conn.plugins.commands().values() if conn.plugins is not None else []):
            commands.setdefault(c.name, c.description)
        lines = [f"/{n} - {d}" for n, d in commands.items()]
        await result(text="\n".join(lines), items=[{"name": n, "description": d} for n, d in commands.items()])
    elif name == "clear":
        session = conn.require_session()
        conn.require_idle()
        session.clear()
        await result(text="The context is clear.")
    elif name == "model":
        session = conn.require_session()
        if not args.strip():
            providers = ", ".join(load_providers())
            await result(text=f"Model: {session.agent.client.label}. Providers: {providers}.")
            return
        conn.require_idle()
        provider, model = resolve_model(args.strip())
        warnings, context, images = await conn.model_checks(provider, model, session.agent.settings)
        session.agent.set_client(ModelClient(provider, model), context.length, images, context.source)
        conn.storage.update_session(session.id, provider=provider.name, model=model)
        await result(text=f"The model is now {session.agent.client.label}.", model=session.agent.client.label,
                     warnings=warnings, context_length=context.length, context_source=context.source,
                     image_input=images)
    elif name == "compact":
        await conn.start_turn(conn.run_compact)
    elif name == "skills":
        items = [s.summary() for s in conn.skills().values()]
        await result(action="open_panel", panel="skills", items=items)
    elif name in PANEL_COMMANDS:
        await result(action="open_panel", panel=PANEL_COMMANDS[name])
    elif name == "preview":
        manager = conn.require_servers()
        manager.reload()
        server = manager.default()
        if server is None:
            await result(action="open_panel", panel="servers",
                         text="There is no server in .harness/launch.json. The Servers pane can propose one.")
            return
        # The start can wait for an approval: run it as a task, so that the connection stays free.
        asyncio.create_task(_start_quietly(conn, server.config.name))
        await result(action="preview", server=server.config.name, url=server.url)


# -- permission rules ----------------------------------------------------------


async def _send_rules(conn: Connection, session: Session) -> None:
    rules = PermissionRules(session.cwd)
    await conn.send({"type": "permissions", "path": relpath(session.cwd, rules.path), **rules.read()})


@handler("permissions.get")
async def on_permissions_get(conn: Connection, msg: dict[str, Any]) -> None:
    await _send_rules(conn, conn.require_session())


@handler("permissions.set")
async def on_permissions_set(conn: Connection, msg: dict[str, Any]) -> None:
    session = conn.require_session()
    allow, deny = msg.get("allow"), msg.get("deny")
    if not isinstance(allow, list) or not isinstance(deny, list):
        raise ProtocolError("'allow' and 'deny' must be lists of rules.")
    try:
        PermissionRules(session.cwd).write(allow, deny)
    except ValueError as e:
        raise ProtocolError(str(e)) from e
    await _send_rules(conn, session)


# -- providers (the Providers screen) ---------------------------------------------------


async def _send_providers(conn: Connection) -> None:
    items, exists = provider_config.list_items()
    await conn.send({"type": "providers", "items": items, "path": str(provider_config.providers_path()),
                     "exists": exists})


def _refresh_session_provider(conn: Connection, names: list[str] | None = None) -> None:
    """Use the changed settings or key of the provider of the session in the next model call."""
    session = conn.session
    if session is None:
        return
    client = session.agent.client
    if names is not None and client.provider.name not in names:
        return
    try:
        provider = load_providers(include_disabled=True)[client.provider.name]
    except (ConfigError, KeyError):
        return  # The provider was deleted or renamed. The session keeps its old settings.
    session.agent.set_client(ModelClient(provider, client.model))


def _provider_fields(msg: dict[str, Any]) -> dict[str, Any]:
    keys = ("name", "base_url", "kind", "context_length", "ssh", "key", "api_key_env", "previous_name")
    return {k: msg.get(k) for k in keys}


@handler("providers.list")
async def on_providers_list(conn: Connection, msg: dict[str, Any]) -> None:
    await _send_providers(conn)


@handler("providers.save")
async def on_providers_save(conn: Connection, msg: dict[str, Any]) -> None:
    """Add or change a provider. With "previous_name", change (and maybe rename) that provider."""
    previous = msg.get("previous_name")
    name = provider_config.save_provider(_provider_fields(msg), previous if isinstance(previous, str) else None)
    MODEL_CHECKS.clear()
    _refresh_session_provider(conn, [name])
    await _send_providers(conn)


@handler("providers.delete")
async def on_providers_delete(conn: Connection, msg: dict[str, Any]) -> None:
    provider_config.delete_provider(_text_arg(msg, "name"))
    MODEL_CHECKS.clear()
    await _send_providers(conn)


@handler("providers.enable")
async def on_providers_enable(conn: Connection, msg: dict[str, Any]) -> None:
    enabled = msg.get("enabled")
    if not isinstance(enabled, bool):
        raise ProtocolError("'enabled' must be true or false.")
    provider_config.set_enabled(_text_arg(msg, "name"), enabled)
    MODEL_CHECKS.clear()
    await _send_providers(conn)


@handler("providers.keys")
async def on_providers_keys(conn: Connection, msg: dict[str, Any]) -> None:
    """API keys from the keychain of the client: {"keys": {"<provider>": "<key>" or null}}. Memory only."""
    keys = msg.get("keys")
    if not isinstance(keys, dict):
        raise ProtocolError("'keys' must be an object that maps provider names to keys.")
    changed = provider_config.set_client_keys(keys)
    MODEL_CHECKS.clear()
    if changed:
        _refresh_session_provider(conn, changed)
    await _send_providers(conn)


@handler("providers.test")
async def on_providers_test(conn: Connection, msg: dict[str, Any]) -> None:
    """Test the form values of a provider: GET <base_url>/models, and the key of OpenRouter.
    "api_key" is a new key that is not saved yet."""
    api_key = msg.get("api_key")
    provider = provider_config.provider_for_test(_provider_fields(msg), api_key if isinstance(api_key, str) else None)
    ref = msg.get("ref")

    async def run() -> None:  # A slow endpoint must not block the other messages.
        found = await provider_config.list_models(provider, verify_key=True)
        await conn.send({"type": "providers.test", "ref": ref, "name": provider.name, **found})

    asyncio.create_task(run())


@handler("models.list")
async def on_models_list(conn: Connection, msg: dict[str, Any]) -> None:
    """The models of each provider that is on, for the model field of the client."""
    async def run() -> None:
        await conn.send({"type": "models", **await provider_config.all_models()})

    asyncio.create_task(run())


async def _send_settings(conn: Connection, session: Session) -> None:
    values = {k: session.agent.settings.get(k) for k in CLIENT_SETTINGS}
    values["permission_mode"] = _permission_mode(session.agent.settings)
    await conn.send({"type": "settings", **values})


@handler("daemon.update")
async def on_daemon_update(conn: Connection, msg: dict[str, Any]) -> None:
    """Install a new version of the daemon: {"filename", "data" (base64 of the wheel)}. Then restart.

    Replies are "daemon.update" with "state": "installing", "restarting", or "error" (with "message").
    """
    reason = update.refusal()
    if reason:
        raise ProtocolError(reason)
    if any(live.running for live in conn.live.values()):
        raise ProtocolError("A turn is running. Wait for the end of the turn, or stop it, then update.")
    filename = _text_arg(msg, "filename")
    try:
        data = base64.b64decode(_text_arg(msg, "data"), validate=True)
    except (ValueError, binascii.Error):
        raise ProtocolError("'data' must be base64.") from None

    async def work() -> None:
        await conn.send({"type": "daemon.update", "state": "installing"})
        try:
            await update.install(filename, data)
        except (RuntimeError, OSError) as e:
            await conn.send({"type": "daemon.update", "state": "error", "message": str(e)})
            return
        await conn.send({"type": "daemon.update", "state": "restarting"})
        await asyncio.sleep(0.3)  # The reply goes out before the process stops.
        update.restart()

    asyncio.create_task(work())


@handler("ping")
async def on_ping(conn: Connection, msg: dict[str, Any]) -> None:
    """The client checks that the connection is alive, for example after the computer wakes."""
    await conn.send({"type": "pong"})


@handler("context.get")
async def on_context_get(conn: Connection, msg: dict[str, Any]) -> None:
    """The context breakdown of the session: the size of each part of the next request."""
    session = conn.require_session()
    await conn.send({"type": "context.usage", **session.agent.context_breakdown()})


def _permission_mode(settings: dict[str, Any]) -> str:
    """The mode of the settings. An unknown mode, for example "auto" of an older version, is "default"."""
    mode = settings.get("permission_mode")
    return mode if mode in MODES else "default"


@handler("settings.get")
async def on_settings_get(conn: Connection, msg: dict[str, Any]) -> None:
    await _send_settings(conn, conn.require_session())


@handler("settings.set")
async def on_settings_set(conn: Connection, msg: dict[str, Any]) -> None:
    """Change project settings, for example {"auto_verify": true}. The other keys stay the same."""
    session = conn.require_session()
    changes = {k: v for k, v in msg.items() if k != "type"}
    if not changes:
        raise ProtocolError(f"Give one or more settings: {', '.join(CLIENT_SETTINGS)}.")
    for key, value in changes.items():
        kind = CLIENT_SETTINGS.get(key)
        if kind is None:
            raise ProtocolError(f"Unknown setting: {key}. The settings are: {', '.join(CLIENT_SETTINGS)}.")
        if not isinstance(value, kind):
            raise ProtocolError(f"'{key}' must be a {kind.__name__}.")
        if key == "permission_mode" and value not in MODES:
            raise ProtocolError(f"'permission_mode' must be one of: {', '.join(MODES)}.")
    path = project_settings_path(session.cwd)
    data = read_json(path, {})
    data.update(changes)
    write_json(path, data)
    session.agent.reload_settings(load_settings(session.cwd))
    await _send_settings(conn, session)


# The settings of the General page of the Settings dialog. They are user settings: all the projects
# of the daemon use them, and a project settings file can change them for one project.
USER_SETTINGS: dict[str, tuple[type, ...]] = {
    "permission_mode": (str,),
    "prompt_suggestions": (bool,),
    "auto_verify": (bool,),
    "max_tool_calls": (int,),
    "limit_tool_calls": (bool,),
    "bash_timeout": (int,),
    "terminal_shell": (str, type(None)),
}
USER_INT_LIMITS = {"max_tool_calls": (1, 500), "bash_timeout": (1, 3600)}


def _user_settings_path() -> Path:
    return harness_home() / "settings.json"


async def _send_user_settings(conn: Connection) -> None:
    values = load_settings(None)
    await conn.send({"type": "user_settings", "path": str(_user_settings_path()), "version": __version__,
                     "values": {k: values.get(k) for k in USER_SETTINGS}})


@handler("user_settings.get")
async def on_user_settings_get(conn: Connection, msg: dict[str, Any]) -> None:
    """The user settings for the General page. It needs no session."""
    await _send_user_settings(conn)


@handler("user_settings.set")
async def on_user_settings_set(conn: Connection, msg: dict[str, Any]) -> None:
    """Change user settings, for example {"values": {"prompt_suggestions": false}}. Null removes a
    text setting. The open sessions use the new values at once."""
    changes = msg.get("values")
    if not isinstance(changes, dict) or not changes:
        raise ProtocolError(f"'values' must be an object with one or more of: {', '.join(USER_SETTINGS)}.")
    for key, value in changes.items():
        kinds = USER_SETTINGS.get(key)
        if kinds is None:
            raise ProtocolError(f"Unknown setting: {key}. The settings are: {', '.join(USER_SETTINGS)}.")
        if isinstance(value, bool) and bool not in kinds or not isinstance(value, kinds):
            raise ProtocolError(f"The type of '{key}' must be {' or '.join('null' if k is type(None) else k.__name__ for k in kinds)}.")
        if key == "permission_mode" and value not in MODES:
            raise ProtocolError(f"'permission_mode' must be one of: {', '.join(MODES)}.")
        if key in USER_INT_LIMITS:
            low, high = USER_INT_LIMITS[key]
            if not low <= value <= high:
                raise ProtocolError(f"'{key}' must be from {low} to {high}.")
    path = _user_settings_path()
    data = read_json(path, {})
    for key, value in changes.items():
        if value is None or (isinstance(value, str) and not value.strip()):
            data.pop(key, None)
        else:
            data[key] = value.strip() if isinstance(value, str) else value
    write_json(path, data)
    for live in conn.live.values():
        if live.session is not None:
            live.session.agent.reload_settings(load_settings(live.session.cwd))
    await _send_user_settings(conn)


@handler("skills.list")
async def on_skills_list(conn: Connection, msg: dict[str, Any]) -> None:
    """The contents of the / menu: the built-in commands, then the user-invocable skills.

    The start screen has no session. It sends the project folder as "cwd": the list then has the
    same commands and skills as a new session in that folder, with the global skills.
    """
    builtins = [{"name": n, "description": d, "argument-hint": BUILTIN_HINTS.get(n, ""), "source": "built-in",
                 "builtin": True} for n, d in BUILTIN_COMMANDS.items()]
    folder = _project_dir(msg["cwd"]) if msg.get("cwd") is not None else None
    if folder is None or (conn.session is not None and conn.session.cwd == folder):
        plugin_commands = conn.plugins.commands() if conn.plugins is not None else {}
        found = conn.skills()
    else:
        host = await conn.start_plugins(folder)
        plugin_commands = host.commands()
        found = await asyncio.to_thread(discover_skills, folder, host.skill_roots(), host.dsh_skills())
    commands = [{"name": c.name, "description": c.description, "argument-hint": c.argument_hint,
                 "source": f"plugin ({c.plugin})", "builtin": False}
                for c in plugin_commands.values() if c.name not in BUILTIN_COMMANDS]
    skills = [s.summary() for s in found.values()
              if s.user_invocable and s.name not in BUILTIN_COMMANDS and s.name not in plugin_commands]
    await conn.send({"type": "skills", "items": builtins + commands + skills})


@handler("skills.get")
async def on_skills_get(conn: Connection, msg: dict[str, Any]) -> None:
    """One skill for the Skills panel: the SKILL.md text and the other files in its folder."""
    name = _text_arg(msg, "name")
    skill = conn.skills().get(name)
    if skill is None:
        raise ProtocolError(f"Unknown skill: {name}")
    files = sorted(
        p.relative_to(skill.dir).as_posix()
        for p in skill.dir.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts
    )[:200] if skill.has_files else []
    await conn.send({
        "type": "skill",
        **skill.summary(),
        "allowed-tools": list(skill.allowed_tools),
        "content": skill.content if skill.content is not None else skill.path.read_text(encoding="utf-8", errors="replace"),
        "files": files,
    })


async def _start_quietly(conn: Connection, name: str) -> None:
    try:
        await conn.start_server(name)
    except ProtocolError as e:
        await conn.error(str(e), ref="server.start")


async def _send_servers(conn: Connection) -> None:
    manager = conn.require_servers()
    exists = manager.reload()
    body: dict[str, Any] = {
        "type": "servers",
        "items": manager.items(),
        "path": ".harness/launch.json",
        "config": "invalid" if manager.config_error else ("exists" if exists else "missing"),
    }
    if manager.config_error:
        body["error"] = manager.config_error
    if not exists:
        body["proposal"] = [c.to_json() for c in propose(manager.project)]
    await conn.send(body)


@handler("server.list")
async def on_server_list(conn: Connection, msg: dict[str, Any]) -> None:
    await _send_servers(conn)


@handler("server.save")
async def on_server_save(conn: Connection, msg: dict[str, Any]) -> None:
    """Write launch.json: the approved proposal, or a changed configuration."""
    manager = conn.require_servers()
    servers = msg.get("servers")
    if not isinstance(servers, list) or not servers:
        raise ProtocolError("'servers' must be a list with one or more servers.")
    save_launch(manager.project, servers)
    await _send_servers(conn)


@handler("server.start")
async def on_server_start(conn: Connection, msg: dict[str, Any]) -> None:
    name = _text_arg(msg, "name")
    conn.require_servers().reload()
    asyncio.create_task(_start_quietly(conn, name))


@handler("server.stop")
async def on_server_stop(conn: Connection, msg: dict[str, Any]) -> None:
    manager = conn.require_servers()
    if msg.get("all") or msg.get("name") == "all":
        await manager.stop_all()
        return
    name = _text_arg(msg, "name")
    try:
        await manager.stop(name)
    except KeyError:
        raise ProtocolError(f"Unknown server: {name}") from None


@handler("server.restart")
async def on_server_restart(conn: Connection, msg: dict[str, Any]) -> None:
    manager = conn.require_servers()
    name = _text_arg(msg, "name")
    try:
        await manager.stop(name)
    except KeyError:
        raise ProtocolError(f"Unknown server: {name}") from None

    async def later() -> None:
        server = manager.get(name)
        for _ in range(100):  # Wait for the old process to stop.
            if server.proc is None:
                break
            await asyncio.sleep(0.05)
        await _start_quietly(conn, name)

    asyncio.create_task(later())


@handler("server.logs")
async def on_server_logs(conn: Connection, msg: dict[str, Any]) -> None:
    name = _text_arg(msg, "name")
    try:
        server = conn.require_servers().get(name)
    except KeyError:
        raise ProtocolError(f"Unknown server: {name}") from None
    await conn.send({"type": "server.logs", "name": name,
                     "lines": [{"stream": st, "text": t} for st, t in server.logs]})


# -- files ---------------------------------------------------------------------


def _git_ignored(cwd: Path, rel_paths: list[str]) -> set[str]:
    if not rel_paths:
        return set()
    try:
        proc = subprocess.run(
            ["git", "-C", str(cwd), "check-ignore", "-z", "--stdin"],
            input="\0".join(rel_paths).encode("utf-8"),
            capture_output=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    if proc.returncode not in (0, 1):  # 128: not a git repository.
        return set()
    return {p for p in proc.stdout.decode("utf-8", errors="replace").split("\0") if p}


MAX_DIRS = 1000


def _roots() -> list[str]:
    if os.name == "nt":
        return [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
    return ["/"]


@handler("fs.dirs")
async def on_fs_dirs(conn: Connection, msg: dict[str, Any]) -> None:
    """List the folders in a folder of the daemon host. The client uses it to select a project folder.

    This needs no session: the user selects the folder before the session starts.
    """
    raw = msg.get("path")
    folder = Path(raw).expanduser() if isinstance(raw, str) and raw.strip() else Path.home()
    if not folder.is_absolute():
        raise ProtocolError("'path' must be an absolute path.")
    folder = folder.resolve()
    if not folder.is_dir():
        raise ProtocolError(f"The folder does not exist: {folder}")
    show_hidden = bool(msg.get("hidden"))

    def scan() -> list[dict[str, str]]:
        items = []
        with os.scandir(folder) as it:
            for entry in it:
                try:
                    if not entry.is_dir():
                        continue
                except OSError:
                    continue
                if not show_hidden and entry.name.startswith("."):
                    continue
                items.append({"name": entry.name, "path": entry.path})
        items.sort(key=lambda e: e["name"].lower())
        return items[:MAX_DIRS]

    try:
        items = await asyncio.to_thread(scan)
    except PermissionError:
        raise ProtocolError(f"The daemon cannot read the folder: {folder}") from None
    parent = folder.parent if folder.parent != folder else None
    await conn.send({
        "type": "fs.dirs",
        "path": str(folder),
        "parent": str(parent) if parent else None,
        "items": items,
        "roots": _roots(),
        "is_project": any((folder / marker).exists() for marker in (".git", "HARNESS.md", "CLAUDE.md", "package.json", "pyproject.toml")),
    })


@handler("fs.list")
async def on_fs_list(conn: Connection, msg: dict[str, Any]) -> None:
    session = conn.require_session()
    path = msg.get("path") or "."
    folder = resolve_in_cwd(session.cwd, path)
    if not folder.is_dir():
        raise ProtocolError(f"Not a folder: {path}")
    entries = []
    with os.scandir(folder) as it:
        for entry in it:
            if entry.name in HIDDEN_NAMES:
                continue
            is_dir = entry.is_dir()
            rel = relpath(session.cwd, Path(entry.path))
            entries.append({"name": entry.name, "path": rel, "type": "dir" if is_dir else "file"})
    ignored = await asyncio.to_thread(_git_ignored, session.cwd, [e["path"] for e in entries])
    items = [e for e in entries if e["path"] not in ignored]
    items.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    await conn.send({"type": "fs.tree", "path": relpath(session.cwd, folder) or ".", "items": items})


@handler("fs.read")
async def on_fs_read(conn: Connection, msg: dict[str, Any]) -> None:
    session = conn.require_session()
    path = resolve_in_cwd(session.cwd, _text_arg(msg, "path"))
    if not path.is_file():
        raise ProtocolError(f"Not a file: {msg['path']}")
    if path.stat().st_size > MAX_EDITOR_FILE:
        raise ProtocolError(f"The file is larger than {MAX_EDITOR_FILE // (1024 * 1024)} MB.")
    data = path.read_bytes()
    if is_binary(data):
        raise ProtocolError("The file is binary.")
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ProtocolError("The file is not UTF-8 text.") from None
    conn.watched[relpath(session.cwd, path)] = hash_bytes(data)
    await conn.send({"type": "fs.content", "path": relpath(session.cwd, path), "content": content,
                     "hash": hash_bytes(data)})


@handler("fs.write")
async def on_fs_write(conn: Connection, msg: dict[str, Any]) -> None:
    session = conn.require_session()
    path = resolve_in_cwd(session.cwd, _text_arg(msg, "path"))
    content = _text_arg(msg, "content")
    base_hash = msg.get("base_hash")
    rel = relpath(session.cwd, path)
    if path.is_dir():
        raise ProtocolError(f"Not a file: {rel}")
    disk_hash = hash_bytes(path.read_bytes()) if path.exists() else None
    if disk_hash != base_hash:
        await conn.send({"type": "fs.conflict", "path": rel, "disk_hash": disk_hash})
        return
    data = content.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if rel in conn.watched:
        conn.watched[rel] = hash_bytes(data)
    await conn.send({"type": "fs.saved", "path": rel, "hash": hash_bytes(data)})


@handler("fs.unwatch")
async def on_fs_unwatch(conn: Connection, msg: dict[str, Any]) -> None:
    """The editor closed a file. Stop the change reports for it."""
    conn.watched.pop(_text_arg(msg, "path"), None)


MAX_FOUND = 40


@handler("fs.find")
async def on_fs_find(conn: Connection, msg: dict[str, Any]) -> None:
    """File and folder names for the "@" menu of the prompt box. An empty query gives the top of the project.
    The start screen has no session: it sends the project folder as "cwd"."""
    folder = _project_dir(msg["cwd"]) if msg.get("cwd") is not None else conn.require_session().cwd
    query = msg.get("query") if isinstance(msg.get("query"), str) else ""
    items = await asyncio.to_thread(find_paths, folder, query, MAX_FOUND)
    await conn.send({"type": "fs.found", "query": query, "items": items})


@handler("fs.search")
async def on_fs_search(conn: Connection, msg: dict[str, Any]) -> None:
    """The project search of the editor. It uses ripgrep if it is available."""
    session = conn.require_session()
    query = _text_arg(msg, "query")
    if not query:
        raise ProtocolError("The search text is empty.")
    glob = msg.get("glob") if isinstance(msg.get("glob"), str) and msg.get("glob").strip() else None
    try:
        items, truncated = await asyncio.to_thread(
            search_project, session.cwd, query, regex=bool(msg.get("regex")), ignore_case=not msg.get("case"),
            file_glob=glob, ripgrep=session.agent.settings.get("ripgrep"))
    except ToolError as e:
        raise ProtocolError(str(e)) from e
    await conn.send({"type": "fs.results", "query": query, "items": items, "truncated": truncated})
