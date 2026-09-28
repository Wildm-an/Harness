"""The WebSocket server. See docs/PROTOCOL.md for the message types."""

from __future__ import annotations

import asyncio
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
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from . import __version__
from .agent import Agent
from .config import ConfigError, harness_home, load_settings, project_settings_path, read_json, write_json
from .files import PathError, file_hash, hash_bytes, is_binary, relpath, resolve_in_cwd
from .permissions import DECISIONS, PermissionRules
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
from .tunnels import TUNNELS, TunnelError
from .launch import load_launch, propose, save_launch
from .references import expand_references
from .servers import ServerManager
from .session import Session
from .skills import Skill, discover_skills
from .storage import Storage

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
    "cookbook": "Open the Cookbook panel.",
    "providers": "Open the Providers screen: the model endpoints and their API keys.",
    "mcp": "Open the MCP panel: the MCP servers of the project and their tools.",
    "servers": "Open the Servers pane.",
    "preview": "Start the default server and open it in the Browser pane.",
    "help": "List the commands.",
}

BUILTIN_HINTS = {"model": "<provider>/<model>"}

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

# Project settings that the client can change with "settings.set", and their types.
CLIENT_SETTINGS: dict[str, type] = {"auto_verify": bool}


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
        await conn.send({"type": "auth.ok", "version": __version__, "host": host_info()})
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


class Connection:
    def __init__(self, websocket: WebSocket, storage: Storage):
        self.ws = websocket
        self.storage = storage
        self.session: Session | None = None
        self.turn: asyncio.Task | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self._send_lock = asyncio.Lock()
        self._open = True
        # The files that the editor has open: relative path -> the last known hash.
        self.watched: dict[str, str | None] = {}
        self.servers: ServerManager | None = None
        self.preview: PreviewHost | None = None
        self.mcp: McpManager | None = None
        self.files_token: str | None = None
        self._watcher: asyncio.Task | None = None

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

    async def error(self, message: str, ref: str | None = None) -> None:
        body: dict[str, Any] = {"type": "error", "message": message}
        if ref:
            body["ref"] = ref
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
                except (ProtocolError, ConfigError, PathError, HostError, HubError, CookbookError) as e:
                    await self.error(str(e), ref=kind)
                except Exception as e:  # noqa: BLE001 - report the error and keep the connection.
                    log.exception("Handler %s failed", kind)
                    await self.error(f"Internal error: {type(e).__name__}: {e}", ref=kind)
        finally:
            self._open = False
            COOKBOOK.unlisten(self.send)
            if self._watcher:
                self._watcher.cancel()
            await self._stop_turn()
            await self._close_session()

    # -- helpers ---------------------------------------------------------

    def require_session(self) -> Session:
        if self.session is None:
            raise ProtocolError("No session. Send 'session.new' or 'session.resume' first.")
        return self.session

    async def _close_session(self) -> None:
        """Stop the MCP servers, the agent browser, and the servers of the session, and end its file URLs."""
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

    async def open_session(self, session: Session) -> None:
        await self._close_session()
        self.session = session
        self.watched.clear()
        self.servers = ServerManager(session.cwd, session.agent.ctx.shell, self.send)
        MANAGERS.add(self.servers)
        self.preview = PreviewHost(self.servers, self.send)
        PREVIEWS.add(self.preview)
        session.agent.enable_preview(self.preview)
        self.files_token = secrets.token_urlsafe(24)
        FILE_ROOTS[self.files_token] = session.cwd
        # The MCP servers connect in the background. The first turn waits for them (MCP_WAIT).
        self.mcp = McpManager(session.cwd, self.send, session.agent.set_mcp_tools)
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
        decision = await self.approve({
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

    async def _stop_turn(self) -> None:
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

    async def approve(self, request: dict[str, Any]) -> str:
        fut = asyncio.get_running_loop().create_future()
        self.pending[request["request_id"]] = fut
        try:
            await self.send({"type": "permission.request", **request})
            return await fut
        finally:
            self.pending.pop(request["request_id"], None)

    async def make_agent(self, cwd: Path, provider_name: str | None, model: str | None,
                         history: list[dict] | None = None, summary: str | None = None) -> tuple[Agent, list[str]]:
        settings = load_settings(cwd)
        provider, model_name = resolve_model(model or settings.get("default_model"), provider_name)
        warnings, context, images = await self.model_checks(provider, model_name, settings)
        agent = Agent(cwd=cwd, client=ModelClient(provider, model_name), emit=self.send,
                      approver=self.approve, settings=settings, history=history,
                      summary=summary, context_length=context.length, skills=discover_skills(cwd),
                      image_input=images, context_source=context.source)
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
        caps, context = await asyncio.gather(
            model_capabilities(reachable, model), resolve_context_length(reachable, model, settings))
        support = None if caps is None else "tools" in caps
        warnings = []
        if provider.key_missing:
            warnings.append(f"The provider {provider.name} has no API key. {provider.key_missing} "
                            "Open the Providers screen to enter the key.")
        if support is False:
            warnings.append(f"The model {model} does not support tool calls. "
                            "The agent cannot read files, edit files, or run commands.")
        if context.warning:
            warnings.append(context.warning)
        # "provider" (not "reachable"): the models of providers.json use the configured name.
        return warnings, context, image_input(provider, model, settings, caps)

    async def send_ready(self, warnings: list[str]) -> None:
        s = self.require_session()
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
            "context_source": s.agent.context_source,
            "context_tokens": s.agent.context_tokens(),
            "instructions": s.agent.instructions.name if s.agent.instructions else None,
            "files_token": self.files_token,
            "project": _project_ref(self.storage, s.cwd),
            "auto_verify": bool(s.agent.settings.get("auto_verify")),
            "image_input": s.agent.image_input,
        })

    async def run_turn(self, text: str) -> None:
        session = self.require_session()
        session.set_title_from(text)
        # "@src/app.py:10-25" references from the editor: add the lines to the prompt.
        expanded = await asyncio.to_thread(expand_references, text, session.cwd)
        await self.wait_for_mcp()
        try:
            await session.agent.run_turn(expanded, display=text if expanded != text else None)
        finally:
            session.persist()

    def start_turn(self, text: str) -> None:
        self.turn = asyncio.create_task(self.guarded(self.run_turn(text)))

    async def guarded(self, work: Awaitable[None]) -> None:
        """Run a turn. An unexpected error ends the turn with an error, so the client does not wait forever."""
        try:
            await work
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.exception("The turn failed")
            await self.error(f"Internal error in the turn: {type(e).__name__}: {e}")
            usage: dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0, "last_prompt_tokens": 0,
                                     "context_tokens": 0, "context_length": 0}
            if self.session is not None:
                usage.update(context_tokens=self.session.agent.context_tokens(),
                             context_length=self.session.agent.context_length)
            await self.send({"type": "turn.end", "usage": usage, "stop_reason": "error"})

    def skills(self) -> dict[str, Skill]:
        """The skills now on disk. The user can add a skill during a session."""
        return discover_skills(self.session.cwd if self.session else None)

    async def run_skill(self, skill: Skill, args: str) -> None:
        session = self.require_session()
        session.set_title_from(f"/{skill.name} {args}")
        await self.wait_for_mcp()
        try:
            await session.agent.run_skill(skill, args)
        finally:
            session.persist()

    async def run_compact(self) -> None:
        session = self.require_session()
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


