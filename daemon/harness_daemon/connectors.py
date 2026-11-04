"""Connectors: MCP servers that the Connectors tab of the Capabilities page sets up in one step.

A connector is an MCP server entry in the user file ``~/.harness/mcp.json`` with a ``connector``
key, and a record in ``~/.harness/mcp-auth.json`` (the store of mcp_auth.py, which only the user can
read). ``mcp.json`` never has a token. There are two kinds.

``token`` (GitHub): a remote HTTP server and a bearer token::

    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "connector": "github" }

The MCP client asks ``token()`` for the token at each connection, and sends it as
``Authorization: Bearer <token>``. GitHub has two token sources:

- ``gh``: the token of the GitHub CLI (``gh auth token``) on the daemon computer. The daemon reads
  it again at each connection, so a new ``gh auth login`` takes effect at the next restart.
- ``token``: a personal access token that the user pastes.

GitHub has no dynamic client registration, so the OAuth flow of mcp_auth.py does not work for it
without a registered OAuth app. The ``oauth`` key in ``mcp.json`` is for that case.

``device`` (Microsoft Outlook): a local stdio server from npm that signs in by itself::

    "outlook": { "command": "npx", "args": ["-y", "@softeria/ms-365-mcp-server@0.179.1", "--preset", "outlook"],
                 "env": { "MS365_MCP_TENANT_ID": "consumers" }, "connector": "outlook" }

``connect`` runs the server with ``--login``. The server prints a Microsoft device code, and the
client shows it. The user enters the code at microsoft.com/devicelogin. The server keeps and
refreshes its own tokens (in its own encrypted cache on the daemon computer), so the record keeps
only the options and the account name. ``disconnect`` runs ``--logout``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from . import mcp_auth
from .config import ConfigError, harness_home, read_json, write_json

GH_TIMEOUT = 10
LOGIN_TIMEOUT = 900  # Seconds. A Microsoft device code expires after 15 minutes.
LOGOUT_TIMEOUT = 120  # The first npx run can download the package.
SOURCES = ("gh", "token", "device")
ACCOUNTS = ("personal", "work")

OnCode = Callable[[str, str], Awaitable[None]]  # (url, code)


class ConnectorError(Exception):
    """A connector could not connect. The text is for the user."""


@dataclass(frozen=True)
class Connector:
    id: str
    name: str
    description: str
    kind: str = "token"  # "token" or "device"
    # The kind "token":
    url: str = ""  # The MCP server.
    user_api: str = ""  # An API that returns the account of the token, to check the token.
    token_url: str = ""  # The page where the user makes a token.
    token_help: str = ""
    # The kind "device":
    package: str = ""  # The npm package of the stdio server, with an exact version.
    args: tuple[str, ...] = field(default_factory=tuple)  # The arguments after the package.
    home_url: str = ""  # The page of the server, for the user.


GITHUB = Connector(
    id="github",
    name="GitHub",
    description="Repositories, issues, pull requests, code search, and Actions, through the GitHub MCP server.",
    url="https://api.githubcopilot.com/mcp/",
    user_api="https://api.github.com/user",
    token_url="https://github.com/settings/personal-access-tokens/new",
    token_help="A fine-grained or classic personal access token. Give it access to the repositories "
               "and the permissions that the agent needs.",
)

OUTLOOK = Connector(
    id="outlook",
    name="Microsoft Outlook",
    description="Mail, calendar, and contacts of a Microsoft account, through the ms-365-mcp-server "
                "of Softeria (MIT).",
    kind="device",
    package="@softeria/ms-365-mcp-server@0.179.1",
    args=("--preset", "outlook"),
    home_url="https://github.com/Softeria/ms-365-mcp-server",
)

CONNECTORS: dict[str, Connector] = {GITHUB.id: GITHUB, OUTLOOK.id: OUTLOOK}

# The commands. Tests replace them.
GH: list[str] | None = None
NPX: list[str] | None = None  # The command that runs a device server, instead of "npx -y <package>".

_LOGINS: dict[str, asyncio.subprocess.Process] = {}  # The --login processes that wait for the user.
_CANCELLED: set[str] = set()  # The sign-ins that the user cancelled.


def get(connector_id: str) -> Connector:
    connector = CONNECTORS.get(connector_id)
    if connector is None:
        raise ConfigError(f"Unknown connector: {connector_id}")
    return connector


def record_key(connector_id: str) -> str:
    return f"connector {connector_id}"


def _no_window() -> dict[str, Any]:
    if sys.platform == "win32":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    return {}


def _own_group() -> dict[str, Any]:
    """Start a process in its own group, so that _kill_tree also stops its children (npx starts node)."""
    if sys.platform == "win32":
        return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0) | subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _kill_tree(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, timeout=10,
                           **_no_window())
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.TimeoutExpired):
        pass
    if proc.returncode is None:
        try:
            proc.kill()
        except ProcessLookupError:
            pass


# -- the kind "token" -------------------------------------------------------------------------------------


def _gh_command() -> list[str] | None:
    if GH is not None:
        return GH
    path = shutil.which("gh")
    return [path] if path else None


def gh_token() -> str | None:
    """The token of the GitHub CLI, or None if gh is not installed or not signed in. Blocks: use a thread."""
    command = _gh_command()
    if command is None:
        return None
    try:
        result = subprocess.run([*command, "auth", "token", "--hostname", "github.com"], capture_output=True,
                                text=True, timeout=GH_TIMEOUT, stdin=subprocess.DEVNULL, **_no_window())
    except (OSError, subprocess.TimeoutExpired):
        return None
    token = result.stdout.strip()
    return token if result.returncode == 0 and token else None


def token(connector_id: str) -> str | None:
    """The token of a "token" connector for a connection, or None if the user did not connect it. Blocks."""
    record = mcp_auth.read_record(record_key(connector_id))
    source = record.get("source")
    if source == "gh":
        return gh_token()
    if source == "token" and isinstance(record.get("token"), str):
        return record["token"]
    return None


async def check_token(connector: Connector, value: str) -> str:
    """Ask the service for the account of the token. Return the account name."""
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(connector.user_api, headers={
                "Authorization": f"Bearer {value}", "Accept": "application/vnd.github+json",
                "User-Agent": "Harness"})
    except httpx.HTTPError as e:
        raise ConnectorError(f"Harness could not reach {connector.name}: {e}") from None
    if response.status_code == 401:
        raise ConnectorError(f"{connector.name} refused the token. Check that it is correct and not expired.")
    if response.status_code != 200:
        raise ConnectorError(f"{connector.name} answered with HTTP {response.status_code}.")
    try:
        login = response.json().get("login")
    except ValueError:
        login = None
    return login if isinstance(login, str) and login else "unknown"


# -- the kind "device" ------------------------------------------------------------------------------------


def device_options(raw: Any) -> dict[str, Any]:
    """The options of a device connector: the account type and read-only."""
    raw = raw if isinstance(raw, dict) else {}
    account = raw.get("account", "personal")
    if account not in ACCOUNTS:
        raise ConfigError(f"The account must be one of: {', '.join(ACCOUNTS)}.")
    return {"account": account, "read_only": bool(raw.get("read_only", False))}


def server_command(connector: Connector, options: dict[str, Any]) -> tuple[str, list[str], dict[str, str]]:
    """The command, the arguments, and the environment of a device server."""
    args = list(connector.args)
    env: dict[str, str] = {}
    if options["account"] == "work":
        args.append("--org-mode")
    else:
        # A refresh token from the "common" authority fails at its first refresh for a personal account.
        env["MS365_MCP_TENANT_ID"] = "consumers"
    if options["read_only"]:
        args.append("--read-only")
    if NPX is not None:
        return NPX[0], [*NPX[1:], *args], env
    return "npx", ["-y", connector.package, *args], env


def _exec_command(command: str, args: list[str]) -> list[str]:
    path = shutil.which(command) if not re.search(r"[\\/]", command) else command
    if path is None:
        raise ConnectorError(f"'{command}' is not on the daemon computer. Install Node.js (it has npx), "
                             "then connect again.")
    return [path, *args]


async def _run_login(connector: Connector, options: dict[str, Any], on_code: OnCode) -> str:
    """Run the server with --login. Send the device code to ``on_code``. Return the account name."""
    command, args, env = server_command(connector, options)
    argv = _exec_command(command, [*args, "--login"])
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env={**os.environ, **env}, **_own_group())
    except OSError as e:
        raise ConnectorError(f"Harness could not start {connector.package or command}: {e}") from None
    _CANCELLED.discard(connector.id)
    _LOGINS[connector.id] = proc
    result: dict[str, Any] | None = None
    tail: list[str] = []
    sent = False

    async def read() -> None:
        nonlocal result, sent
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").strip()
            if not text:
                continue
            tail.append(text)
            del tail[:-5]
            match = re.search(r"(https://\S+?)[.,]?\s.*?\bcode\s+([A-Z0-9-]{6,})", text)
            if match and not sent:
                sent = True
                await on_code(match.group(1), match.group(2))
            if text.startswith("{"):
                try:
                    data = json.loads(text)
                except ValueError:
                    continue
                if isinstance(data, dict) and "success" in data:
                    result = data

    try:
        await asyncio.wait_for(asyncio.gather(read(), proc.wait()), LOGIN_TIMEOUT)
    except asyncio.TimeoutError:
        _kill_tree(proc)
        raise ConnectorError(f"The sign-in did not complete in {LOGIN_TIMEOUT // 60} minutes.") from None
    finally:
        _LOGINS.pop(connector.id, None)
    if connector.id in _CANCELLED:
        _CANCELLED.discard(connector.id)
        raise ConnectorError("The sign-in was cancelled.")
    if proc.returncode not in (0, None) and result is None:
        detail = tail[-1] if tail else f"exit code {proc.returncode}"
        raise ConnectorError(f"The sign-in failed: {detail[:300]}")
    if result is None:
        raise ConnectorError("The server gave no sign-in result.")
    if not result.get("success"):
        raise ConnectorError(f"The sign-in failed: {str(result.get('message') or 'no reason')[:300]}")
    user = result.get("userData") if isinstance(result.get("userData"), dict) else {}
    login = user.get("userPrincipalName") or user.get("displayName")
    return login if isinstance(login, str) and login else "unknown"


async def _run_logout(connector: Connector, options: dict[str, Any]) -> None:
    command, args, env = server_command(connector, options)
    try:
        argv = _exec_command(command, [*args, "--logout"])
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, env={**os.environ, **env}, **_no_window())
        await asyncio.wait_for(proc.wait(), LOGOUT_TIMEOUT)
    except (ConnectorError, OSError, asyncio.TimeoutError):
        pass  # The entry and the record go away in any case.


def cancel(connector_id: str) -> bool:
    """Stop a sign-in that waits for the user. True if one was running."""
    proc = _LOGINS.get(connector_id)
    if proc is None or proc.returncode is not None:
        return False
    _CANCELLED.add(connector_id)
    _kill_tree(proc)
    return True


# -- the user file mcp.json -------------------------------------------------------------------------


def _user_file() -> tuple[Any, dict[str, Any]]:
    """The data of ~/.harness/mcp.json, and the object that holds its servers (in the data)."""
    path = harness_home() / "mcp.json"
    data = read_json(path, None)
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must be a JSON object.")
    for key in ("mcpServers", "servers"):
        if isinstance(data.get(key), dict):
            return data, data[key]
    if any(isinstance(v, dict) for v in data.values()):
        return data, data  # The old form: the servers at the top.
    data["mcpServers"] = {}
    return data, data["mcpServers"]


def installed(connector_id: str) -> bool:
    try:
        _, servers = _user_file()
    except ConfigError:
        return False
    entry = servers.get(connector_id)
    return isinstance(entry, dict) and entry.get("connector") == connector_id


def _entry(connector: Connector, options: dict[str, Any] | None) -> dict[str, Any]:
    if connector.kind == "device":
        command, args, env = server_command(connector, options or device_options(None))
        entry: dict[str, Any] = {"command": command, "args": args}
        if env:
            entry["env"] = env
        entry["connector"] = connector.id
        return entry
    return {"type": "http", "url": connector.url, "connector": connector.id}


def _check_free(servers: dict[str, Any], connector: Connector) -> None:
    entry = servers.get(connector.id)
    if entry is not None and not (isinstance(entry, dict) and entry.get("connector") == connector.id):
        raise ConnectorError(f"~/.harness/mcp.json already has a server named '{connector.id}'. "
                             "Rename it or remove it, then connect again.")


def install(connector: Connector, options: dict[str, Any] | None = None) -> None:
    """Add the server entry to ~/.harness/mcp.json, or update the entry of this connector."""
    data, servers = _user_file()
    _check_free(servers, connector)
    entry = _entry(connector, options)
    if servers.get(connector.id) != entry:
        servers[connector.id] = entry
        write_json(harness_home() / "mcp.json", data)


def uninstall(connector_id: str) -> bool:
    """Remove the server entry of the connector from ~/.harness/mcp.json. True if there was one."""
    data, servers = _user_file()
    entry = servers.get(connector_id)
    if not (isinstance(entry, dict) and entry.get("connector") == connector_id):
        return False
    del servers[connector_id]
    write_json(harness_home() / "mcp.json", data)
    return True


# -- the client ------------------------------------------------------------------------------------------


def _status(connector: Connector, gh: bool) -> dict[str, Any]:
    record = mcp_auth.read_record(record_key(connector.id))
    source = record.get("source") if record.get("source") in SOURCES else None
    body: dict[str, Any] = {
        "id": connector.id, "name": connector.name, "description": connector.description, "kind": connector.kind,
        "installed": installed(connector.id), "source": source,
        "login": record.get("login") if source else None, "signing_in": connector.id in _LOGINS,
    }
    if connector.kind == "device":
        body.update({"url": connector.home_url, "package": connector.package,
                     "options": device_options(record.get("options")) if source else None})
    else:
        body.update({"url": connector.url, "gh_available": gh, "token_url": connector.token_url,
                     "token_help": connector.token_help})
    return body


async def items() -> dict[str, Any]:
    gh = await asyncio.to_thread(gh_token) is not None
    return {"type": "connectors", "items": [_status(c, gh) for c in CONNECTORS.values()]}


async def connect(connector_id: str, source: str, pasted: str | None = None, *,
                  options: Any = None, on_code: OnCode | None = None) -> str:
    """Sign in, keep the record, and add the server to ~/.harness/mcp.json. Return the account name.

    A "token" connector takes the source "gh" or "token" (with ``pasted``). A "device" connector takes
    the source "device", the options, and ``on_code`` for the device code.
    """
    connector = get(connector_id)
    if source not in SOURCES or (source == "device") != (connector.kind == "device"):
        allowed = "device" if connector.kind == "device" else "gh, token"
        raise ConfigError(f"The token source of {connector.name} must be one of: {allowed}.")
    _, servers = _user_file()
    _check_free(servers, connector)  # Before the user signs in.
    if connector.kind == "device":
        opts = device_options(options)
        if connector_id in _LOGINS:
            raise ConnectorError("A sign-in already waits. Cancel it first.")

        async def no_code(url: str, code: str) -> None:
            return None

        login = await _run_login(connector, opts, on_code or no_code)
        mcp_auth.clear_record(record_key(connector_id))
        mcp_auth.update_record(record_key(connector_id), source="device", login=login, options=opts)
        install(connector, opts)
        return login
    if source == "gh":
        value = await asyncio.to_thread(gh_token)
        if value is None:
            raise ConnectorError("The GitHub CLI is not signed in on the daemon computer. "
                                 "Run 'gh auth login' there, or paste a token.")
    else:
        value = (pasted or "").strip()
        if not value or any(ch.isspace() for ch in value):
            raise ConnectorError("Paste the token. It has no spaces.")
    login = await check_token(connector, value)
    mcp_auth.clear_record(record_key(connector_id))
    mcp_auth.update_record(record_key(connector_id), source=source, login=login,
                           token=value if source == "token" else None)
    install(connector)
    return login


async def disconnect(connector_id: str) -> None:
    """Sign out (a device server), and remove the record and the server entry."""
    connector = get(connector_id)
    cancel(connector_id)
    record = mcp_auth.read_record(record_key(connector_id))
    if connector.kind == "device" and record.get("source") == "device":
        await _run_logout(connector, device_options(record.get("options")))
    mcp_auth.clear_record(record_key(connector_id))
    uninstall(connector_id)
