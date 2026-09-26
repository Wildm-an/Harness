"""The WebSocket server. See docs/PROTOCOL.md for the message types."""

from __future__ import annotations

import asyncio
import getpass
import hmac
import json
import logging
import os
import platform
import socket
import string
import subprocess
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from . import __version__
from .agent import Agent
from .config import ConfigError, harness_home, load_settings
from .files import PathError, hash_bytes, is_binary, relpath, resolve_in_cwd
from .permissions import DECISIONS, PermissionRules
from .providers import ModelClient, check_tool_support, load_providers, resolve_context_length, resolve_model
from .session import Session
from .skills import Skill, discover_skills
from .storage import Storage

log = logging.getLogger("harness.daemon")

AUTH_TIMEOUT = 10
AUTH_FAILED = 4401
MAX_EDITOR_FILE = 5 * 1024 * 1024
HIDDEN_NAMES = {".git"}

BUILTIN_COMMANDS: dict[str, str] = {
    "clear": "Start a new context in the same session.",
    "compact": "Summarize the context.",
    "model": "Show the model, or change it: /model <provider>/<model>.",
    "skills": "Open the Skills panel: the skills and their sources.",
    "cookbook": "Open the Cookbook panel.",
    "servers": "Open the Servers pane.",
    "preview": "Start the default server and open it in the Browser pane.",
    "help": "List the commands.",
}

BUILTIN_HINTS = {"model": "<provider>/<model>"}

# Message types of later build phases.
NOT_AVAILABLE = {
    "hf.search": "the Cookbook",
    "hf.model": "the Cookbook",
    "hf.download": "the Cookbook",
    "server.start": "the Servers pane",
    "server.stop": "the Servers pane",
}


class ProtocolError(Exception):
    pass


def create_app(token: str, storage: Storage | None = None) -> FastAPI:
    app = FastAPI(title="harness-daemon", version=__version__)
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

    return app


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

    async def send(self, message: dict[str, Any]) -> None:
        if not self._open:
            return
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

    async def run(self) -> None:
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
                except (ProtocolError, ConfigError, PathError) as e:
                    await self.error(str(e), ref=kind)
                except Exception as e:  # noqa: BLE001 - report the error and keep the connection.
                    log.exception("Handler %s failed", kind)
                    await self.error(f"Internal error: {type(e).__name__}: {e}", ref=kind)
        finally:
            self._open = False
            await self._stop_turn()

    # -- helpers ---------------------------------------------------------

    def require_session(self) -> Session:
        if self.session is None:
            raise ProtocolError("No session. Send 'session.new' or 'session.resume' first.")
        return self.session

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
        warnings, context_length = await self.model_checks(provider, model_name, settings)
        agent = Agent(cwd=cwd, client=ModelClient(provider, model_name), emit=self.send,
                      approver=self.approve, settings=settings, history=history,
                      summary=summary, context_length=context_length, skills=discover_skills(cwd))
        return agent, warnings

    @staticmethod
    async def model_checks(provider, model: str, settings: dict[str, Any]) -> tuple[list[str], int]:
        """Check tool support and find the context length. Return the warnings and the length."""
        support, context = await asyncio.gather(
            check_tool_support(provider, model), resolve_context_length(provider, model, settings))
        warnings = []
        if support is False:
            warnings.append(f"The model {model} does not support tool calls. "
                            "The agent cannot read files, edit files, or run commands.")
        if context.warning:
            warnings.append(context.warning)
        return warnings, context.length

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
            "context_tokens": s.agent.context_tokens(),
            "instructions": s.agent.instructions.name if s.agent.instructions else None,
        })

    async def run_turn(self, text: str) -> None:
        session = self.require_session()
        session.set_title_from(text)
        try:
            await session.agent.run_turn(text)
        finally:
            session.persist()

    def start_turn(self, text: str) -> None:
        self.turn = asyncio.create_task(self.run_turn(text))

    def skills(self) -> dict[str, Skill]:
        """The skills now on disk. The user can add a skill during a session."""
        return discover_skills(self.session.cwd if self.session else None)

    async def run_skill(self, skill: Skill, args: str) -> None:
        session = self.require_session()
        session.set_title_from(f"/{skill.name} {args}")
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
    conn.session = Session(conn.storage, session_id, agent)
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
    conn.session = Session(conn.storage, session_id, agent, title=row["title"])
    await conn.send_ready(warnings)


@handler("session.list")
async def on_session_list(conn: Connection, msg: dict[str, Any]) -> None:
    cwd = msg.get("cwd")
    await conn.send({"type": "sessions", "items": conn.storage.list_sessions(cwd if isinstance(cwd, str) else None)})


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
        conn.turn = asyncio.create_task(conn.run_skill(skill, args))
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
        warnings, context_length = await conn.model_checks(provider, model, session.agent.settings)
        session.agent.set_client(ModelClient(provider, model), context_length)
        conn.storage.update_session(session.id, provider=provider.name, model=model)
        await result(text=f"The model is now {session.agent.client.label}.", model=session.agent.client.label,
                     warnings=warnings, context_length=context_length)
    elif name == "compact":
        conn.require_session()
        conn.require_idle()
        conn.turn = asyncio.create_task(conn.run_compact())
    elif name == "skills":
        items = [s.summary() for s in conn.skills().values()]
        await result(action="open_panel", panel="skills", items=items)
    elif name in ("cookbook", "servers"):
        await result(action="open_panel", panel=name)
    else:  # preview
        raise ProtocolError(f"/{name} is not in this build yet.")


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


@handler("server.list")
async def on_server_list(conn: Connection, msg: dict[str, Any]) -> None:
    await conn.send({"type": "servers", "items": []})


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
    await conn.send({"type": "fs.saved", "path": rel, "hash": hash_bytes(data)})
