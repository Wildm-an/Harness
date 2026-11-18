"""ACP (Agent Client Protocol): another harness runs the agent loop of a session.

The daemon is the ACP client. It starts the harness as a subprocess and sends JSON-RPC 2.0
messages over its stdin and stdout, one JSON object on each line
(https://agentclientprotocol.com/protocol/overview).

``AcpAgent`` is an ``Agent`` with another ``run_turn``: it sends the prompt to the harness and
changes the ``session/update`` notifications into the events of the client protocol:

- ``agent_message_chunk`` -> ``token``
- ``agent_thought_chunk`` -> ``thinking``
- ``tool_call`` and ``tool_call_update`` -> ``tool.start`` and ``tool.result`` (with a diff)
- ``plan`` -> an ``update_plan`` call (the task list)
- ``session/request_permission`` -> ``permission.request``
- the end of ``session/prompt`` -> ``turn.end``

The harness runs its own model and context. Harness connects its features to the harness when
the harness supports them:

- ``fs/read_text_file`` and ``fs/write_text_file``: file reads and edits go through Harness. An edit
  gets a checkpoint (rewind), the deny rules and plan mode apply, and the editor tabs update.
- ``terminal/*``: Harness runs the commands (acp_terminal.py). The tool rows show their output.
- The MCP server "harness" (acp_mcp.py): the Harness tools and the MCP servers of the user.
- A model of a Harness provider (acp_models.py), when the user chose one for the harness.
- ``available_commands_update``: the commands of the harness are in the / menu.
- The models (``models`` or a ``configOptions`` entry of the category "model"): the model menu.
- ``usage_update``: the context ring.

The history of the session keeps the messages in the form of agent.py, so the client shows a
stored session in the same way.
"""

from __future__ import annotations

import asyncio
import collections
import difflib
import json
import logging
import os
import re
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from .auto_mode import bypass_safety_rules, hard_rule
from .permissions import SAFETY_BLOCK
from . import __version__, acp_harnesses, acp_icons, acp_mcp, acp_models, agent_auth
from .acp_harnesses import HarnessError, HarnessSpec, launch_argv
from .acp_terminal import TerminalError, TerminalHost
from .agent import INTERRUPTED, Agent, user_message
from .config import load_settings
from .created import before_call, created_files
from .files import file_hash, relpath
from .permissions import PLAN_BLOCK
from .providers import ModelClient, Provider
from .tools import ToolResult, truncate
from .tools.base import Approval

log = logging.getLogger("harness.acp")

PROTOCOL_VERSION = 1
PROVIDER_NAME = "acp"  # The provider name of an ACP session in storage. The model is the harness id.
START_TIMEOUT = 180.0  # npx can download the package at the first start.
REQUEST_TIMEOUT = 60.0  # session/new, session/load, session/set_mode.
CANCEL_WAIT = 5.0  # The time that the harness gets to end the prompt after session/cancel.
LINE_LIMIT = 64 * 1024 * 1024  # The longest JSON line. A file read can be large.
STDERR_LINES = 30
HANDOFF_CHARS = 64_000  # About 16,000 tokens, the default budget of T3 Code (T3CODE_CONTEXT_HANDOFF_TOKEN_CAP).
HANDOFF_ITEM_CHARS = 6_000  # One message or one result at most: a longer one is cut, with a note.
AUTH_REQUIRED = -32000
METHOD_NOT_FOUND = -32601
MAX_READ_BYTES = 10 * 1024 * 1024  # fs/read_text_file: the largest file.
MAX_COMMANDS = 100

# The tool name and the input of a tool call, for the tool rows of the client (client chat/toolText.ts).
ACP_TOOL = "acp"  # A call with no Harness tool name: the client shows its title.


class AcpError(Exception):
    pass


def placeholder_client(harness_id: str) -> ModelClient:
    """The model client of an ACP session. It makes no requests: the harness has its own model."""
    return ModelClient(Provider(name=PROVIDER_NAME, base_url=""), harness_id)


def _own_group() -> dict[str, Any]:
    if sys.platform == "win32":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0) | subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _kill_tree(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            import signal

            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.TimeoutExpired):
        pass
    if proc.returncode is None:
        try:
            proc.kill()
        except ProcessLookupError:
            pass


# Called with (method, params) of a notification of the harness.
OnNotification = Callable[[str, dict[str, Any]], Awaitable[None]]
# Called with (method, params) of a request of the harness. Returns the result, or raises AcpError.
OnRequest = Callable[[str, dict[str, Any]], Awaitable[Any]]


