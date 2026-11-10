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

from . import __version__, acp_mcp, acp_models
from .acp_harnesses import HarnessError, HarnessSpec, launch_argv
from .acp_terminal import TerminalError, TerminalHost
from .agent import INTERRUPTED, Agent, user_message
from .config import load_settings
from .created import before_call, created_files
from .files import file_hash, relpath
from .permissions import PLAN_BLOCK
from .providers import ModelClient, Provider
from .tools import ToolResult, truncate

log = logging.getLogger("harness.acp")

PROTOCOL_VERSION = 1
PROVIDER_NAME = "acp"  # The provider name of an ACP session in storage. The model is the harness id.
START_TIMEOUT = 180.0  # npx can download the package at the first start.
REQUEST_TIMEOUT = 60.0  # session/new, session/load, session/set_mode.
CANCEL_WAIT = 5.0  # The time that the harness gets to end the prompt after session/cancel.
LINE_LIMIT = 64 * 1024 * 1024  # The longest JSON line. A file read can be large.
STDERR_LINES = 30
RECAP_MESSAGES = 24
RECAP_CHARS = 12_000
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


class AcpAgent(Agent):
    """An agent whose loop runs in another harness, through ACP."""

    def __init__(self, *, harness: HarnessSpec, aux_client: ModelClient | None = None, **kwargs: Any):
        super().__init__(**kwargs)
        self.harness = harness
        # A model of the Harness providers for the titles and the prompt suggestions. None: no such model.
        self.aux_client = aux_client
        self.model_checks_pending = False
        self.model_warnings: list[str] = []
        self._conn: AcpConnection | None = None
        self._start_lock = asyncio.Lock()
        self._session_lock = asyncio.Lock()
        self._agent_caps: dict[str, Any] = {}
        self._auth_methods: list[dict[str, Any]] = []
        self.acp_session: str | None = self._stored_session()
        self._loaded = False  # True: the harness has the context of acp_session.
        self._modes: list[str] = []
        self._mode: str | None = None
        # The state of the current turn.
        self._calls: dict[str, _Call] = {}
        self._text: list[str] = []
        self._thinking = False
        self._replaying = False  # session/load replays the old conversation: the client does not get it.
        self._cancelling = False
        self._needs_recap = False  # A new ACP session for a session with history: the next prompt has a recap.
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
        self._usage_known: tuple[int, int] | None = None  # usage_update: (used tokens, context size).
        self._provider_model: str | None = None  # The model id of a Harness provider in the harness (acp_models.py).

    # -- the harness process -------------------------------------------------------------------------------

    def _stored_session(self) -> str | None:
        """The ACP session id of the last turn, from the history (a stored session that opens again)."""
        for m in reversed(self.history):
            sid = m.get("acp_session")
            if isinstance(sid, str) and sid:
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
                await self._send_state()
                return conn, False
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
        self._read_session(result)
        # The conversation before this ACP session: in a turn, the last message is the prompt of the turn.
        prior = self.history[:-1] if self.in_turn else self.history
        self._needs_recap = any(m.get("role") in ("user", "assistant") for m in prior)
        await self._select_provider_model(conn)
        await self._send_state()
        return conn, self._needs_recap

    async def _provider_model_options(self, argv: list[str], env: dict[str, str]) -> tuple[list[str], dict[str, str]]:
        """The command and the environment with the model of a Harness provider, when the user chose one in
        Settings > Operating Harness (only the user settings: a project cannot change it)."""
        self._provider_model = None
        spec = None if self.harness.custom else acp_models.choice(load_settings(None), self.harness.id)
        if spec is None:
            return argv, env
        try:
            target = await acp_models.resolve(spec)
        except acp_models.ModelChoiceError as e:
            raise AcpError(f"{e} Change the model of {self.harness.name} in Settings > Operating Harness.") from None
        extra_args, extra_env = acp_models.launch_options(self.harness.id, target)
        self._provider_model = acp_models.session_model_id(self.harness.id, target)
        return [*argv, *extra_args], {**env, **extra_env}

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
        """A configOptions entry of the category "model" is the model menu (it replaces "models")."""
        for option in options:
            if not isinstance(option, dict) or option.get("category") != "model" or option.get("type") != "select":
                continue
            values: list[dict[str, str]] = []
            for item in option.get("options") or []:
                group = item.get("options") if isinstance(item, dict) and isinstance(item.get("options"), list) else [item]
                for value in group:
                    if isinstance(value, dict) and value.get("value") is not None:
                        values.append({"id": str(value["value"]), "name": str(value.get("name") or value["value"]),
                                       "description": str(value.get("description") or "")})
            if values:
                self.acp_models = values
                self.acp_model = str(option.get("currentValue")) if option.get("currentValue") is not None else None
                self._model_option = str(option.get("id"))
            return

    async def _send_state(self) -> None:
        await self.emit({"type": "acp.state", "harness": self.public_harness()})

    async def set_model(self, model_id: str) -> None:
        """Change the model of the ACP session (the model menu)."""
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
            self._modes = [str(m.get("id")) for m in available if isinstance(m, dict) and m.get("id")] \
                if isinstance(available, list) else []
            self._mode = modes.get("currentModeId") if isinstance(modes.get("currentModeId"), str) else None

    async def _sync_mode(self, conn: AcpConnection) -> None:
        """Use the ACP mode of the Harness permission mode, when the harness has a mode with that id."""
        wanted = self._mode_setting()
        if not self._modes or wanted not in self._modes or wanted == self._mode:
            return
        try:
            await conn.request("session/set_mode", {"sessionId": self.acp_session, "modeId": wanted})
            self._mode = wanted
        except AcpError as e:
            log.info("%s did not change the mode to %s: %s", self.harness.name, wanted, e)

    def _mode_setting(self) -> str:
        return str(self.settings.get("permission_mode") or "default")

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
            if call.status in ("in_progress", "completed", "failed") or call.raw_input:
                await self._start_call(call)
            if call.status in ("completed", "failed"):
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
        if kind == "current_mode_update":
            if isinstance(update.get("currentModeId"), str):
                self._mode = update["currentModeId"]
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
        await self._start_call(call)
        name, args = self._view(call)
        mode = self._mode_setting()
        if mode == "bypassPermissions":
            return selected(pick("allow_once", "allow_always"))
        if mode == "acceptEdits" and call.kind == "edit":
            return selected(pick("allow_once", "allow_always"))
        if mode == "plan" and call.kind in ("edit", "delete", "move"):
            return selected(pick("reject_once", "reject_always"))
        always = pick("allow_always")
        request: dict[str, Any] = {
            "request_id": uuid.uuid4().hex,
            "tool": name,
            "input": args,
            "diff": self._diff(call) or None,
            # "Always allow" needs a rule in the client. The harness keeps the choice, not the project settings.
            "rule": f"{self.harness.name}: {call.title or name}" if always is not None else None,
            "remember": self.harness.name if always is not None else None,
        }
        decision = await self.gate.approver(request)
        if self._cancelling:
            return {"outcome": {"outcome": "cancelled"}}
        if decision == "allow_always":
            return selected(always or pick("allow_once"))
        if decision == "allow_once":
            return selected(pick("allow_once", "allow_always"))
        return selected(pick("reject_once", "reject_always"))

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
        terminal = self.terminals.create(params)
        return {"terminalId": terminal.id}

    async def run_harness_tool(self, name: str, args: dict[str, Any]) -> ToolResult:
        """A call of the Harness MCP server (acp_mcp.py). The permissions and the hooks of Harness apply."""
        call_id = f"harness_{uuid.uuid4().hex[:12]}"
        snapshot = await asyncio.to_thread(before_call, self.cwd, name, args)
        result = await self._execute(name, args, None, call_id)
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
        """The earlier conversation, for a new ACP session of a session with history."""
        lines: list[str] = []
        for m in self.history[:-1][-RECAP_MESSAGES:]:
            role = m.get("role")
            if role not in ("user", "assistant") or m.get("origin") == "harness":
                continue
            content = m.get("display") or m.get("content")
            if isinstance(content, list):
                content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
            text = str(content or "").strip()
            if text:
                lines.append(f"{'User' if role == 'user' else 'Agent'}: {text}")
        if self.summary:
            lines.insert(0, f"Summary of the earliest part: {self.summary}")
        if not lines:
            return None
        body = "\n\n".join(lines)
        if len(body) > RECAP_CHARS:
            body = "…" + body[-RECAP_CHARS:]
        return ("[Harness: This conversation continues an earlier session. You do not have its context, so here "
                "are the last messages. Use them as background only.]\n\n" + body)

    def _prompt_blocks(self, text: str, images: list[str] | None, recap: str | None) -> list[dict[str, Any]]:
        blocks: list[dict[str, Any]] = []
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

    def context_breakdown(self) -> dict[str, Any]:
        tokens = self.context_tokens()
        return {"tokens": tokens, "length": self.context_length, "compact_at": 1.0, "source": "acp",
                "parts": [{"kind": "messages", "tokens": tokens}] if tokens else []}

    def public_harness(self) -> dict[str, Any]:
        """The harness of the session for the client: its models and its / commands, when it has them."""
        return {"id": self.harness.id, "name": self.harness.name, "models": self.acp_models,
                "model": self.acp_model, "commands": self.acp_commands}
