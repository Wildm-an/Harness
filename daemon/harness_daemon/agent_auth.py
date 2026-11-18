"""The sign-in state, the sign-in, and the subscription usage of the agents (Settings > Agents).

Claude Agent (``claude-acp``) and Codex (``codex-acp``) have them, as in T3 Code. Each ACP adapter uses the
login of its CLI on the daemon computer, so Harness reads that login with the CLI.

Claude Agent, with the ``claude`` program:

- The state: ``claude auth status --json`` (about 0.5 s). It needs no network.
- The usage of a subscription: ``claude -p --input-format stream-json --output-format stream-json`` with
  the control requests ``initialize`` and ``get_usage`` (the requests of the Claude Agent SDK). Harness
  sends no prompt, so the check uses no tokens. It takes some seconds, so the daemon keeps the result
  for ``USAGE_TTL`` seconds.
- The sign-in: ``claude auth login`` in a pseudo terminal. The client shows it in a small terminal on the
  Agents page, because the login can ask for a code from the browser.

Codex, with the Codex CLI of ``codex_limits.codex_argv`` (the ``codex`` program, else npx):

- The state: ``codex login status``. It writes "Logged in using ChatGPT", "Logged in using an API key", or
  "Not logged in" (exit code 1) to stderr.
- The usage of a ChatGPT plan: the limits of ``codex_limits.py`` (the Limits tab of the Usage page).
- The sign-in: ``codex login`` in a pseudo terminal. Codex opens a sign-in page in the browser and waits for
  it on a local port. The login goes to ``<CODEX_HOME or ~/.codex>/auth.json``, and codex-acp reads it there.

Harness never reads the credentials of the agents itself. ``CLAUDE_CONFIG_DIR`` and ``CODEX_HOME`` of the
daemon apply.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from . import codex_limits
from .terminal import Terminal, _Pty

log = logging.getLogger("harness.agent_auth")

CLAUDE_ID = "claude-acp"
CODEX_ID = "codex-acp"
SUPPORTED = (CLAUDE_ID, CODEX_ID)
STATUS_TTL = 60.0  # Seconds.
USAGE_TTL = 120.0
STATUS_TIMEOUT = 20.0
USAGE_TIMEOUT = 40.0
INSTALL_URL = "https://code.claude.com/docs/en/setup"
CODEX_STATUS_TIMEOUT = 120.0  # The first npx start downloads the CLI.
CODEX_INSTALL_URL = "https://nodejs.org/"
SIGNIN_HELP = {
    CLAUDE_ID: "Claude Code opens a sign-in page in your browser. If it asks for a code, paste it here.",
    CODEX_ID: "Codex opens a sign-in page in your browser. Sign in with your ChatGPT account there.",
}

Emit = Callable[[dict[str, Any]], Awaitable[None]]


def supports(harness_id: str) -> bool:
    return harness_id in SUPPORTED


def claude_binary() -> str | None:
    """The ``claude`` program: on the PATH, else in the folder of the native installer."""
    found = shutil.which("claude")
    if found:
        return found
    home = Path.home()
    for path in (home / ".local" / "bin" / ("claude.exe" if os.name == "nt" else "claude"),
                 home / ".claude" / "local" / ("claude.exe" if os.name == "nt" else "claude")):
        if path.is_file():
            return str(path)
    return None


def _no_window() -> dict[str, Any]:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}  # type: ignore[attr-defined]


_PROVIDERS = {"bedrock": "Amazon Bedrock", "vertex": "Google Vertex AI", "foundry": "Microsoft Foundry"}


def auth_label(data: dict[str, Any]) -> str:
    """The kind of sign-in, for example "Claude Max" or "API key"."""
    provider = str(data.get("apiProvider") or "firstParty")
    if provider != "firstParty":
        return _PROVIDERS.get(provider.lower(), provider)
    method = str(data.get("authMethod") or "").lower()
    plan = str(data.get("subscriptionType") or "").strip()
    if method in ("claude.ai", "oauth") or plan:
        return f"Claude {plan.capitalize()}" if plan else "Claude account"
    if "key" in method or method == "console":
        return "API key"
    return method or "Signed in"


def parse_status(data: Any) -> dict[str, Any]:
    """The state for the client from the JSON of ``claude auth status``."""
    if not isinstance(data, dict):
        return {"status": "unknown", "label": "", "detail": "Claude Code gave no sign-in state."}
    if data.get("loggedIn") is True:
        return {"status": "authenticated", "label": auth_label(data), "detail": "",
                "subscription": bool(data.get("subscriptionType"))}
    return {"status": "unauthenticated", "label": "", "subscription": False,
            "detail": "Claude Code is not signed in. Sign in to use Claude Agent."}


def read_status(binary: str | None) -> dict[str, Any]:
    """Run ``claude auth status``. It blocks: call it in a thread."""
    if binary is None:
        return {"status": "unknown", "label": "", "subscription": False, "install_url": INSTALL_URL,
                "detail": "Install Claude Code to see the sign-in state and to sign in. Claude Agent uses its login."}
    try:
        done = subprocess.run([binary, "auth", "status", "--json"], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=STATUS_TIMEOUT, **_no_window())
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"status": "unknown", "label": "", "subscription": False,
                "detail": f"Could not read the sign-in state of Claude Code: {e}"}
    try:
        return parse_status(json.loads(done.stdout))
    except ValueError:
        text = (done.stderr or done.stdout).strip().splitlines()
        return {"status": "unknown", "label": "", "subscription": False,
                "detail": f"Could not read the sign-in state of Claude Code: {text[-1] if text else 'no output'}"}


def parse_codex_status(code: int, text: str) -> dict[str, Any]:
    """The state for the client from the output and the exit code of ``codex login status``."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    found = next((line for line in lines if line.lower().startswith(("logged in", "not logged in"))), "")
    lower = found.lower()
    if lower.startswith("logged in"):
        if "chatgpt" in lower:
            return {"status": "authenticated", "label": "ChatGPT", "detail": "", "subscription": True}
        label = "API key" if "api key" in lower else "Access token" if "access token" in lower else "Signed in"
        return {"status": "authenticated", "label": label, "detail": "", "subscription": False}
    if lower.startswith("not logged in") or (code == 1 and not found):
        return {"status": "unauthenticated", "label": "", "subscription": False,
                "detail": "Codex is not signed in. Sign in to use Codex."}
    return {"status": "unknown", "label": "", "subscription": False,
            "detail": f"Could not read the sign-in state of Codex: {lines[-1] if lines else 'no output'}"}