class AcpConnection:
    """A JSON-RPC 2.0 connection to a harness subprocess over stdio."""

    def __init__(self, argv: list[str], env: dict[str, str], cwd: Path, name: str,
                 on_notification: OnNotification, on_request: OnRequest):
        self.argv = argv
        self.env = env
        self.cwd = cwd
        self.name = name
        self.on_notification = on_notification
        self.on_request = on_request
        self.proc: asyncio.subprocess.Process | None = None
        self._next_id = 0
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._tasks: list[asyncio.Task[Any]] = []
        self._stderr: collections.deque[str] = collections.deque(maxlen=STDERR_LINES)
        self._write_lock = asyncio.Lock()
        self.closed = False

    async def start(self) -> None:
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.argv, cwd=str(self.cwd), env={**os.environ, **self.env},
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                limit=LINE_LIMIT, **_own_group())
        except OSError as e:
            raise AcpError(f"Harness could not start {self.name}: {e}") from None
        self._tasks = [asyncio.ensure_future(self._read()), asyncio.ensure_future(self._read_stderr())]

    def stderr_tail(self) -> str:
        return "\n".join(self._stderr)

    def _stopped_error(self) -> AcpError:
        code = self.proc.returncode if self.proc is not None else None
        tail = self.stderr_tail()
        text = f"{self.name} stopped" + (f" (exit code {code})" if code is not None else "") + "."
        return AcpError(text + (f" Its last output:\n{tail}" if tail else ""))

    async def _send(self, message: dict[str, Any]) -> None:
        if self.proc is None or self.proc.stdin is None or self.closed:
            raise self._stopped_error()
        data = (json.dumps({"jsonrpc": "2.0", **message}, ensure_ascii=False) + "\n").encode("utf-8")
        async with self._write_lock:
            try:
                self.proc.stdin.write(data)
                await self.proc.stdin.drain()
            except (ConnectionError, OSError):
                raise self._stopped_error() from None

    async def request(self, method: str, params: dict[str, Any], timeout: float | None = REQUEST_TIMEOUT) -> Any:
        self._next_id += 1
        request_id = self._next_id
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = fut
        try:
            await self._send({"id": request_id, "method": method, "params": params})
            if timeout is None:
                return await fut
            try:
                return await asyncio.wait_for(asyncio.shield(fut), timeout)
            except asyncio.TimeoutError:
                raise AcpError(f"{self.name} did not answer {method} in {int(timeout)} seconds.") from None
        finally:
            self._pending.pop(request_id, None)

    def request_future(self, method: str, params: dict[str, Any]) -> asyncio.Future[Any]:
        """Send a request, and return the future of its result (for session/prompt, which can take long)."""
        self._next_id += 1
        request_id = self._next_id
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = fut
        fut.add_done_callback(lambda _: self._pending.pop(request_id, None))

        async def send() -> None:
            try:
                await self._send({"id": request_id, "method": method, "params": params})
            except AcpError as e:
                if not fut.done():
                    fut.set_exception(e)

        self._tasks.append(asyncio.ensure_future(send()))
        return fut

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._send({"method": method, "params": params})

    async def _read(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        try:
            while True:
                try:
                    line = await self.proc.stdout.readline()
                except ValueError:  # A line longer than LINE_LIMIT.
                    log.warning("%s sent a line that is too long", self.name)
                    continue
                if not line:
                    break
                text = line.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    message = json.loads(text)
                except json.JSONDecodeError:
                    log.info("%s: %s", self.name, text[:500])  # Not JSON: a log line on stdout.
                    continue
                if isinstance(message, dict):
                    await self._dispatch(message)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - the connection ends with an error for each open request.
            log.exception("The ACP reader of %s failed", self.name)
        finally:
            if self.proc is not None:
                try:
                    await asyncio.wait_for(self.proc.wait(), 2)
                except (asyncio.TimeoutError, ProcessLookupError):
                    pass
            error = self._stopped_error()
            self.closed = True
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(error)
            self._pending.clear()

    async def _read_stderr(self) -> None:
        assert self.proc is not None and self.proc.stderr is not None
        while True:
            try:
                line = await self.proc.stderr.readline()
            except ValueError:
                continue
            if not line:
                return
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                self._stderr.append(text[:500])
                log.info("%s stderr: %s", self.name, text[:500])

    async def _dispatch(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        if isinstance(method, str):
            params = message.get("params") if isinstance(message.get("params"), dict) else {}
            if "id" in message:
                # A request of the harness, for example session/request_permission. It can wait for the
                # user, so it runs in its own task: the updates of the turn continue.
                self._tasks.append(asyncio.ensure_future(self._answer(message["id"], method, params)))
            else:
                try:
                    await self.on_notification(method, params)
                except Exception:  # noqa: BLE001 - one bad update does not stop the turn.
                    log.exception("The ACP notification %s of %s failed", method, self.name)
            return
        request_id = message.get("id")
        fut = self._pending.get(request_id) if isinstance(request_id, int) else None
        if fut is None or fut.done():
            return
        if "error" in message:
            error = message.get("error") if isinstance(message.get("error"), dict) else {}
            exc = AcpError(str(error.get("message") or "The harness returned an error."))
            exc.code = error.get("code")  # type: ignore[attr-defined]
            exc.data = error.get("data")  # type: ignore[attr-defined]
            fut.set_exception(exc)
        else:
            fut.set_result(message.get("result"))

    async def _answer(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        try:
            result = await self.on_request(method, params)
            reply: dict[str, Any] = {"id": request_id, "result": result}
        except AcpError as e:
            reply = {"id": request_id, "error": {"code": getattr(e, "code", None) or -32603, "message": str(e)}}
        except asyncio.CancelledError:
            reply = {"id": request_id, "error": {"code": -32603, "message": "The request was cancelled."}}
        except Exception as e:  # noqa: BLE001
            log.exception("The ACP request %s of %s failed", method, self.name)
            reply = {"id": request_id, "error": {"code": -32603, "message": f"{type(e).__name__}: {e}"}}
        try:
            await self._send(reply)
        except AcpError:
            pass

    async def close(self) -> None:
        self.closed = True
        if self.proc is not None:
            if self.proc.stdin is not None:
                try:
                    self.proc.stdin.close()
                except OSError:
                    pass
            _kill_tree(self.proc)
        for task in self._tasks:
            task.cancel()
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(AcpError(f"{self.name} stopped."))
        self._pending.clear()


# -- the agent ---------------------------------------------------------------------------------------------


def _text_of(block: Any) -> str:
    """The text of an ACP content block."""
    if not isinstance(block, dict):
        return ""
    kind = block.get("type")
    if kind == "text":
        return str(block.get("text") or "")
    if kind == "resource_link":
        return str(block.get("uri") or block.get("name") or "")
    if kind == "resource":
        resource = block.get("resource") if isinstance(block.get("resource"), dict) else {}
        return str(resource.get("text") or resource.get("uri") or "")
    return ""


def _data_url_block(url: str) -> dict[str, Any] | None:
    m = re.match(r"data:([\w/+.-]+);base64,(.*)", url, re.S)
    if not m:
        return None
    return {"type": "image", "mimeType": m.group(1), "data": m.group(2)}


def _command_text(raw: dict[str, Any]) -> str:
    command = raw.get("command") or raw.get("cmd")
    if isinstance(command, list):
        parts = [str(p) for p in command]
        # A command such as ["bash", "-lc", "npm test"]: show the script.
        if len(parts) == 3 and parts[1] in ("-c", "-lc", "/c"):
            return parts[2]
        return " ".join(parts)
    return str(command) if command else ""


def unified_diff(path: str, old: str | None, new: str) -> str:
    """A unified diff in the git form that the client parses (client lib/diff.ts)."""
    old_lines = (old or "").splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    head = f"--- {'/dev/null' if old is None else 'a/' + path}\n+++ b/{path}\n"
    body = "".join(line if line.endswith("\n") else line + "\n"
                   for line in list(difflib.unified_diff(old_lines, new_lines, n=3))[2:])
    return head + body if body else ""


class _Call:
    """A tool call of the harness in the current turn."""

    def __init__(self, call_id: str):
        self.id = call_id
        self.title = ""
        self.kind = "other"
        self.status = "pending"
        self.raw_input: dict[str, Any] = {}
        self.raw_output: Any = None
        self.content: list[dict[str, Any]] = []
        self.locations: list[dict[str, Any]] = []
        self.started = False  # tool.start was sent.
        self.ended = False  # tool.result was sent.

    def update(self, data: dict[str, Any]) -> None:
        if isinstance(data.get("title"), str):
            self.title = data["title"]
        if isinstance(data.get("kind"), str):
            self.kind = data["kind"]
        if isinstance(data.get("status"), str):
            self.status = data["status"]
        if isinstance(data.get("rawInput"), dict):
            self.raw_input = data["rawInput"]
        if "rawOutput" in data:
            self.raw_output = data["rawOutput"]
        if isinstance(data.get("content"), list):
            self.content = [c for c in data["content"] if isinstance(c, dict)]
        if isinstance(data.get("locations"), list):
            self.locations = [loc for loc in data["locations"] if isinstance(loc, dict)]


@dataclass
class _McpCard:
    """The chat cards of one call of the Harness MCP server: a ToolCardData, and the new PDF and Word files."""

    name: str
    args: dict[str, Any]
    output: str
    card: dict[str, Any] | None
    created: list[str]

    def matches(self, call: _Call) -> bool:
        """True when the tool call of the harness is this MCP call: the title has the tool name (for example
        "mcp__harness__send_file"), or the input is the same."""
        if re.search(rf"(?<![A-Za-z0-9]){re.escape(self.name)}(?![A-Za-z0-9])", call.title):
            return True
        raw = call.raw_input
        return bool(self.args) and (raw == self.args or raw.get("arguments") == self.args)


HARNESS_AUTO = "harness:auto"  # The mode menu: Auto mode of Harness for a harness with no Auto mode.
# The Harness permission mode for a mode of a harness. The gate of Harness follows the mode that the menu shows.
MODE_MAP = {
    "default": "default", "ask": "default", "manual": "default",
    "acceptEdits": "acceptEdits", "accept_edits": "acceptEdits", "dont_ask": "acceptEdits",
    "plan": "plan", "read_only": "plan", "readonly": "plan",
    "auto": "auto",
    "bypassPermissions": "bypassPermissions", "bypass": "bypassPermissions", "yolo": "bypassPermissions",
}

AUTO_NO_MODEL = ("Auto mode has no model to check the actions of {name}: its own model is not in Harness. Choose "
                 "an \"Auto mode model\" on Settings > Agents, then Harness checks these actions for you.")


class _GateTool:
    """The tool of a permission request of the harness, for the permission gate (permissions.PermissionGate)."""

    needs_approval = True
    read_only = False

    def __init__(self, name: str):
        self.name = name


class AcpAgent(Agent):
    """An agent whose loop runs in another harness, through ACP."""

    def __init__(self, *, harness: HarnessSpec, aux_client: ModelClient | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self.harness = harness
        # routine_create: a routine of this session runs with this agent and its current model.
        self.ctx.agent = lambda: (self.harness.id, self.acp_model or self.requested_model)
        # A model of the Harness providers for the titles and the prompt suggestions. None: no such model.
        self.aux_client = aux_client
        # The model of auto mode (auto_mode.AutoReviewer): the model of the other harness is not in Harness.
        self.auto_client = aux_client
        # The permission gate of Harness decides the requests of the harness and the calls of the Harness MCP
        # server. Auto mode with no model to check the calls asks the user, as Manual mode does, and says why.
        self.gate.mode = self._gate_mode
        ask = self.gate.approver

        async def approver(request: dict[str, Any]) -> str:
            if (request.get("kind") is None and "reason" not in request and self._mode_setting() == "auto"
                    and self._gate_mode() != "auto"):
                request = {**request, "reason": AUTO_NO_MODEL.format(name=self.harness.name)}
            # The card names the harness that asks, with its logo (the user asked for this).
            request = {**request, "harness": self._card_harness()}
            return await ask(request)

        self.gate.approver = approver
        self.model_checks_pending = False
        self.model_warnings: list[str] = []
        self._conn: AcpConnection | None = None
        self._start_lock = asyncio.Lock()
        self._session_lock = asyncio.Lock()
        self._agent_caps: dict[str, Any] = {}
        self._auth_methods: list[dict[str, Any]] = []
        # The history from this index on is new to the stored ACP session: a load of that session gets a recap of
        # only this part (the delta of T3 Code). 0: the harness saw no part of the history.
        self._seen_upto = 0
        self.acp_session: str | None = self._stored_session()
        self._loaded = False  # True: the harness has the context of acp_session.
        self._recap_from = 0  # The first message of the history for the recap. More than 0: a delta recap.
        self._modes: list[str] = []
        self._mode: str | None = None
        self.acp_modes: list[dict[str, str]] = []  # The modes of the harness for the mode menu: id, name, description.
        # The mode that the user chose in the mode menu of the session: a mode id of the harness, or HARNESS_AUTO.
        # The permission gate of Harness follows it (MODE_MAP). None: the permission mode of Harness.
        self._chosen_mode: str | None = None
        # The state of the current turn.
        self._calls: dict[str, _Call] = {}
        self._text: list[str] = []
        self._thinking = False
        self._replaying = False  # session/load replays the old conversation: the client does not get it.
        self._cancelling = False
        self._needs_recap = False  # A new ACP session for a session with history: the next prompt has a recap.
        self._needs_instructions = False  # A new ACP session: the next prompt has the <harness_instructions> block.
        # The Harness MCP server of this session (acp_mcp.py). The server sets the address of the daemon.
        self.mcp_base: str | None = None
        self._mcp_secret: str | None = None
        # The chat cards (card, created) of the Harness MCP calls of this turn. Each one waits for the tool
        # call of the harness that made it (_end_call). A card with no such tool call gets its own row.
        self._cards: list[_McpCard] = []
        self.terminals =TerminalHost(self.cwd, self.ctx.shell)
        # The features of the harness that the client shows.
        self.acp_commands: list[dict[str, str]] = []  # The / commands of the harness: name, description, hint.
        self.acp_models: list[dict[str, str]] = []  # id, name, description.
        self.acp_model: str | None = None
        self._model_option: str | None = None  # The configOptions id of the model, when the harness uses one.
        # The reasoning levels of the harness (a configOptions entry of the category "thought_level").
        self.acp_efforts: list[dict[str, str]] = []
        self.acp_effort: str | None = None
        self._effort_option: str | None = None
        self._usage_known: tuple[int, int] | None = None  # usage_update: (used tokens, context size).
        self._provider_model: str | None = None  # The model id of a Harness provider in the harness (acp_models.py).
        self.requested_model: str | None = None  # A model of the harness that a switch of the agent chose.
        self.previous_agent: str | None = None  # The agent before a switch of the agent: the recap names it.

    # -- the harness process -------------------------------------------------------------------------------

    def _stored_session(self) -> str | None:
        """The ACP session id of the last turn of this harness, from the history (a stored session that opens
        again, or a switch back to this harness). As T3 Code does, a switch back resumes the native session of the
        harness: a harness that can load it gets only the turns of the other agents after its last turn
        (``_seen_upto``). A harness that cannot load it starts a new ACP session with the full handoff recap."""
        turns = [i for i, m in enumerate(self.history) if m.get("role") == "user" and m.get("origin") != "harness"]
        for n in range(len(turns) - 1, -1, -1):
            m = self.history[turns[n]]
            sid = m.get("acp_session")
            if not isinstance(sid, str) or not sid or m.get("acp_harness", self.harness.id) != self.harness.id:
                continue
            # The native session saw the history up to the next turn (that turn ran in another agent).
            self._seen_upto = turns[n + 1] if n + 1 < len(turns) else len(self.history)
            return sid
        return None

    async def _ensure_started(self) -> AcpConnection:
        async with self._start_lock:
            if self._conn is not None and not self._conn.closed:
                return self._conn
            if self._conn is not None:  # The process stopped. A new process has no context.
                self._conn = None
                self._loaded = False
            try:
                argv, env = launch_argv(self.harness)
            except HarnessError as e:
                raise AcpError(str(e)) from None
            argv, env = await self._provider_model_options(argv, env)
            conn = AcpConnection(argv, env, self.cwd, self.harness.name, self._on_notification, self._on_request)
            await conn.start()
            try:
                result = await conn.request("initialize", {
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}, "terminal": True},
                    "clientInfo": {"name": "harness", "title": "Harness", "version": __version__},
                }, timeout=START_TIMEOUT)
            except AcpError:
                await conn.close()
                raise
            result = result if isinstance(result, dict) else {}
            self._agent_caps = result.get("agentCapabilities") if isinstance(result.get("agentCapabilities"), dict) else {}
            methods = result.get("authMethods")
            self._auth_methods = [m for m in methods if isinstance(m, dict)] if isinstance(methods, list) else []
            self._conn = conn
            return conn

    async def _ensure_session(self) -> tuple[AcpConnection, bool]:
        """The connection and the ACP session. The flag is True when the harness has no context of the
        earlier conversation (a new ACP session for a session with history)."""
        async with self._session_lock:
            return await self._ensure_session_now()

    async def _ensure_session_now(self) -> tuple[AcpConnection, bool]:
        conn = await self._ensure_started()
        if self.acp_session is not None and self._loaded:
            return conn, False
        if self.acp_session is not None and self._agent_caps.get("loadSession"):
            self._replaying = True
            try:
                result = await conn.request("session/load", {"sessionId": self.acp_session, "cwd": str(self.cwd),
                                                             "mcpServers": self._mcp_servers()})
                self._read_session(result)
                self._loaded = True
                # A switch back to this harness: the turns of the other agents after its last turn go in a delta recap.
                prior = self.history[:-1] if self.in_turn else self.history
                if any(m.get("role") in ("user", "assistant") for m in prior[self._seen_upto:]):
                    self._needs_recap = True
                    self._recap_from = self._seen_upto
                # The model of the switch of the agent, else the model of the last turn: a harness can load a session
                # on its default model. Then no default alias: the chip shows the real model.
                await self._select_provider_model(conn)
                await self._leave_alias(conn)
                await self._sync_mode(conn)  # The mode menu shows the mode of the harness at once.
                await self._send_state()
                return conn, self._needs_recap
            except AcpError as e:
                log.info("%s could not load the session %s: %s", self.harness.name, self.acp_session, e)
            finally:
                self._replaying = False
        try:
            result = await conn.request("session/new", {"cwd": str(self.cwd), "mcpServers": self._mcp_servers()})
        except AcpError as e:
            if getattr(e, "code", None) == AUTH_REQUIRED or "auth" in str(e).lower():
                raise AcpError(self._auth_text(str(e))) from None
            raise
        sid = result.get("sessionId") if isinstance(result, dict) else None
        if not isinstance(sid, str) or not sid:
            raise AcpError(f"{self.harness.name} did not give a session id.")
        self.acp_session = sid
        self._loaded = True
        self._recap_from = 0  # A new ACP session knows nothing: the full recap.
        self._needs_instructions = True  # A new ACP session: the next prompt tells the model about the Harness tools.
        self._read_session(result)
        # The conversation before this ACP session: in a turn, the last message is the prompt of the turn.
        prior = self.history[:-1] if self.in_turn else self.history
        self._needs_recap = any(m.get("role") in ("user", "assistant") for m in prior)
        await self._select_provider_model(conn)
        await self._leave_alias(conn)
        await self._select_effort(conn)
        await self._sync_mode(conn)  # The mode menu shows the mode of the harness from the start.
        await self._send_state()
        return conn, self._needs_recap

    async def _provider_model_options(self, argv: list[str], env: dict[str, str]) -> tuple[list[str], dict[str, str]]:
        """The command and the environment with the model of a Harness provider, when the user chose one in
        Settings > Agents (only the user settings: a project cannot change it)."""
        self._provider_model = None
        settings = load_settings(None)
        spec = None if self.harness.custom else acp_models.choice(settings, self.harness.id)
        if spec is None or self.requested_model:
            # A model of the harness itself: the choice of the switch of the agent (session.agent), else the
            # choice of the picker of the start screen (Settings > Agents), else the model that the picker shows
            # with no choice (the current model of the harness, else its first model: no default alias).
            self._provider_model = self._expected_model(settings)
            return argv, env
        try:
            target = await acp_models.resolve(spec)
        except acp_models.ModelChoiceError as e:
            raise AcpError(f"{e} Change the model of {self.harness.name} in Settings > Agents.") from None
        extra_args, extra_env = acp_models.launch_options(self.harness.id, target)
        self._provider_model = acp_models.session_model_id(self.harness.id, target)
        return [*argv, *extra_args], {**env, **extra_env}

    def _recorded_model(self) -> str | None:
        """The model of the last turn of this harness in this session (the user messages record it)."""
        for m in reversed(self.history):
            if m.get("role") == "user" and m.get("acp_harness") == self.harness.id and m.get("acp_model"):
                return str(m["acp_model"])
        return None

    def _expected_model(self, settings: dict[str, Any] | None = None) -> str | None:
        """The model of the harness for this session: the choice of the switch of the agent (session.agent), else the
        model of its last turn in this session, else the choice of the picker of the start screen (Settings >
        Agents), else the model that the picker shows with no choice (the current model of the harness, else its
        first model: no default alias)."""
        settings = load_settings(None) if settings is None else settings
        return (self.requested_model or self._recorded_model()
                or acp_harnesses.native_choice(settings, self.harness.id)
                or (None if self.harness.custom else acp_harnesses.implied_model(self.harness.id)))

    async def _leave_alias(self, conn: AcpConnection) -> None:
        """As T3 Code, a session never stays on a model that only names the default of the harness ("default",
        "Default (recommended)"): it changes to the real model, so the chip always shows the model in use."""
        current = next((m for m in self.acp_models if m["id"] == self.acp_model), None)
        if current is None or not acp_harnesses.is_default_alias(current):
            return
        target = alias_target(self.acp_models, current)
        if target is None:
            return
        try:
            await self._change_model(conn, target)
        except AcpError as e:
            log.info("%s did not change from %s to %s: %s", self.harness.name, current["id"], target, e)

    async def _select_provider_model(self, conn: AcpConnection) -> None:
        """A new ACP session starts on the model of the Harness provider, when the harness lists it. (An agent
        setting of the harness can else choose another model.) A failure leaves the model of the harness."""
        wanted = self._provider_model
        if not wanted or wanted == self.acp_model or wanted not in {m["id"] for m in self.acp_models}:
            return
        try:
            await self._change_model(conn, wanted)
        except AcpError as e:
            log.info("%s did not change to the model %s: %s", self.harness.name, wanted, e)

    def _auth_text(self, error: str) -> str:
        names = [str(m.get("name") or m.get("id")) for m in self._auth_methods]
        how = f" Sign-in methods: {', '.join(names)}." if names else ""
        if agent_auth.supports(self.harness.id):
            return (f"{self.harness.name} needs a sign-in ({error}). Open Settings > Agents > {self.harness.name}, "
                    "select \"Sign in\", then send the prompt again.")
        return (f"{self.harness.name} needs a sign-in ({error}). Sign in to {self.harness.name} in a terminal on the "
                f"daemon computer, then send the prompt again.{how}")

    def _mcp_servers(self) -> list[dict[str, Any]]:
        """The Harness MCP server for session/new and session/load. None before the server sets the address."""
        if not self.mcp_base:
            return []
        if self._mcp_secret is None:
            self._mcp_secret = acp_mcp.register(self)
        return [acp_mcp.server_entry(self._agent_caps, f"{self.mcp_base}/acp-mcp/{self._mcp_secret}")]

    async def prepare(self) -> None:
        """Start the harness and its session when the session opens, so the model menu and the / menu
        have the features of the harness before the first prompt. A failure waits for the first prompt."""
        try:
            await self._ensure_session()
        except AcpError as e:
            log.info("%s did not start at the session open: %s", self.harness.name, e)
        except Exception:  # noqa: BLE001 - the first prompt reports the problem.
            log.exception("%s did not start at the session open", self.harness.name)

    def _read_session(self, result: Any) -> None:
        """The modes, the models, and the config options of session/new or session/load."""
        self._read_modes(result)
        if not isinstance(result, dict):
            return
        models = result.get("models")
        if isinstance(models, dict) and isinstance(models.get("availableModels"), list):
            self.acp_models = [{"id": str(m.get("modelId")), "name": str(m.get("name") or m.get("modelId")),
                                "description": str(m.get("description") or "")}
                               for m in models["availableModels"] if isinstance(m, dict) and m.get("modelId")]
            current = models.get("currentModelId")
            self.acp_model = current if isinstance(current, str) else self.acp_model
            self._model_option = None
        if isinstance(result.get("configOptions"), list):
            self._read_config(result["configOptions"])

    def _read_config(self, options: list[Any]) -> None:
        """The configOptions of the category "model" (the model menu, it replaces "models") and "thought_level"
        (the reasoning levels of the picker)."""
        for option in options:
            if not isinstance(option, dict) or option.get("type") != "select":
                continue
            category = option.get("category")
            if category not in ("model", "thought_level"):
                continue
            values = _option_values(option)
            if not values:
                continue
            current = str(option.get("currentValue")) if option.get("currentValue") is not None else None
            if category == "model":
                self.acp_models, self.acp_model, self._model_option = values, current, str(option.get("id"))
            else:
                self.acp_efforts, self.acp_effort, self._effort_option = values, current, str(option.get("id"))

    async def _send_state(self) -> None:
        if self.acp_models and not self.harness.custom:
            # The picker of the start screen shows these models before the next session starts.
            await asyncio.to_thread(acp_harnesses.save_models, self.harness.id,
                                    mark_current(self.acp_models, self.acp_model))
        if self.acp_efforts and not self.harness.custom:
            await asyncio.to_thread(acp_harnesses.save_efforts, self.harness.id, self.acp_efforts)
        await self.emit({"type": "acp.state", "harness": self.public_harness()})

    async def set_effort(self, effort: str) -> None:
        """Change the reasoning level of the ACP session (the picker)."""
        if effort not in {e["id"] for e in self.acp_efforts} or self._effort_option is None:
            raise AcpError(f"{self.harness.name} has no reasoning level {effort}.")
        conn, _ = await self._ensure_session()
        await self._change_effort(conn, effort)
        await self._send_state()

    async def _change_effort(self, conn: AcpConnection, effort: str) -> None:
        result = await conn.request("session/set_config_option", {
            "sessionId": self.acp_session, "configId": self._effort_option, "value": effort})
        if isinstance(result, dict) and isinstance(result.get("configOptions"), list):
            self._read_config(result["configOptions"])
        else:
            self.acp_effort = effort

    async def _select_effort(self, conn: AcpConnection) -> None:
        """A new ACP session starts on the reasoning level that the user chose on the start screen."""
        wanted = None if self.harness.custom else acp_harnesses.native_effort(load_settings(None), self.harness.id)
        if not wanted or wanted == self.acp_effort or self._effort_option is None \
                or wanted not in {e["id"] for e in self.acp_efforts}:
            return
        try:
            await self._change_effort(conn, wanted)
        except AcpError as e:
            log.info("%s did not change the reasoning level to %s: %s", self.harness.name, wanted, e)

    async def set_model(self, model_id: str) -> None:
        """Change the model of the ACP session (the model menu)."""
        if not self.acp_models and self._conn is None:
            # The harness did not start yet: the menu shows the saved models. The session starts on this model.
            if model_id not in {str(m.get("id")) for m in acp_harnesses.cached_models(self.harness.id)}:
                raise AcpError(f"{self.harness.name} has no model {model_id}.")
            self.requested_model = model_id
            await self._send_state()
            return
        if model_id not in {m["id"] for m in self.acp_models}:
            raise AcpError(f"{self.harness.name} has no model {model_id}.")
        conn, _ = await self._ensure_session()
        await self._change_model(conn, model_id)
        await self._send_state()

    async def _change_model(self, conn: AcpConnection, model_id: str) -> None:
        if self._model_option is not None:
            result = await conn.request("session/set_config_option", {
                "sessionId": self.acp_session, "configId": self._model_option, "value": model_id})
            if isinstance(result, dict) and isinstance(result.get("configOptions"), list):
                self._read_config(result["configOptions"])
            else:
                self.acp_model = model_id
        else:
            await conn.request("session/set_model", {"sessionId": self.acp_session, "modelId": model_id})
            self.acp_model = model_id

    def _read_modes(self, result: Any) -> None:
        modes = result.get("modes") if isinstance(result, dict) else None
        if isinstance(modes, dict):
            available = modes.get("availableModes")
            self.acp_modes = [{"id": str(m.get("id")), "name": str(m.get("name") or m.get("id")),
                               "description": str(m.get("description") or "")}
                              for m in available if isinstance(m, dict) and m.get("id")] \
                if isinstance(available, list) else []
            self._modes = [str(m.get("id")) for m in available if isinstance(m, dict) and m.get("id")] \
                if isinstance(available, list) else []
            self._mode = modes.get("currentModeId") if isinstance(modes.get("currentModeId"), str) else None

    async def _sync_mode(self, conn: AcpConnection) -> None:
        """The first time: use the mode of the harness that matches the Harness permission mode (the same id, or
        an equal mode such as "accept_edits"). Auto mode of Harness for a harness with no Auto mode is HARNESS_AUTO:
        the harness asks, and the Harness gate decides with its model. Then the mode menu shows the mode of the
        harness, and the gate follows it."""
        if self._chosen_mode is not None or not self._modes:
            return
        wanted = str(self.settings.get("permission_mode") or "default")
        target = wanted if wanted in self._modes else next(
            (m for m in self._modes if MODE_MAP.get(m) == wanted and wanted != "default"), None)
        if target is None and wanted == "auto":
            self._chosen_mode = HARNESS_AUTO
            await self._send_state()
            return
        if target is not None and target != self._mode:
            try:
                await conn.request("session/set_mode", {"sessionId": self.acp_session, "modeId": target})
                self._mode = target
            except AcpError as e:
                log.info("%s did not change the mode to %s: %s", self.harness.name, target, e)
        self._chosen_mode = self._mode
        await self._send_state()

    async def set_mode(self, mode_id: str) -> None:
        """The mode menu of an ACP session: a mode of the harness, or HARNESS_AUTO."""
        if mode_id != HARNESS_AUTO and mode_id not in self._modes:
            raise AcpError(f"{self.harness.name} has no mode {mode_id}.")
        if mode_id == HARNESS_AUTO:
            self._chosen_mode = HARNESS_AUTO
            await self._send_state()
            return
        conn, _ = await self._ensure_session()
        if mode_id != self._mode:
            await conn.request("session/set_mode", {"sessionId": self.acp_session, "modeId": mode_id})
            self._mode = mode_id
        self._chosen_mode = mode_id
        await self._send_state()

    def gate_mode_of(self, mode_id: str | None) -> str:
        """The Harness permission mode for a mode of the harness (MODE_MAP). An unknown mode is Manual."""
        if mode_id is None:
            return str(self.settings.get("permission_mode") or "default")
        if mode_id == HARNESS_AUTO:
            return "auto"
        return MODE_MAP.get(mode_id, "default")

    def _mode_setting(self) -> str:
        """The Harness permission mode of the session: the mode of the harness that the menu shows (gate_mode_of),
        or the Harness setting before the harness gives its modes."""
        if self._chosen_mode is not None:
            return self.gate_mode_of(self._chosen_mode)
        return str(self.settings.get("permission_mode") or "default")

    def _card_harness(self) -> dict[str, Any]:
        """The harness for a card of the chat: its id, its name, and its logo (a data URL, or None)."""
        icon = None if self.harness.custom else acp_icons.icon(self.harness.id)
        return {"id": self.harness.id, "name": self.harness.name, "icon": icon}

    def _gate_mode(self) -> str:
        mode = self._mode_setting()
        if mode == "auto" and (self.gate.auto is None or not self.gate.auto.available()):
            return "default"
        return mode

    async def close(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            await conn.close()
        await self.terminals.close()
        acp_mcp.unregister(self._mcp_secret)
        self._mcp_secret = None

    # -- notifications and requests of the harness ------------------------------------------------------------

    async def _on_notification(self, method: str, params: dict[str, Any]) -> None:
        if method != "session/update" or self._replaying:
            return
        # A harness can send updates right after the reply to session/new, before the id is stored here.
        if self.acp_session is not None and params.get("sessionId") not in (None, self.acp_session):
            return
        update = params.get("update")
        if not isinstance(update, dict):
            return
        kind = update.get("sessionUpdate")
        if await self._state_update(kind, update) or not self.in_turn:
            return
        if kind == "agent_message_chunk":
            text = _text_of(update.get("content"))
            if text:
                self._thinking = False
                self._text.append(text)
                self.streamed.append(text)
                await self.emit({"type": "token", "text": text})
        elif kind == "agent_thought_chunk":
            if not self._thinking:
                self._thinking = True
                await self.emit({"type": "thinking"})
        elif kind in ("tool_call", "tool_call_update"):
            call_id = update.get("toolCallId")
            if not isinstance(call_id, str) or not call_id:
                return
            call = self._calls.get(call_id)
            if call is None:
                call = self._calls[call_id] = _Call(call_id)
            call.update(update)
            self._thinking = False
            # A call of the Harness MCP server starts its row when the MCP call comes (run_harness_tool): then its
            # input is complete. (The harness can report the input while the model still writes it, and a visual
            # needs all of its code.) The end of the call starts the row too, if the MCP call did not come.
            harness_tool = acp_mcp.tool_of_title(call.title, acp_mcp.exposed_tools(self)) if call.title else None
            if harness_tool is None and (call.status in ("in_progress", "completed", "failed") or call.raw_input):
                await self._start_call(call)
            if call.status in ("completed", "failed"):
                await self._start_call(call)
                await self._end_call(call)
        elif kind == "plan":
            entries = update.get("entries")
            if isinstance(entries, list):
                await self._show_plan(entries)

    async def _state_update(self, kind: Any, update: dict[str, Any]) -> bool:
        """The updates of the session state: the commands, the mode, the options, and the usage.
        True: the update was one of them."""
        if kind == "available_commands_update":
            commands = update.get("availableCommands")
            self.acp_commands = [
                {"name": str(c["name"]).lstrip("/"), "description": str(c.get("description") or ""),
                 "hint": str((c.get("input") or {}).get("hint") or "") if isinstance(c.get("input"), dict) else ""}
                for c in (commands if isinstance(commands, list) else [])[:MAX_COMMANDS]
                if isinstance(c, dict) and isinstance(c.get("name"), str) and c["name"].strip()]
            await self._send_state()
            return True
        if kind == "current_mode_update" and isinstance(update.get("currentModeId"), str) and self._chosen_mode != HARNESS_AUTO:
            self._chosen_mode = update["currentModeId"]
        if kind == "current_mode_update":
            if isinstance(update.get("currentModeId"), str):
                self._mode = update["currentModeId"]
                await self._send_state()  # The mode menu shows the new mode.
            return True
        if kind == "config_option_update":
            if isinstance(update.get("configOptions"), list):
                self._read_config(update["configOptions"])
                await self._send_state()
            return True
        if kind == "usage_update":
            used, size = update.get("used"), update.get("size")
            if isinstance(used, int) and isinstance(size, int) and size > 0:
                self._usage_known = (used, size)  # turn.end gives it to the client (the context ring).
                self.context_length = size
            return True
        return kind in ("session_info_update", "available_modes_update")

    async def _on_request(self, method: str, params: dict[str, Any]) -> Any:
        if method == "session/request_permission":
            return await self._permission(params)
        try:
            if method == "fs/read_text_file":
                return await self._read_file(params)
            if method == "fs/write_text_file":
                return await self._write_file(params)
            if method == "terminal/create":
                return self._terminal_create(params)
            if method == "terminal/output":
                terminal = self.terminals.get(params)
                result: dict[str, Any] = {"output": terminal.output(), "truncated": terminal.truncated}
                status = terminal.exit_status()
                if status is not None:
                    result["exitStatus"] = status
                return result
            if method == "terminal/wait_for_exit":
                return await self.terminals.get(params).wait()
            if method == "terminal/kill":
                await self.terminals.get(params).kill()
                return {}
            if method == "terminal/release":
                await self.terminals.release(str(params.get("terminalId")))
                return {}
        except (TerminalError, OSError, ValueError) as e:
            raise AcpError(str(e)) from None
        error = AcpError(f"Harness does not support {method}.")
        error.code = METHOD_NOT_FOUND  # type: ignore[attr-defined]
        raise error

    async def _permission(self, params: dict[str, Any]) -> dict[str, Any]:
        """A permission request of the harness. The permission gate of Harness decides it, as for a Harness tool:
        the deny rules, Plan mode, the safety rules, the mode (also Auto), the allow rules, then a question. A call
        of the Harness MCP server is allowed here: the gate checks it when the MCP call comes (run_harness_tool)."""
        options = [o for o in params.get("options") or [] if isinstance(o, dict) and o.get("optionId")]

        def pick(*kinds: str) -> dict[str, Any] | None:
            for kind in kinds:
                for option in options:
                    if option.get("kind") == kind:
                        return option
            return None

        def selected(option: dict[str, Any] | None) -> dict[str, Any]:
            if option is None:
                return {"outcome": {"outcome": "cancelled"}}
            return {"outcome": {"outcome": "selected", "optionId": option["optionId"]}}

        allow = lambda: selected(pick("allow_once", "allow_always"))  # noqa: E731
        reject = lambda: selected(pick("reject_once", "reject_always"))  # noqa: E731
        if self._cancelling:
            return {"outcome": {"outcome": "cancelled"}}
        data = params.get("toolCall") if isinstance(params.get("toolCall"), dict) else {}
        call_id = data.get("toolCallId") if isinstance(data.get("toolCallId"), str) else None
        call = self._calls.get(call_id) if call_id else None
        if call is None:
            call = _Call(call_id or f"acp_{uuid.uuid4().hex[:12]}")
            if call_id:
                self._calls[call_id] = call
        call.update(data)
        if call.title and acp_mcp.tool_of_title(call.title, acp_mcp.exposed_tools(self)):
            return allow()
        await self._start_call(call)
        name, args = self._view(call)
        if call.kind in ("read", "search", "think") and name != "bash":
            return allow()  # As read, grep, and glob of Harness: no question.
        approval = self._approval(call, name, args)
        tool = _GateTool(approval.tool or name)
        result = await self.gate.check(tool, args, approval)
        if self._cancelling:
            return {"outcome": {"outcome": "cancelled"}}
        return allow() if result is True else reject()

    def _approval(self, call: _Call, name: str, args: dict[str, Any]) -> Approval:
        """What the permission gate checks for a call of the harness: the Harness tool name, the key that the
        rules match (a command, a path, a domain), and the rule that "Always allow" adds to the project settings."""
        diff = self._diff(call) or None
        if name == "bash":
            command = str(args.get("command") or "")
            return Approval(key=command, rule=f"bash({command})" if command else "", diff=diff)
        if name in ("edit", "read") or call.kind in ("delete", "move"):
            path = str(args.get("path") or self._path(call) or call.title)
            return Approval(key=path, rule=f"edit({path})" if path else "", tool="edit", diff=diff, input=args)
        if name == "web_fetch":
            from urllib.parse import urlparse
            host = (urlparse(str(args.get("url") or "")).hostname or "").lower()
            return Approval(key=f"domain:{host}", rule=f"web_fetch(domain:{host})" if host else "", input=args)
        if name == "web_search":
            return Approval(key=str(args.get("query") or ""), rule="web_search", input=args)
        # Another tool of the harness: the rules match its title, for example "acp(Open website)".
        title = (call.title or call.kind or "tool").strip()
        safe = bool(title) and not re.search(r"[()\n]", title)
        return Approval(key=title, rule=f"{ACP_TOOL}({title})" if safe else "", tool=ACP_TOOL, diff=diff,
                        input={"title": title, **({"input": call.raw_input} if call.raw_input else {})})

    # -- the features of Harness for the harness ------------------------------------------------------------

    def _file(self, params: dict[str, Any]) -> Path:
        path = params.get("path")
        if not isinstance(path, str) or not path:
            raise AcpError("The request needs a 'path'.")
        p = Path(path)
        return p if p.is_absolute() else self.cwd / p

    def _in_project(self, path: Path) -> str | None:
        try:
            return relpath(self.cwd, path)
        except ValueError:
            return None

    async def _read_file(self, params: dict[str, Any]) -> dict[str, Any]:
        path = self._file(params)
        try:
            if path.stat().st_size > MAX_READ_BYTES:
                raise AcpError(f"The file is larger than {MAX_READ_BYTES // (1024 * 1024)} MB: {path}")
            data = await asyncio.to_thread(path.read_bytes)
        except FileNotFoundError:
            raise AcpError(f"The file does not exist: {path}") from None
        except IsADirectoryError:
            raise AcpError(f"The path is a folder: {path}") from None
        text = data.decode("utf-8", errors="replace")
        line, limit = params.get("line"), params.get("limit")
        if isinstance(line, int) or isinstance(limit, int):
            lines = text.splitlines(keepends=True)
            start = max(int(line) - 1, 0) if isinstance(line, int) else 0
            end = start + int(limit) if isinstance(limit, int) and limit >= 0 else len(lines)
            text = "".join(lines[start:end])
        return {"content": text}

    async def _write_file(self, params: dict[str, Any]) -> None:
        """An edit of the harness. In the project: the deny rules and plan mode apply, and the old content
        is a checkpoint of the current user message (the rewind of the code)."""
        path = self._file(params)
        content = params.get("content")
        if not isinstance(content, str):
            raise AcpError("fs/write_text_file needs a 'content' text.")
        rel = self._in_project(path)
        if rel is not None:
            if self.gate.rules.denies("write", rel) or self.gate.rules.denies("edit", rel):
                raise AcpError(f"A deny rule of the project settings blocks the change of {rel}.")
            if self._mode_setting() == "plan":
                raise AcpError(PLAN_BLOCK)
            if self.on_checkpoint is not None and self.message_id is not None:
                try:
                    old: bytes | None = path.read_bytes()
                except FileNotFoundError:
                    old = None
                self.on_checkpoint(self.message_id, rel, old)
        await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_text, content, "utf-8", None, "")
        if rel is not None:
            await self._changed(str(path))
        return None

    def _terminal_create(self, params: dict[str, Any]) -> dict[str, Any]:
        command = " ".join([str(params.get("command") or ""), *[str(a) for a in params.get("args") or []]]).strip()
        if command and self.gate.rules.denies("bash", command):
            raise AcpError(f"A deny rule of the project settings blocks the command: {command}")
        # A terminal of the harness has no question card. A hard rule match is blocked, unless the user turned
        # the rules off for bypass mode ("bypass_safety_rules": "off" in ~/.harness/settings.json).
        label = hard_rule("bash", command) if command else None
        if label and not (self._mode_setting() == "bypassPermissions" and bypass_safety_rules() == "off"):
            raise AcpError(SAFETY_BLOCK.format(label=label))
        terminal = self.terminals.create(params)
        return {"terminalId": terminal.id}

    async def run_harness_tool(self, name: str, args: dict[str, Any]) -> ToolResult:
        """A call of the Harness MCP server (acp_mcp.py). The permissions and the hooks of Harness apply."""
        call_id = f"harness_{uuid.uuid4().hex[:12]}"
        # The tool row of the harness for this call starts now, with the complete input of the MCP call.
        tools = acp_mcp.exposed_tools(self)
        waiting = next((c for c in self._calls.values() if not c.started and c.title
                        and acp_mcp.tool_of_title(c.title, tools) == name), None)
        if waiting is not None:
            waiting.raw_input = dict(args)
            await self._start_call(waiting)
        snapshot = await asyncio.to_thread(before_call, self.cwd, name, args)
        result = await self._execute(name, args, None, call_id)
        if not result.limited:
            result.output = truncate(result.output, int(self.settings["max_output_chars"]))
        created = await asyncio.to_thread(created_files, self.cwd, snapshot, result.changed_paths)
        # The harness reports the call itself, after this reply. Its tool row gets the cards (_end_call).
        if result.card or created:
            self._cards.append(_McpCard(name, dict(args), result.output, result.card, created))
        for path in result.changed_paths:
            await self._changed(str(path))
        return result

    # -- tool calls ---------------------------------------------------------------------------------------

    def _rel(self, path: Any) -> str:
        if not isinstance(path, str) or not path:
            return ""
        p = Path(path)
        if not p.is_absolute():
            return path.replace("\\", "/")
        try:
            return relpath(self.cwd, p)
        except ValueError:
            return str(p)

    def _path(self, call: _Call) -> str:
        if call.locations:
            return self._rel(call.locations[0].get("path"))
        for key in ("path", "file_path", "filePath", "abs_path", "filename"):
            if isinstance(call.raw_input.get(key), str):
                return self._rel(call.raw_input[key])
        for block in call.content:
            if block.get("type") == "diff" and isinstance(block.get("path"), str):
                return self._rel(block["path"])
        return ""

    def _view(self, call: _Call) -> tuple[str, dict[str, Any]]:
        """The tool name and input for the tool row of the client."""
        raw = call.raw_input
        title = call.title or call.kind
        # A call of the Harness MCP server gets the row of the Harness tool, with its card (a visual, the browser).
        tool = acp_mcp.tool_of_title(title, acp_mcp.exposed_tools(self)) if call.title else None
        if tool is not None:
            args = raw.get("arguments") if isinstance(raw.get("arguments"), dict) else raw
            return tool, dict(args)
        if call.kind == "execute":
            command = _command_text(raw)
            if not command:
                for block in call.content:
                    terminal = self.terminals.terminals.get(str(block.get("terminalId"))) \
                        if block.get("type") == "terminal" else None
                    if terminal is not None:
                        command = terminal.label
            return "bash", {"command": command or title}
        if call.kind == "read":
            path = self._path(call)
            if path:
                return "read", {"path": path}
        if call.kind == "edit":
            path = self._path(call)
            if path:
                return "edit", {"path": path}
        if call.kind == "search":
            pattern = raw.get("pattern") or raw.get("query") or raw.get("regex")
            return "grep", {"pattern": str(pattern) if pattern else title}
        if call.kind == "fetch":
            url = raw.get("url")
            if isinstance(url, str) and url:
                return "web_fetch", {"url": url}
            query = raw.get("query")
            if isinstance(query, str) and query:
                return "web_search", {"query": query}
        return ACP_TOOL, {"title": title, **({"input": raw} if raw else {})}

    def _diff(self, call: _Call) -> str:
        diffs = []
        for block in call.content:
            if block.get("type") == "diff" and isinstance(block.get("newText"), str):
                old = block.get("oldText")
                diffs.append(unified_diff(self._rel(block.get("path")) or "file", old if isinstance(old, str) else None,
                                          block["newText"]))
        return "".join(d for d in diffs if d)

    def _output(self, call: _Call) -> str:
        parts = []
        for block in call.content:
            if block.get("type") == "content":
                text = _text_of(block.get("content"))
                if text:
                    parts.append(text)
            elif block.get("type") == "terminal":
                terminal = self.terminals.terminals.get(str(block.get("terminalId")))
                if terminal is not None:
                    parts.append(terminal.output().rstrip() or "(no output)")
        if not parts and call.raw_output is not None:
            raw = call.raw_output
            if isinstance(raw, str):
                parts.append(raw)
            elif isinstance(raw, dict):
                text = raw.get("output") or raw.get("stdout") or raw.get("content") or raw.get("result")
                parts.append(text if isinstance(text, str) else json.dumps(raw, ensure_ascii=False))
            else:
                parts.append(json.dumps(raw, ensure_ascii=False))
        if not parts and any(b.get("type") == "diff" for b in call.content):
            parts.append("The file was changed.")
        return "\n".join(parts) or ("Done." if call.status == "completed" else "The tool call failed.")

    async def _start_call(self, call: _Call) -> None:
        if call.started:
            return
        call.started = True
        name, args = self._view(call)
        text = "".join(self._text) or None
        self._text.clear()
        self.streamed.clear()
        self.history.append({"role": "assistant", "content": text, "tool_calls": [
            {"id": call.id, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}},
        ]})
        await self.emit({"type": "tool.start", "id": call.id, "name": name, "input": args})

    async def _end_call(self, call: _Call, output: str | None = None, is_error: bool | None = None) -> None:
        if call.ended:
            return
        call.ended = True
        failed = call.status == "failed" if is_error is None else is_error
        text = truncate(output if output is not None else self._output(call), int(self.settings["max_output_chars"]))
        diff = self._diff(call) or None
        cards = next((c for c in self._cards if c.matches(call)), None) if call.kind != "plan" else None
        if cards is not None:
            self._cards.remove(cards)
        card = cards.card if cards else None
        created = cards.created if cards else []
        self._add_tool_result(call.id, text, failed, diff, created=created, card=card)
        event: dict[str, Any] = {"type": "tool.result", "id": call.id, "output": text, "is_error": failed}
        if diff:
            event["diff"] = diff
        if created:
            event["created"] = created
        if card:
            event["card"] = card
        await self.emit(event)
        if call.kind in ("edit", "delete", "move") and not failed:
            for block in call.content:
                if block.get("type") == "diff" and isinstance(block.get("path"), str):
                    await self._changed(block["path"])

    async def _changed(self, path: str) -> None:
        p = Path(path) if Path(path).is_absolute() else self.cwd / path
        try:
            rel = relpath(self.cwd, p)
        except ValueError:
            return  # Not in the project.
        try:
            digest = file_hash(p) if p.is_file() else None
        except OSError:
            digest = None
        await self.emit({"type": "fs.changed", "path": rel, "hash": digest, "by": "agent"})

    async def _show_plan(self, entries: list[Any]) -> None:
        """An ACP plan is the task list: an update_plan call, as the built-in agent makes it."""
        items = []
        for entry in entries[:12]:
            if not isinstance(entry, dict) or not str(entry.get("content") or "").strip():
                continue
            status = entry.get("status")
            items.append({"content": str(entry["content"]).strip(),
                          "status": status if status in ("pending", "in_progress", "completed") else "pending"})
        if not items:
            return
        call = _Call(f"plan_{uuid.uuid4().hex[:12]}")
        call.kind = "plan"
        call.started = True
        text = "".join(self._text) or None
        self._text.clear()
        self.streamed.clear()
        args = {"items": items}
        self.history.append({"role": "assistant", "content": text, "tool_calls": [
            {"id": call.id, "type": "function", "function": {"name": "update_plan", "arguments": json.dumps(args)}},
        ]})
        await self.emit({"type": "tool.start", "id": call.id, "name": "update_plan", "input": args})
        done = sum(1 for i in items if i["status"] == "completed")
        await self._end_call(call, f"Plan shown: {done} of {len(items)} steps completed.", False)

    async def _flush_cards(self) -> None:
        """The cards of the Harness MCP calls that the harness did not report as tool calls: a row for each."""
        cards, self._cards = self._cards, []
        for c in cards:
            call_id = f"harness_{uuid.uuid4().hex[:12]}"
            text = "".join(self._text) or None
            self._text.clear()
            self.streamed.clear()
            self.history.append({"role": "assistant", "content": text, "tool_calls": [
                {"id": call_id, "type": "function", "function": {"name": c.name, "arguments": json.dumps(c.args)}},
            ]})
            await self.emit({"type": "tool.start", "id": call_id, "name": c.name, "input": c.args})
            self._add_tool_result(call_id, c.output, False, created=c.created, card=c.card)
            event: dict[str, Any] = {"type": "tool.result", "id": call_id, "output": c.output, "is_error": False}
            if c.created:
                event["created"] = c.created
            if c.card:
                event["card"] = c.card
            await self.emit(event)

    # -- turns --------------------------------------------------------------------------------------------

    def _recap(self) -> str | None:
        """The earlier conversation, for a new ACP session of a session with history (a switch of the agent, or
        an ACP session that the harness cannot load). As the portable handoff of T3 Code: a budgeted selection,
        not a summary. A short conversation goes across whole. A long one: the first request, then the newest
        messages and the key activity (tool calls with their result), each with its speaker, within HANDOFF_CHARS.
        The new request is not in it (it is the prompt). The note says how many messages are left out, and the
        agent can find them with conversation_search."""
        history = self.history[:-1] if self.in_turn else self.history
        if self._recap_from:
            return handoff_recap(history[self._recap_from:], None, self.previous_agent, delta=True)
        return handoff_recap(history, self.summary, self.previous_agent)

    def _prompt_blocks(self, text: str, images: list[str] | None, recap: str | None) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
        if self._needs_instructions:
            self._needs_instructions = False
            block = acp_mcp.instructions(acp_mcp.exposed_tools(self)) if self._mcp_servers() else ""
            if block:
                blocks.append({"type": "text", "text": block})
        if recap:
            blocks.append({"type": "text", "text": recap})
        blocks.append({"type": "text", "text": text})
        caps = self._agent_caps.get("promptCapabilities") if isinstance(self._agent_caps.get("promptCapabilities"), dict) else {}
        if images and caps.get("image"):
            blocks += [b for b in (_data_url_block(u) for u in images) if b is not None]
        elif images:
            blocks.append({"type": "text", "text": f"[The user attached {len(images)} image(s). {self.harness.name} "
                                                   "cannot get images from Harness.]"})
        return blocks

    async def run_turn(self, text: str, *, display: str | None = None, allow: tuple[str, ...] = (),
                       message_id: str | None = None, origin: str | None = None,
                       images: list[str] | None = None) -> str:
        """Send one user turn to the harness. Return the stop reason (as Agent.run_turn)."""
        message = user_message(text, display, message_id, origin)
        if images:
            message["images"] = list(images)
        self.history.append(message)
        self.message_id = message["id"]
        self.turn_number += 1
        self.in_turn = True
        self._calls = {}
        self._cards = []
        self._text = []
        self._thinking = False
        self._cancelling = False
        self.streamed = []
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "last_prompt_tokens": 0}
        stop = "end"
        conn: AcpConnection | None = None
        prompt: asyncio.Future[Any] | None = None
        try:
            if self._conn is None:
                await self.emit({"type": "notice", "level": "info", "text": f"Starting {self.harness.name}."})
            conn, _ = await self._ensure_session()
            message["acp_session"] = self.acp_session
            message["acp_harness"] = self.harness.id
            if self.acp_model:
                message["acp_model"] = self.acp_model  # The model of this turn: a later load uses it again.
            await self._tag_turn(message)
            await self._sync_mode(conn)
            recap = self._recap() if self._needs_recap else None
            self._needs_recap = False
            blocks = self._prompt_blocks(text, images, recap)
            while True:
                prompt = conn.request_future("session/prompt", {"sessionId": self.acp_session, "prompt": blocks})
                result = await prompt
                prompt = None
                self._add_usage(usage, result)
                reason = result.get("stopReason") if isinstance(result, dict) else None
                stop = {"end_turn": "end", "max_tokens": "end", "max_turn_requests": "max_tool_calls",
                        "refusal": "error", "cancelled": "interrupted"}.get(str(reason), "end")
                if reason == "refusal":
                    await self.emit({"type": "error", "message": f"{self.harness.name} refused the request."})
                await self._finish_step()
                # A message that the user sent during the turn: send it as the next prompt of the same turn.
                if stop != "end" or not self.user_steer:
                    break
                taken = await self._take_user_steer()
                blocks = [{"type": "text", "text": str(m.get("content") or "")} for m in taken]
        except asyncio.CancelledError:
            task = asyncio.current_task()
            if task is not None and hasattr(task, "uncancel"):
                task.uncancel()
            stop = "interrupted"
            await self._cancel(conn, prompt)
        except AcpError as e:
            stop = "error"
            await self._finish_step()
            await self.emit({"type": "error", "message": str(e)})
        self.in_turn = False
        await self._return_user_steer()
        await self.emit({"type": "turn.end", "usage": self._usage(usage), "stop_reason": stop})
        return stop

    def _add_usage(self, usage: dict[str, int], result: Any) -> None:
        data = result.get("usage") if isinstance(result, dict) else None
        if not isinstance(data, dict):
            return
        prompt = int(data.get("inputTokens") or 0)
        usage["prompt_tokens"] += prompt
        usage["completion_tokens"] += int(data.get("outputTokens") or 0)
        usage["last_prompt_tokens"] = prompt

    async def _finish_step(self) -> None:
        """Keep the streamed text in the history, and end the tool calls that have no result."""
        for call in self._calls.values():
            if call.started and not call.ended:
                await self._end_call(call)
        await self._flush_cards()
        text = "".join(self._text)
        self._text.clear()
        self.streamed.clear()
        if text:
            self.history.append({"role": "assistant", "content": text})

    async def _cancel(self, conn: AcpConnection | None, prompt: asyncio.Future[Any] | None) -> None:
        """The user interrupted the turn: tell the harness, and give it a short time to stop."""
        self._cancelling = True
        if conn is not None and self.acp_session is not None and not conn.closed:
            try:
                await conn.notify("session/cancel", {"sessionId": self.acp_session})
            except AcpError:
                pass
            if prompt is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(prompt), CANCEL_WAIT)
                except (asyncio.TimeoutError, AcpError, asyncio.CancelledError):
                    pass
        for terminal in list(self.terminals.terminals.values()):
            await terminal.kill()
        for call in self._calls.values():
            if call.started and not call.ended:
                await self._end_call(call, INTERRUPTED, True)
        await self._flush_cards()
        text = "".join(self._text)
        self._text.clear()
        self.streamed.clear()
        if text:
            self.history.append({"role": "assistant", "content": text})

    async def run_compact(self) -> None:
        await self.emit({"type": "command.result", "name": "compact",
                         "text": f"{self.harness.name} manages its own context. Harness cannot compact it."})
        await self.emit({"type": "turn.end", "usage": self._usage({"prompt_tokens": 0, "completion_tokens": 0,
                                                                    "last_prompt_tokens": 0}),
                         "stop_reason": "end"})

    async def compact(self, reason: str) -> bool:
        return False

    def rewind(self, index: int) -> None:
        """The harness cannot go back, so the next prompt starts a new ACP session with a recap."""
        super().rewind(index)
        self.acp_session = None
        self._loaded = False
        self._usage_known = None

    def clear(self) -> None:
        super().clear()
        self.acp_session = None
        self._loaded = False

    def context_tokens(self) -> int:
        """The tokens of the last usage_update of the harness. 0: unknown (the client shows no ring)."""
        return self._usage_known[0] if self._usage_known else 0

    def turn_label(self) -> str:
        """The agent and the model of a turn, for the chat: "Claude Agent · Opus"."""
        model = self.acp_model or self.requested_model
        name = next((str(m.get("name") or m.get("id")) for m in self.acp_models if m.get("id") == model), model)
        return f"{self.harness.name} · {name}" if name else self.harness.name

    def context_breakdown(self) -> dict[str, Any]:
        tokens = self.context_tokens()
        return {"tokens": tokens, "length": self.context_length, "compact_at": 1.0, "source": "acp",
                "parts": [{"kind": "messages", "tokens": tokens}] if tokens else []}

    def public_harness(self) -> dict[str, Any]:
        """The harness of the session for the client: its models and its / commands, when it has them."""
        auto_extra = bool(self.acp_modes) and not any(MODE_MAP.get(m["id"]) == "auto" for m in self.acp_modes)
        started = bool(self.acp_models)
        models = self.acp_models if started else ([] if self.harness.custom else acp_harnesses.cached_models(self.harness.id))
        # Before the first prompt the harness does not run: the chip shows the model that the session will use.
        model = self.acp_model
        if not started and model is None:
            settings = load_settings(None)
            # A model of a Harness provider (Settings > Agents) has its id only after the start: no guess.
            by_provider = (not self.harness.custom and acp_models.choice(settings, self.harness.id) is not None
                           and not self.requested_model and not self._recorded_model())
            model = None if by_provider else self._expected_model(settings)
        return {"id": self.harness.id, "name": self.harness.name, "models": models,
                "model": model, "commands": self.acp_commands,
                # The mode menu: the modes of the harness, the current one, and "Auto (Harness)" for a harness
                # with no Auto mode of its own (the gate of Harness checks its requests with the auto model).
                "modes": self.acp_modes, "mode": self._chosen_mode, "harness_auto": auto_extra,
                "efforts": self.acp_efforts, "effort": self.acp_effort}


