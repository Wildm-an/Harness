"""The bridge to the Node plugin host, which runs DeepSeek Harness plugins (docs/PLUGINS.md).

One host process serves the whole daemon. It starts when a session opens and a DeepSeek bundle
is installed, or when the Plugins screen changes the DeepSeek plugins. The daemon talks to it
with JSON-RPC 2.0 on stdin and stdout, one JSON message on each line.

Each session gets a DshSession: one shim agent in the host, and the tools, commands, skills,
and prompt text that the plugins give that agent. The PluginHost of the session adds them to
the agent, next to the Python plugins.

Phase 2: the session also adds handlers to the hook bus of the agent. They send the agent and
tool events of the loop to the host (for example agent/pre-step and tools/pre-execute), only for
the events that have a DeepSeek listener. The host sends requests back: "approval.request" (the
permission card) and the notification "agent.steer" (a user message for the next step).
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
import time
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
    # A daemon that "Update daemon" moved from a source folder to site-packages (update.py).
    hint = harness_home() / "plugin-host-path"
    if hint.is_file():
        candidates.append(Path(hint.read_text(encoding="utf-8").strip()))
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
        self.sessions: dict[str, "DshSession"] = {}  # Agent id -> session, for the requests of the host.
        self._incoming: dict[Any, asyncio.Task] = {}  # Requests of the host that run now.
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
        if method and "id" in message:
            self._incoming[message["id"]] = asyncio.ensure_future(self._answer(message["id"], method, params))
            return
        if method == "$/cancel":
            task = self._incoming.pop(params.get("id"), None)
            if task is not None:
                task.cancel()
            return
        if method == "agent.steer":
            session = self.sessions.get(str(params.get("agentId")))
            if session is not None:
                session.on_steer(str(params.get("text") or ""))
            return
        if method == "changed":
            self.generation += 1
        elif method == "log":
            level = {"error": logging.ERROR, "warn": logging.WARNING, "info": logging.INFO}.get(params.get("level"), logging.DEBUG)
            log.log(level, "[%s] %s", params.get("name"), params.get("text"))

    async def _answer(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        """Answer a request of the host."""
        try:
            if method != "approval.request":
                raise DshError(f"Unknown method: {method}", -32601)
            session = self.sessions.get(str(params.get("agentId")))
            outcome = await session.approve(params) if session is not None else "unavailable"
            self._reply(request_id, {"outcome": outcome})
        except asyncio.CancelledError:
            self._reply(request_id, {"outcome": "cancelled"})
        except DshError as e:
            self._reply(request_id, None, {"code": e.code or -32603, "message": str(e)})
        except Exception as e:  # noqa: BLE001 - the host must get an answer.
            log.exception("The answer to %s failed", method)
            self._reply(request_id, None, {"code": -32603, "message": f"{type(e).__name__}: {e}"})
        finally:
            self._incoming.pop(request_id, None)

    def _reply(self, request_id: Any, result: Any, error: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
        if error is not None:
            message["error"] = error
        else:
            message["result"] = result
        try:
            self._write(message)
        except DshError:
            pass

    def notify(self, method: str, params: dict[str, Any]) -> None:
        """Send a notification to the host. It has no answer, so the loop does not wait."""
        if not self.running:
            return
        try:
            self._write({"jsonrpc": "2.0", "method": method, "params": params})
        except DshError:
            pass

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
        self.listeners: set[str] = set()  # The DeepSeek events that have listeners.
        self.agent: Any = None  # The Harness agent of the session. Agent.set_plugins sets it.
        self.hooks: Any = None  # The hook bus of the PluginHost. The handlers below go there.
        self._unhook: list[Callable[[], Any]] = []
        self._stream: dict[str, Any] = {}  # The assistant-stream frame state of the current step.
        self.warnings: list[str] = []

    async def open(self, source: str = "startup") -> None:
        await self.bridge.ensure()
        opened = await self.bridge.request("agent.open", {"agentId": self.agent_id, "cwd": self.cwd, "source": source})
        if isinstance(opened, dict) and opened.get("warning"):
            self.warnings.append(str(opened["warning"]))
        self.bridge.agents[self.agent_id] = self.cwd
        self.bridge.sessions[self.agent_id] = self
        await self.refresh()

    async def close(self) -> None:
        self._bind_hooks(set())
        self.bridge.sessions.pop(self.agent_id, None)
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
        self._bind_hooks({str(n) for n in snap.get("listeners") or []})
        self.seen = generation

    # -- phase 2: the events of the loop ------------------------------------------------------------

    def _bind_hooks(self, listeners: set[str]) -> None:
        """Add a handler to the hook bus for each event that a DeepSeek plugin listens to (decision D5)."""
        for dispose in self._unhook:
            dispose()
        self._unhook = []
        self.listeners = listeners
        if self.hooks is None:
            return
        wanted = {
            "tool.before": "tools/pre-execute" in listeners,
            "tool.after": bool({"tools/post-execute", "tools/result"} & listeners),
            "step.before": "agent/pre-step" in listeners,
            "request.before": "agent/request" in listeners,
            "request.error": "agent/request-error" in listeners,
            "turn.stopping": "agent/turn-stopping" in listeners,
            "turn.start": bool({"agent/status", "agent/inbox/inserted", "agent/inbox/claimed"} & listeners),
            "turn.end": bool({"agent/status", "agent/error"} & listeners),
            "stream.text": "agent/assistant-stream" in listeners,
            "stream.end": "agent/assistant-stream" in listeners,
        }
        handlers = {
            "tool.before": self._tool_before, "tool.after": self._tool_after, "step.before": self._step_before,
            "request.before": self._request_before, "request.error": self._request_error,
            "turn.stopping": self._turn_stopping, "turn.start": self._turn_start, "turn.end": self._turn_end,
            "stream.text": self._stream_text, "stream.end": self._stream_end,
        }
        for event, on in wanted.items():
            if on:
                self._unhook.append(self.hooks.add(event, handlers[event]))

    async def _dispatch(self, name: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Run one waterfall or serial event in the host. An error is logged: the turn continues."""
        try:
            result = await self.bridge.request("event.dispatch", {"agentId": self.agent_id, "name": name, "payload": payload})
        except DshError as e:
            log.warning("The DeepSeek event %s failed: %s", name, e)
            return {}
        return result if isinstance(result, dict) else {}

    def _emit(self, name: str, payload: dict[str, Any]) -> None:
        if name in self.listeners:
            self.bridge.notify("event.emit", {"agentId": self.agent_id, "name": name, "payload": payload})

    def _is_dsh_tool(self, name: str) -> bool:
        # A DeepSeek tool gets its events in the host, through the DeepSeek tool pipeline.
        return any(t.name == name for t in self.tools)

    async def _tool_before(self, call: Any) -> None:
        if self._is_dsh_tool(call.name):
            return
        result = await self._dispatch("tools/pre-execute", {"callId": call.call_id, "name": call.name, "arguments": call.args})
        decision = result.get("decision") or {}
        kind = decision.get("kind")
        if kind == "deny":
            call.block(str(decision.get("reason") or "A DeepSeek plugin denied the tool call."))
        elif kind == "cancel":
            call.block("A DeepSeek plugin cancelled the tool call.", cancel=True)
        elif kind == "ask":
            reason = decision.get("reason") or (decision.get("displayReason") or {}).get("en")
            call.ask(str(reason or "A DeepSeek plugin asks for approval."))

    async def _tool_after(self, call: Any) -> None:
        if self._is_dsh_tool(call.name) or call.result is None:
            return
        payload = {"callId": call.call_id, "name": call.name, "arguments": call.args,
                   "result": {"isError": call.result.is_error, "text": call.result.output}}
        # A blocked call has a final result: no tools/post-execute, only tools/result (as in DeepSeek).
        if "tools/post-execute" in self.listeners and not call.blocked:
            decision = (await self._dispatch("tools/post-execute", payload)).get("decision") or {}
            if decision.get("kind") == "block":
                call.result = ToolResult(str(decision.get("text") or "A DeepSeek plugin blocked the tool result."), is_error=True)
            elif decision.get("text") is not None:
                call.result.output = str(decision["text"])
            for text in decision.get("contexts") or []:
                call.add_context(str(text))
            payload["result"] = {"isError": call.result.is_error, "text": call.result.output}
        self._emit("tools/result", payload)

    async def _step_before(self, event: Any) -> None:
        result = await self._dispatch("agent/pre-step", {"turn": event.turn, "step": event.step, "messages": event.messages})
        if result.get("kind") == "reject":
            event.reject("A DeepSeek plugin ended the turn.")
        elif isinstance(result.get("messages"), list):
            event.messages = [str(m) for m in result["messages"]]

    async def _request_before(self, event: Any) -> None:
        config = {"provider": event.provider, "model": event.model}
        for key, value in (("temperature", event.temperature), ("maxTokens", event.max_tokens), ("stop", event.stop),
                           ("reasoningEffort", event.reasoning_effort)):
            if value is not None:
                config[key] = value
        result = (await self._dispatch("agent/request", {"turn": event.turn, "step": event.step, "config": config})).get("config")
        if not isinstance(result, dict):
            return
        event.provider = str(result.get("provider") or event.provider)
        event.model = str(result.get("model") or event.model)
        event.temperature = result.get("temperature", event.temperature)
        event.max_tokens = result.get("maxTokens", event.max_tokens)
        event.stop = result.get("stop", event.stop)
        event.reasoning_effort = result.get("reasoningEffort", event.reasoning_effort)

    async def _request_error(self, event: Any) -> None:
        result = await self._dispatch("agent/request-error", {"turn": event.turn, "step": event.step,
                                                              "provider": event.provider, "message": event.error})
        event.retry = event.retry or bool(result.get("retry"))

    async def _turn_stopping(self, event: Any) -> None:
        for text in (await self._dispatch("agent/turn-stopping", {"turn": event.turn})).get("steered") or []:
            event.steer(str(text))

    async def _turn_start(self, event: Any) -> None:
        turn = (self.agent.turn_number + 1) if self.agent is not None else 0
        self._emit("agent/inbox/inserted", {"text": event.text, "turn": turn})
        self._emit("agent/status", {"status": "running"})
        self._emit("agent/inbox/claimed", {"text": event.text, "turn": turn})

    async def _turn_end(self, event: Any) -> None:
        if event.stop == "error":
            self._emit("agent/error", {"turn": self.agent.turn_number if self.agent is not None else 0})
        self._emit("agent/status", {"status": "idle"})

    async def _stream_text(self, event: Any) -> None:
        key = f"{event.turn}:{event.step}"
        if self._stream.get("key") != key:
            self._stream = {"key": key, "attemptId": f"attempt-{uuid.uuid4().hex[:12]}", "index": 0}
            self._emit("agent/assistant-stream", {"frame": {"type": "start", "attemptId": self._stream["attemptId"],
                                                            "revision": 0, "turn": event.turn, "step": event.step}})
        index = self._stream["index"]
        self._stream["index"] = index + 1
        self._emit("agent/assistant-stream", {"frame": {
            "type": "chunk", "attemptId": self._stream["attemptId"], "revision": 0, "index": index,
            "time": int(time.time() * 1000), "chunk": {"type": "text-delta", "index": 0, "text": event.text}}})

    async def _stream_end(self, event: Any) -> None:
        if self._stream.get("key") != f"{event.turn}:{event.step}":
            await self._stream_text(type(event)(event.turn, event.step, "", event.cwd))  # A reply with no text.
        self._emit("agent/assistant-stream", {"frame": {
            "type": "end", "attemptId": self._stream["attemptId"], "revision": 0, "index": self._stream["index"],
            "outcome": {"kind": "committed", "eventType": "assistant/message", "seq": 0}}})
        self._stream = {}

    async def approve(self, params: dict[str, Any]) -> str:
        """A DeepSeek tool that a plugin asks about: the permission card of the session."""
        agent = self.agent
        if agent is None:
            return "unavailable"
        tool = str(params.get("toolName") or "tool")
        reason = params.get("reason") or "A DeepSeek plugin asks for approval."
        decision = await agent.gate.approver({
            "request_id": uuid.uuid4().hex, "tool": tool, "input": {"reason": reason},
            "diff": None, "rule": None, "reason": reason,
        })
        return "allowed-once" if decision in ("allow_once", "allow_always") else "rejected"

    def on_steer(self, text: str) -> None:
        """A plugin added a user message. It goes into the next step of the agent."""
        if text and self.agent is not None:
            self.agent.pending_steer.append(text)

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