@handler("session.new")
async def on_session_new(conn: Connection, msg: dict[str, Any]) -> None:
    conn.require_idle()
    cwd = _project_dir(msg.get("cwd"))
    agent, warnings = await conn.make_agent(cwd, msg.get("provider"), msg.get("model"))
    session_id = conn.storage.create_session(str(cwd), agent.client.provider.name, agent.client.model)
    conn.storage.touch_project(str(cwd))  # A new folder becomes a project.
    await conn.open_session(Session(conn.storage, session_id, agent))
    await conn.send_ready(warnings)


@handler("session.resume")
async def on_session_resume(conn: Connection, msg: dict[str, Any]) -> None:
    conn.require_idle()
    session_id = _text_arg(msg, "session_id")
    row = conn.storage.get_session(session_id)
    if row is None:
        raise ProtocolError(f"Unknown session: {session_id}")
    cwd = _project_dir(row["cwd"])
    history = conn.storage.load_messages(session_id)
    agent, warnings = await conn.make_agent(cwd, row["provider"], row["model"], history, row["summary"])
    conn.storage.touch_project(str(cwd))
    await conn.open_session(Session(conn.storage, session_id, agent, title=row["title"]))
    await conn.send_ready(warnings)


@handler("session.list")
async def on_session_list(conn: Connection, msg: dict[str, Any]) -> None:
    cwd = msg.get("cwd")
    await conn.send({"type": "sessions", "items": conn.storage.list_sessions(cwd if isinstance(cwd, str) else None),
                     "cwd": cwd if isinstance(cwd, str) else None})


# -- projects: saved project folders (the start screen) -----------------------------------