# -- the models of a harness before its first session (Settings > Agents, the picker of the start screen) --

PROBE_TIMEOUT = 90.0  # Seconds: an npx harness can download its package at the first start.


def _option_values(option: dict[str, Any]) -> list[dict[str, str]]:
    """The values of a select config option: id, name, description (also in groups)."""
    values: list[dict[str, str]] = []
    for item in option.get("options") or []:
        group = item.get("options") if isinstance(item, dict) and isinstance(item.get("options"), list) else [item]
        for value in group:
            if isinstance(value, dict) and value.get("value") is not None:
                values.append({"id": str(value["value"]), "name": str(value.get("name") or value["value"]),
                               "description": str(value.get("description") or "")})
    return values


def parse_efforts(result: Any) -> list[dict[str, str]]:
    """The reasoning levels of session/new: a configOptions entry of the category "thought_level"."""
    if not isinstance(result, dict):
        return []
    for option in result.get("configOptions") or []:
        if isinstance(option, dict) and option.get("category") == "thought_level" and option.get("type") == "select":
            return _option_values(option)
    return []


def parse_models(result: Any) -> list[dict[str, Any]]:
    """The models of session/new: a configOptions entry of the category "model", else "models"."""
    if not isinstance(result, dict):
        return []
    for option in result.get("configOptions") or []:
        if not isinstance(option, dict) or option.get("category") != "model" or option.get("type") != "select":
            continue
        values: list[dict[str, Any]] = []
        for item in option.get("options") or []:
            group = item.get("options") if isinstance(item, dict) and isinstance(item.get("options"), list) else [item]
            for value in group:
                if isinstance(value, dict) and value.get("value") is not None:
                    values.append({"id": str(value["value"]), "name": str(value.get("name") or value["value"]),
                                   "description": str(value.get("description") or "")})
        if values:
            return mark_current(values, option.get("currentValue"))
    models = result.get("models")
    if isinstance(models, dict) and isinstance(models.get("availableModels"), list):
        found = [{"id": str(m.get("modelId")), "name": str(m.get("name") or m.get("modelId")),
                  "description": str(m.get("description") or "")}
                 for m in models["availableModels"] if isinstance(m, dict) and m.get("modelId")]
        return mark_current(found, models.get("currentModelId"))
    return []