def read_codex_status(argv: list[str] | None) -> dict[str, Any]:
    """Run ``codex login status``. It blocks: call it in a thread."""
    if argv is None:
        return {"status": "unknown", "label": "", "subscription": False, "install_url": CODEX_INSTALL_URL,
                "detail": "Install Node.js (it has npx) or the Codex CLI to see the sign-in state and to sign in. "
                          "Codex uses its login."}
    try:
        done = subprocess.run([*argv, "login", "status"], cwd=str(Path.home()), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=CODEX_STATUS_TIMEOUT,
                              stdin=subprocess.DEVNULL, **_no_window())
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"status": "unknown", "label": "", "subscription": False,
                "detail": f"Could not read the sign-in state of Codex: {e}"}
    return parse_codex_status(done.returncode, f"{done.stderr}\n{done.stdout}")


async def _claude_status() -> dict[str, Any]:
    return await asyncio.to_thread(read_status, claude_binary())


async def _claude_usage(force: bool) -> list[dict[str, Any]]:
    binary = claude_binary()
    if binary is None:
        raise RuntimeError("Claude Code is not installed.")
    return await asyncio.to_thread(read_usage, binary)


async def _codex_status() -> dict[str, Any]:
    return await asyncio.to_thread(read_codex_status, codex_limits.codex_argv())


async def _codex_usage(force: bool) -> list[dict[str, Any]]:
    result = await codex_limits.limits(force=force)
    return list(result["windows"]) if result else []


# The readers of each agent: the sign-in state, and the usage of a subscription.
_READERS: dict[str, tuple[Callable[[], Awaitable[dict[str, Any]]],
                          Callable[[bool], Awaitable[list[dict[str, Any]]]]]] = {
    CLAUDE_ID: (_claude_status, _claude_usage),
    CODEX_ID: (_codex_status, _codex_usage),
}