MAX_PROJECT_NAME = 80


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
    conn.start_turn(text)


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
    args = msg.get("args") or ""
    if not isinstance(args, str):
        raise ProtocolError("'args' must be a string.")
    if name not in BUILTIN_COMMANDS:
        # Built-in commands have priority over skills with the same name.
        skill = conn.skills().get(name)
        if skill is None:
            raise ProtocolError(f"Unknown command: /{name}")
        if not skill.user_invocable:
            raise ProtocolError(f"The skill {name} is for the model only. It is not a / command.")
        conn.require_session()
        conn.require_idle()
        conn.turn = asyncio.create_task(conn.guarded(conn.run_skill(skill, args)))
        return

    async def result(**fields: Any) -> None:
        await conn.send({"type": "command.result", "name": name, **fields})

    if name == "help":
        lines = [f"/{n} - {d}" for n, d in BUILTIN_COMMANDS.items()]
        await result(text="\n".join(lines), items=[{"name": n, "description": d} for n, d in BUILTIN_COMMANDS.items()])
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
        conn.require_session()
        conn.require_idle()
        conn.turn = asyncio.create_task(conn.guarded(conn.run_compact()))
    elif name == "skills":
        items = [s.summary() for s in conn.skills().values()]
        await result(action="open_panel", panel="skills", items=items)
    elif name in ("cookbook", "servers", "providers", "mcp"):
        await result(action="open_panel", panel=name)
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
    _refresh_session_provider(conn, [name])
    await _send_providers(conn)


@handler("providers.delete")
async def on_providers_delete(conn: Connection, msg: dict[str, Any]) -> None:
    provider_config.delete_provider(_text_arg(msg, "name"))
    await _send_providers(conn)


@handler("providers.enable")
async def on_providers_enable(conn: Connection, msg: dict[str, Any]) -> None:
    enabled = msg.get("enabled")
    if not isinstance(enabled, bool):
        raise ProtocolError("'enabled' must be true or false.")
    provider_config.set_enabled(_text_arg(msg, "name"), enabled)
    await _send_providers(conn)


@handler("providers.keys")
async def on_providers_keys(conn: Connection, msg: dict[str, Any]) -> None:
    """API keys from the keychain of the client: {"keys": {"<provider>": "<key>" or null}}. Memory only."""
    keys = msg.get("keys")
    if not isinstance(keys, dict):
        raise ProtocolError("'keys' must be an object that maps provider names to keys.")
    changed = provider_config.set_client_keys(keys)
    if changed:
        _refresh_session_provider(conn, changed)
    await _send_providers(conn)


@handler("providers.test")
async def on_providers_test(conn: Connection, msg: dict[str, Any]) -> None:
    """Test the form values of a provider: GET <base_url>/models. "api_key" is a new key that is not saved yet."""
    api_key = msg.get("api_key")
    provider = provider_config.provider_for_test(_provider_fields(msg), api_key if isinstance(api_key, str) else None)
    ref = msg.get("ref")

    async def run() -> None:  # A slow endpoint must not block the other messages.
        found = await provider_config.list_models(provider)
        await conn.send({"type": "providers.test", "ref": ref, "name": provider.name, **found})

    asyncio.create_task(run())


@handler("models.list")
async def on_models_list(conn: Connection, msg: dict[str, Any]) -> None:
    """The models of each provider that is on, for the model field of the client."""
    async def run() -> None:
        await conn.send({"type": "models", **await provider_config.all_models()})

    asyncio.create_task(run())


async def _send_settings(conn: Connection, session: Session) -> None:
    await conn.send({"type": "settings", **{k: session.agent.settings.get(k) for k in CLIENT_SETTINGS}})


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
    path = project_settings_path(session.cwd)
    data = read_json(path, {})
    data.update(changes)
    write_json(path, data)
    session.agent.reload_settings(load_settings(session.cwd))
    await _send_settings(conn, session)


@handler("skills.list")
async def on_skills_list(conn: Connection, msg: dict[str, Any]) -> None:
    """The contents of the / menu: the built-in commands, then the user-invocable skills."""
    builtins = [{"name": n, "description": d, "argument-hint": BUILTIN_HINTS.get(n, ""), "source": "built-in",
                 "builtin": True} for n, d in BUILTIN_COMMANDS.items()]
    skills = [s.summary() for s in conn.skills().values() if s.user_invocable and s.name not in BUILTIN_COMMANDS]
    await conn.send({"type": "skills", "items": builtins + skills})


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
    )[:200]
    await conn.send({
        "type": "skill",
        **skill.summary(),
        "allowed-tools": list(skill.allowed_tools),
        "content": skill.path.read_text(encoding="utf-8", errors="replace"),
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