def mark_current(models: list[dict[str, Any]], current: Any) -> list[dict[str, Any]]:
    """The models, with ``current`` true on the model that the harness uses now (T3 Code: ``isDefault``)."""
    return [{**m, "current": True} if current is not None and m["id"] == str(current) else m for m in models]


async def probe_models(spec: HarnessSpec, cwd: Path) -> list[dict[str, str]]:
    """Start the harness, open an ACP session with no prompt, and read its models. The harness stops after it.
    The session uses no tokens. The models go to the cache of the picker (acp_harnesses.save_models)."""
    try:
        argv, env = launch_argv(spec)
    except HarnessError as e:
        raise AcpError(str(e)) from None
    cwd.mkdir(parents=True, exist_ok=True)

    async def no_notification(method: str, params: dict[str, Any]) -> None:
        return None

    async def no_request(method: str, params: dict[str, Any]) -> Any:
        raise AcpError(f"Harness does not answer {method} during a model check.")

    conn = AcpConnection(argv, env, cwd, spec.name, no_notification, no_request)
    await conn.start()
    try:
        await conn.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
            "clientInfo": {"name": "harness", "title": "Harness", "version": __version__},
        }, timeout=PROBE_TIMEOUT)
        try:
            result = await conn.request("session/new", {"cwd": str(cwd), "mcpServers": []}, timeout=PROBE_TIMEOUT)
        except AcpError as e:
            if getattr(e, "code", None) == AUTH_REQUIRED or "auth" in str(e).lower():
                raise AcpError(f"{spec.name} needs a sign-in before it can list its models.") from None
            raise
    finally:
        await conn.close()
    models = parse_models(result)
    if models and not spec.custom:
        await asyncio.to_thread(acp_harnesses.save_models, spec.id, models)
    efforts = parse_efforts(result)
    if efforts and not spec.custom:
        await asyncio.to_thread(acp_harnesses.save_efforts, spec.id, efforts)
    return models