def signin_argv(harness_id: str) -> list[str]:
    """The sign-in command of an agent, with the full path of the program. Raises RuntimeError when the program
    is not on this computer."""
    if harness_id == CODEX_ID:
        argv = codex_limits.codex_argv()
        if argv is None:
            raise RuntimeError("Install Node.js (it has npx) or the Codex CLI first.")
        return [*argv, "login"]
    binary = claude_binary()
    if binary is None:
        raise RuntimeError(f"Install Claude Code first: {INSTALL_URL}")
    return [binary, "auth", "login"]


_GROUP_LABEL = {"session": "5-hour limit", "weekly": "Weekly"}  # The names of Claude Code /usage.


def parse_usage(response: Any) -> list[dict[str, Any]]:
    """The usage limits from the ``get_usage`` response: label, percent, the reset time, and severity."""
    if not isinstance(response, dict) or response.get("rate_limits_available") is False:
        return []
    limits = response.get("rate_limits")
    if not isinstance(limits, dict):
        return []
    out: list[dict[str, Any]] = []
    listed = limits.get("limits")
    if isinstance(listed, list) and listed:
        for item in listed:
            if not isinstance(item, dict) or not isinstance(item.get("percent"), (int, float)):
                continue
            label = _GROUP_LABEL.get(str(item.get("group")), str(item.get("group") or item.get("kind") or "Limit").capitalize())
            scope = item.get("scope") if isinstance(item.get("scope"), dict) else {}
            model = scope.get("model") if isinstance(scope.get("model"), dict) else {}
            name = model.get("display_name") or model.get("id")
            if name:
                label = f"{label} · {name}"
            out.append({"label": label, "percent": max(0.0, min(100.0, float(item["percent"]))),
                        "resets_at": item.get("resets_at") if isinstance(item.get("resets_at"), str) else None,
                        "severity": str(item.get("severity") or "normal")})
        return out
    for key, label in (("five_hour", "5-hour limit"), ("seven_day", "Weekly")):
        window = limits.get(key)
        if isinstance(window, dict) and isinstance(window.get("utilization"), (int, float)):
            out.append({"label": label, "percent": max(0.0, min(100.0, float(window["utilization"]))),
                        "resets_at": window.get("resets_at") if isinstance(window.get("resets_at"), str) else None,
                        "severity": "normal"})
    return out


