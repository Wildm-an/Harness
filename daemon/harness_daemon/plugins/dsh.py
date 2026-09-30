"""The bridge to the Node plugin host, which runs DeepSeek Harness plugins (docs/PLUGINS.md).

One host process serves the whole daemon. It starts when a session opens and a DeepSeek bundle
is installed, or when the Plugins screen changes the DeepSeek plugins. The daemon talks to it
with JSON-RPC 2.0 on stdin and stdout, one JSON message on each line.

Each session gets a DshSession: one shim agent in the host, and the tools, commands, skills,
and prompt text that the plugins give that agent. The PluginHost of the session adds them to
the agent, next to the Python plugins.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

from ..config import harness_home, read_json
from ..skills import Skill
from ..tools.base import Approval, Tool, ToolContext, ToolResult

log = logging.getLogger("harness.dsh")

START_TIMEOUT = 60
CALL_TIMEOUT = 120
INSTALL_TIMEOUT = 15 * 60
MAX_DESCRIPTION = 1024


class DshError(Exception):
    """A failed call to the plugin host. ``data`` holds details, for example ``pendingBuilds``."""

    def __init__(self, message: str, code: int | None = None, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


def dsh_home() -> Path:
    """The DeepSeek profile: the installed bundles and their patch files."""
    return harness_home() / "dsh"


def host_dir() -> Path | None:
    """The plugin host folder: ``HARNESS_PLUGIN_HOST``, the sidecar bundle, or the repository."""
    candidates = []
    if os.environ.get("HARNESS_PLUGIN_HOST"):
        candidates.append(Path(os.environ["HARNESS_PLUGIN_HOST"]))
    if getattr(sys, "frozen", False):
        candidates.append(Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "plugin-host")
    candidates.append(Path(__file__).resolve().parents[3] / "plugin-host")
    for path in candidates:
        if (path / "src" / "main.mjs").is_file() and (path / "node_modules" / "@deepseek-ai" / "cordis").is_dir():
            return path
    return None


def node_executable() -> str | None:
    """``HARNESS_NODE``, the Node of the Playwright driver (it is in the sidecar), or a Node on the PATH."""
    if os.environ.get("HARNESS_NODE"):
        return os.environ["HARNESS_NODE"]
    try:
        from playwright._impl._driver import compute_driver_executable

        node = compute_driver_executable()[0]
        if Path(node).is_file():
            return str(node)
    except Exception:  # noqa: BLE001 - an older Playwright, or no Playwright.
        pass
    return shutil.which("node")


def installed_bundles() -> list[str]:
    """The installed DeepSeek packages, read from the profile without the host."""
    data = read_json(dsh_home() / "package.json", {})
    deps = data.get("dependencies") if isinstance(data, dict) else None
    return sorted(deps) if isinstance(deps, dict) else []


class DshBridge:
    """The plugin host process and its JSON-RPC client."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.pending: dict[int, asyncio.Future] = {}
        self.next_id = 1
        self.agents: dict[str, str | None] = {}  # Open agents: id -> cwd. A restart opens them again.
        self.state: dict[str, Any] | None = None
        self.generation = 0  # Changes when the plugins change. Sessions refresh at their next turn.
        self._write_lock = threading.Lock()
        self._start_lock: asyncio.Lock | None = None
        self._log_file = None

    # -- availability --------------------------------------------------------------------------------

    def unavailable_reason(self) -> str | None:
        if host_dir() is None:
            return ("The plugin host is not installed. In a source checkout, run npm install in the "
                    "plugin-host folder.")
        if node_executable() is None:
            return "Node.js is not available. Install Playwright for the daemon, or install Node.js 22.15 or later."
        return None

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def wanted(self) -> bool:
        """True if a session needs the host: it runs already, or a DeepSeek bundle is installed."""
        return self.unavailable_reason() is None and (self.running or bool(installed_bundles()))

    # -- the process ---------------------------------------------------------------------------------

    async def ensure(self) -> None:
        if self.running:
            return
        if self._start_lock is None or self.loop is not asyncio.get_running_loop():
            self._start_lock = asyncio.Lock()
        async with self._start_lock:
            if not self.running:
                await self._start()

    async def _start(self) -> None:
        reason = self.unavailable_reason()
        if reason:
            raise DshError(reason)
        self.loop = asyncio.get_running_loop()
        home = dsh_home()
        home.mkdir(parents=True, exist_ok=True)
        logs = harness_home() / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        self._log_file = open(logs / "plugin-host.log", "ab")  # noqa: SIM115 - the process writes to it.
        folder = host_dir()
        assert folder is not None
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.proc = subprocess.Popen(
            [node_executable(), str(folder / "src" / "main.mjs"), "--home", str(home)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._log_file, cwd=str(folder),
            creationflags=flags,
        )
        proc = self.proc
        threading.Thread(target=self._read, args=(proc,), name="dsh-reader", daemon=True).start()
        try:
            self.state = await self.request("initialize", timeout=START_TIMEOUT)
        except BaseException:
            self.stop_now()
            raise
        for agent_id, cwd in list(self.agents.items()):
            await self.request("agent.open", {"agentId": agent_id, "cwd": cwd})
        self.generation += 1
        log.info("The plugin host started: Node %s, runtime %s.", self.state.get("node"), self.state.get("runtime"))

    def _read(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            try:
                message = json.loads(raw.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                continue
            if self.loop is not None and not self.loop.is_closed():
                self.loop.call_soon_threadsafe(self._dispatch, message)
        if self.loop is not None and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self._exited, proc)

    def _dispatch(self, message: dict[str, Any]) -> None:
        fut = self.pending.pop(message.get("id"), None) if "id" in message else None
        if fut is not None:
            if fut.done():
                return
            error = message.get("error")
            if error:
                fut.set_exception(DshError(str(error.get("message")), error.get("code"), error.get("data")))
            else:
                fut.set_result(message.get("result"))
            return
        method = message.get("method")
        params = message.get("params") or {}
        if method == "changed":
            self.generation += 1
        elif method == "log":
            level = {"error": logging.ERROR, "warn": logging.WARNING, "info": logging.INFO}.get(params.get("level"), logging.DEBUG)
            log.log(level, "[%s] %s", params.get("name"), params.get("text"))

    def _exited(self, proc: subprocess.Popen) -> None:
        if self.proc is proc:
            self.proc = None
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(DshError("The plugin host stopped. See ~/.harness/logs/plugin-host.log."))
        self.pending.clear()
        self.generation += 1

    def _write(self, message: dict[str, Any]) -> None:
        proc = self.proc
        if proc is None or proc.stdin is None:
            raise DshError("The plugin host is not running.")
        data = (json.dumps(message) + "\n").encode("utf-8")
        with self._write_lock:
            try:
                proc.stdin.write(data)
                proc.stdin.flush()
            except OSError as e:
                raise DshError(f"The plugin host does not accept messages: {e}") from None

    async def request(self, method: str, params: dict[str, Any] | None = None, timeout: float | None = CALL_TIMEOUT) -> Any:
        if method != "initialize":
            await self.ensure()
        request_id = self.next_id
        self.next_id += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[request_id] = fut
        try:
            self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
            return await asyncio.wait_for(asyncio.shield(fut), timeout)
        except asyncio.TimeoutError:
            self._cancel(request_id)
            raise DshError(f"The plugin host did not answer {method} in {timeout:.0f} seconds.") from None
        except asyncio.CancelledError:
            self._cancel(request_id)
            raise
        finally:
            self.pending.pop(request_id, None)

    def _cancel(self, request_id: int) -> None:
        try:
            self._write({"jsonrpc": "2.0", "method": "$/cancel", "params": {"id": request_id}})
        except DshError:
            pass

    async def restart(self) -> None:
        """Start a new host process: a changed package needs new module code."""
        await self.stop()
        await self.ensure()

    async def stop(self) -> None:
        if not self.running:
            return
        try:
            await self.request("shutdown", timeout=5)
        except DshError:
            pass
        proc = self.proc
        if proc is not None:
            try:
                await asyncio.to_thread(proc.wait, 5)
            except subprocess.TimeoutExpired:
                proc.kill()
        self.proc = None

    def stop_now(self) -> None:
        """Stop the process from any thread. For a daemon that stops."""
        proc, self.proc = self.proc, None
        if proc is not None and proc.poll() is None:
            try:
                proc.stdin.close()  # type: ignore[union-attr]
                proc.wait(3)
            except Exception:  # noqa: BLE001
                proc.kill()

    # -- the Plugins screen ---------------------------------------------------------------------------

    async def describe(self) -> dict[str, Any]:
        """The DeepSeek part of the Plugins screen. It does not start the host only to show an empty list."""
        reason = self.unavailable_reason()
        if reason:
            return {"available": False, "reason": reason, "bundles": [], "orphans": [], "warnings": []}
        if not self.running and not installed_bundles():
            return {"available": True, "running": False, "bundles": [], "orphans": [], "warnings": [],
                    "home": str(dsh_home())}
        state = await self.request("state")
        self.state = state
        return {"available": True, "running": True, **state}


BRIDGE = DshBridge()


# -- one session ------------------------------------------------------------------------------------------


class DshTool(Tool):
    """A tool of a DeepSeek plugin. It runs in the plugin host, through the DeepSeek tool pipeline.

    The user approves each call by default, as for MCP tools. A rule with the tool name allows it.
    """

    needs_approval = True

    def __init__(self, session: "DshSession", schema: dict[str, Any]):
        self.session = session
        self.name = str(schema["name"])
        self.description = str(schema.get("description") or "")[:MAX_DESCRIPTION]
        parameters = schema.get("parameters")
        self.parameters = parameters if isinstance(parameters, dict) else {"type": "object", "properties": {}}

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        return Approval(key=json.dumps(args, sort_keys=True, ensure_ascii=False)[:500], rule=self.name)

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        try:
            result = await self.session.bridge.request("tools.execute", {
                "agentId": self.session.agent_id, "callId": f"call_{uuid.uuid4().hex[:12]}",
                "name": self.name, "arguments": args,
            }, timeout=None)
        except DshError as e:
            return ToolResult(f"The DeepSeek plugin tool failed: {e}", is_error=True)
        return ToolResult(str(result.get("text") or ""), is_error=bool(result.get("isError")))


class DshSession:
    """The DeepSeek plugins of one Harness session: one shim agent in the plugin host."""

    def __init__(self, bridge: DshBridge, cwd: Path | None):
        self.bridge = bridge
        self.cwd = str(cwd) if cwd is not None else None
        self.agent_id = f"session-{uuid.uuid4().hex[:12]}"
        self.tools: list[Tool] = []
        self.commands: dict[str, Any] = {}
        self.skills: dict[str, Skill] = {}
        self.prompt = ""
        self.seen = -1  # The bridge generation of the last snapshot.

    async def open(self) -> None:
        await self.bridge.ensure()
        await self.bridge.request("agent.open", {"agentId": self.agent_id, "cwd": self.cwd})
        self.bridge.agents[self.agent_id] = self.cwd
        await self.refresh()

    async def close(self) -> None:
        self.bridge.agents.pop(self.agent_id, None)
        if self.bridge.running:
            try:
                await self.bridge.request("agent.close", {"agentId": self.agent_id}, timeout=10)
            except DshError:
                pass

    @property
    def stale(self) -> bool:
        return self.seen != self.bridge.generation

    async def refresh(self) -> None:
        """Read the tools, commands, skills, and prompt text of the plugins for this agent."""
        from .host import Command  # host.py imports this module.

        generation = self.bridge.generation
        snap = await self.bridge.request("snapshot", {"agentId": self.agent_id})
        self.tools = [DshTool(self, s) for s in snap.get("tools") or [] if isinstance(s, dict) and s.get("name")]
        commands = {}
        for c in snap.get("commands") or []:
            name = str(c.get("name") or "")
            if name:
                commands[name] = Command(name, str(c.get("description") or ""), self._command_handler(name),
                                         str(c.get("hint") or ""), "deepseek")
        self.commands = commands
        self.skills = {s.name: s for s in (self._skill(raw) for raw in snap.get("skills") or []) if s is not None}
        self.prompt = str(snap.get("prompt") or "")
        self.seen = generation

    def _command_handler(self, name: str) -> Callable[[Any], Any]:
        async def handler(invocation: Any) -> str:
            result = await self.bridge.request("commands.execute", {
                "agentId": self.agent_id, "line": f"/{name} {invocation.args}".strip()}, timeout=None)
            if not result.get("found"):
                return f"The DeepSeek command /{name} is no longer available."
            text = str(result.get("text") or "")
            return f"Error: {text}" if result.get("kind") == "error" else text
        return handler

    def _skill(self, raw: dict[str, Any]) -> Skill | None:
        name = raw.get("name")
        content = raw.get("content")
        if not isinstance(name, str) or not isinstance(content, str):
            return None
        description = " ".join(str(x) for x in (raw.get("description"), raw.get("whenToUse")) if x)
        base = raw.get("resourceBase")
        resource_dir = Path(base) if isinstance(base, str) and Path(base).is_dir() else None
        return Skill(
            name=name, description=description[:MAX_DESCRIPTION], path=Path("deepseek") / name / "SKILL.md",
            source="plugin", origin="deepseek", disable_model_invocation=not raw.get("modelInvocable", True),
            user_invocable=bool(raw.get("userInvocable", True)), content=content, resource_dir=resource_dir,
        )