# -- the handoff recap (a switch of the agent) ----------------------------------------------------------------------


def _handoff_text(content: Any) -> str:
    if isinstance(content, list):
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return str(content or "").strip()


def _clip(text: str, limit: int = HANDOFF_ITEM_CHARS) -> str:
    return text if len(text) <= limit else text[:limit] + f" […{len(text) - limit} more characters]"


def alias_target(models: list[dict[str, Any]], alias: dict[str, Any]) -> str | None:
    """The real model of a default alias: the model whose name the alias names ("Default (recommended)" with the
    description "Opus 4.7 · ..." gives "opus"), else the first real model, as T3 Code does. None: no real model."""
    real = [m for m in models if not acp_harnesses.is_default_alias(m)]
    if not real:
        return None
    text = f"{alias.get('name', '')} {alias.get('description', '')}".lower()
    for m in sorted(real, key=lambda m: -len(str(m.get("name") or ""))):
        for word in {str(m.get("name") or "").lower(), str(m.get("id") or "").lower()}:
            if len(word) >= 3 and re.search(rf"(?<![a-z0-9]){re.escape(word)}(?![a-z0-9])", text):
                return str(m["id"])
    return str(real[0]["id"])


def handoff_items(history: list[dict[str, Any]]) -> list[str]:
    """The items of a handoff, in order: the messages of the user and of the agent, and the activity (a tool call
    with the first lines of its result), each with its speaker."""
    calls: dict[str, str] = {}
    items: list[str] = []
    for m in history:
        role = m.get("role")
        if m.get("origin") == "harness":
            continue
        if role == "user":
            text = _handoff_text(m.get("display") or m.get("content"))
            if text:
                items.append("User: " + _clip(text))
        elif role == "assistant":
            text = _handoff_text(m.get("content"))
            if text:
                items.append("Agent: " + _clip(text))
            for call in m.get("tool_calls") or []:
                fn = call.get("function") if isinstance(call, dict) else None
                if isinstance(fn, dict):
                    args = str(fn.get("arguments") or "")
                    calls[str(call.get("id"))] = f"{fn.get('name')} {args[:300]}".strip()
        elif role == "tool":
            what = calls.get(str(m.get("tool_call_id")), "a tool")
            result = _handoff_text(m.get("content"))
            first = "\n".join(result.splitlines()[:8])
            items.append(f"Activity: {what}\n  Result: {_clip(first, 1_500)}")
    return items