def read_usage(binary: str) -> list[dict[str, Any]]:
    """Ask Claude Code for the usage of the subscription. It blocks: call it in a thread. It sends no prompt."""
    # No MCP servers and no settings files: the check starts no servers and runs no hooks of the user.
    proc = subprocess.Popen([binary, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                             "--strict-mcp-config", "--setting-sources", ""],
                            cwd=str(Path.home()), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace", **_no_window())
    assert proc.stdin is not None and proc.stdout is not None
    try:
        for request_id, subtype in (("harness-init", "initialize"), ("harness-usage", "get_usage")):
            proc.stdin.write(json.dumps({"type": "control_request", "request_id": request_id,
                                         "request": {"subtype": subtype}}) + "\n")
        proc.stdin.flush()
        deadline = time.monotonic() + USAGE_TIMEOUT
        for line in proc.stdout:
            if time.monotonic() > deadline:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            reply = msg.get("response") if isinstance(msg, dict) and msg.get("type") == "control_response" else None
            if isinstance(reply, dict) and reply.get("request_id") == "harness-usage":
                if reply.get("subtype") != "success":
                    raise RuntimeError(str(reply.get("error") or "Claude Code did not give the usage."))
                return parse_usage(reply.get("response"))
        raise RuntimeError("Claude Code did not give the usage.")
    finally:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


class AgentStates:
    """The sign-in state and the usage of each agent that has them, with a short cache."""

    def __init__(self) -> None:
        self._status: dict[str, tuple[float, dict[str, Any]]] = {}
        self._usage: dict[str, tuple[float, list[dict[str, Any]] | None, str]] = {}
        self._lock = asyncio.Lock()

    def cached(self, harness_id: str) -> dict[str, Any] | None:
        """The last state with its usage, or None when no check ran yet."""
        status = self._status.get(harness_id)
        if status is None:
            return None
        usage = self._usage.get(harness_id)
        return {**status[1], "usage": usage[1] if usage else None, "usage_error": usage[2] if usage else "",
                "checked_at": status[0], "signin_help": SIGNIN_HELP.get(harness_id, "")}

    def fresh(self, harness_id: str) -> bool:
        status = self._status.get(harness_id)
        return status is not None and time.time() - status[0] < STATUS_TTL

    def usage_fresh(self, harness_id: str) -> bool:
        """The state and the usage are newer than their TTL: a check would not run again."""
        usage = self._usage.get(harness_id)
        return self.fresh(harness_id) and (usage is None or time.time() - usage[0] < USAGE_TTL)

    def invalidate(self, harness_id: str | None = None) -> None:
        for store in (self._status, self._usage):
            if harness_id is None:
                store.clear()
            else:
                store.pop(harness_id, None)

    async def check(self, harness_id: str, force: bool = False) -> dict[str, Any] | None:
        """Read the state (and the usage of a subscription) again when the cache is old or ``force``."""
        if not supports(harness_id):
            return None
        read_state, read_plan_usage = _READERS[harness_id]
        async with self._lock:
            if force or not self.fresh(harness_id):
                status = await read_state()
                self._status[harness_id] = (time.time(), status)
            status = self._status[harness_id][1]
            usage = self._usage.get(harness_id)
            wants_usage = status.get("status") == "authenticated" and status.get("subscription")
            if not wants_usage:
                self._usage.pop(harness_id, None)
            elif force or usage is None or time.time() - usage[0] >= USAGE_TTL:
                try:
                    values = await read_plan_usage(force)
                    self._usage[harness_id] = (time.time(), values, "")
                except Exception as e:  # noqa: BLE001 - the usage is extra information.
                    log.info("The usage of %s is not available: %s", harness_id, e)
                    self._usage[harness_id] = (time.time(), None, f"The usage is not available: {e}")
        return self.cached(harness_id)


STATES = AgentStates()


def limits_view(harness_id: str, state: dict[str, Any] | None, checking: bool = False) -> dict[str, Any] | None:
    """The subscription limits of a session for the context panel and the session rail, or None when the
    agent has no subscription. ``checking``: a check runs now, and the client gets a new reply after it."""
    if state is None:
        return {"agent": harness_id, "label": "", "windows": [], "error": "", "checking": True} if checking else None
    if state.get("status") != "authenticated" or not state.get("subscription"):
        return None
    return {"agent": harness_id, "label": str(state.get("label") or "Subscription"),
            "windows": state.get("usage") or [], "error": state.get("usage_error") or "", "checking": checking}


class SignIn:
    """The sign-in command of an agent (``signin_argv``) in a pseudo terminal. The client gets ``agents.signin.output`` and
    ``agents.signin.exit`` with the id of the agent. One sign-in runs at a time. With ``argv``, the terminal runs
    that command: the update of an agent program (agent_updates.py, ``kind`` "update")."""

    def __init__(self, harness_id: str, emit: Emit, on_exit: Callable[[SignIn, int | None], None],
                 argv: list[str] | None = None, kind: str = "signin"):
        self.harness_id = harness_id
        self.argv = argv
        self.kind = kind
        self._emit = emit
        self._on_exit = on_exit
        self.terminal: Terminal | None = None
        self.code: int | None = None

    def start(self, cols: int, rows: int) -> None:
        argv = self.argv if self.argv is not None else signin_argv(self.harness_id)
        pty = _Pty(argv, Path.home(), cols, rows)
        self.terminal = Terminal(pty, self._forward, asyncio.get_running_loop(), self._stopped)

    async def _forward(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "term.output":
            await self._emit({"type": "agents.signin.output", "id": self.harness_id, "kind": self.kind,
                              "data": event["data"]})
        elif kind == "term.exit":
            self.code = event.get("code")
            try:
                await self._emit({"type": "agents.signin.exit", "id": self.harness_id, "kind": self.kind,
                                  "code": self.code})
            finally:
                self._on_exit(self, self.code)

    def _stopped(self, terminal: Terminal) -> None:
        """The exit event (``_forward``) does the work: it has the exit code."""

    @property
    def alive(self) -> bool:
        return self.terminal is not None and self.terminal.alive

    def write(self, data: str) -> None:
        if self.terminal is not None:
            self.terminal.write(data)

    def resize(self, cols: int, rows: int) -> None:
        if self.terminal is not None:
            self.terminal.resize(cols, rows)

    def cancel(self) -> None:
        if self.terminal is not None:
            self.terminal.kill()