def handoff_recap(history: list[dict[str, Any]], summary: str | None, previous: str | None,
                  budget: int = HANDOFF_CHARS, delta: bool = False) -> str | None:
    """The handoff text for a new agent of a session. None: no earlier conversation.

    ``delta``: the agent comes back to its own earlier session (T3 Code "delta since the target last saw it"). The
    history is only the part after its last turn, which other agents ran."""
    items = handoff_items(history)
    if summary:
        items.insert(0, "Summary of the earliest part: " + _clip(summary, 8_000))
    if not items:
        return None
    total = sum(len(i) + 2 for i in items)
    if total <= budget:
        chosen, left_out = items, 0
    else:
        first = next((i for i in items if i.startswith("User: ")), items[0])
        room = budget - len(first) - 2
        tail: list[str] = []
        for item in reversed(items):
            if item is first:
                break
            if len(item) + 2 > room:
                break
            tail.insert(0, item)
            room -= len(item) + 2
        chosen = [first, *tail]
        left_out = len(items) - len(chosen)
    if delta:
        head = ("[Harness: After your last turn in this conversation, " + (previous or "another agent")
                + " continued it. You do not have that part, so here it is, with the speaker of each part. It is a "
                "selection, not a summary. Use it as background. The tool calls ran in the other agent: check the "
                "files again before you change them.]")
    else:
        head = ("[Harness: You continue a conversation that " + (f"{previous} had" if previous else "another agent had")
                + ". You do not have its context, so here is the earlier conversation, with the speaker of each part. "
                "It is a selection, not a summary. Use it as background. The tool calls ran in the earlier agent: "
                "check the files again before you change them.]")
    if left_out:
        head += (f"\n[{left_out} earlier parts are left out. To find one, use the conversation_search tool of the "
                 "Harness MCP server.]")
    return head + "\n\n" + "\n\n".join(chosen)
