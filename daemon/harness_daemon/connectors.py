"""Connectors: MCP servers that the Connectors tab of the Capabilities page sets up in one step.

A connector is an MCP server entry in the user file ``~/.harness/mcp.json`` with a ``connector``
key, and a record in ``~/.harness/mcp-auth.json`` (the store of mcp_auth.py, which only the user can
read). ``mcp.json`` never has a token or a secret.

``token`` (GitHub): a remote HTTP server and a bearer token::

    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "connector": "github" }

The MCP client asks ``token()`` for the token at each connection, and sends it as
``Authorization: Bearer <token>``. GitHub has two token sources:

- ``gh``: the token of the GitHub CLI (``gh auth token``) on the daemon computer. The daemon reads
  it again at each connection, so a new ``gh auth login`` takes effect at the next restart.
- ``token``: a personal access token that the user pastes.

GitHub has no dynamic client registration, so the OAuth flow of mcp_auth.py does not work for it
without a registered OAuth app. The ``oauth`` key in ``mcp.json`` is for that case.

There are two more kinds, described at their code: ``google`` (Gmail, a local Python server; Harness signs
in to Google with the OAuth client of the user and writes the credential files) and ``local`` (Chrome, a
local server with no sign-in).

``device`` (Microsoft Outlook): a local stdio server from npm that signs in by itself::

    "outlook": { "command": "npx", "args": ["-y", "@softeria/ms-365-mcp-server@0.179.1", "--preset", "outlook"],
                 "env": { "MS365_MCP_TENANT_ID": "consumers", "MS365_MCP_TOKEN_CACHE_PATH": "...", ... },
                 "connector": "outlook" }

``connect`` adds one account: it runs the server with ``--login``. The server prints a Microsoft
device code, and the client shows it. The user enters the code at microsoft.com/devicelogin. The
server keeps and refreshes its own tokens (in its encrypted cache under ~/.harness/connectors/), so
the record keeps only the account names and the read-only choice. Personal accounts share the server
"outlook", and work or school accounts share "outlook-work". ``remove_account`` signs out one account
(``--remove-account``), and ``disconnect`` signs out all of them (``--logout``).
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
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from . import mcp_auth
from .config import ConfigError, harness_home, read_json, write_json

GH_TIMEOUT = 10
LOGIN_TIMEOUT = 900  # Seconds. A Microsoft device code expires after 15 minutes.
LOGOUT_TIMEOUT = 120  # The first npx run can download the package.
SOURCES = ("gh", "token", "device", "google", "local")
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

GMAIL = Connector(
    id="gmail",
    name="Gmail",
    description="Mail, labels, drafts, and filters of Google accounts, through the workspace-mcp server "
                "of Taylor Wilsdon (MIT).",
    kind="google",
    package="workspace-mcp@2.3.0",
    args=("--tools", "gmail"),
    home_url="https://github.com/taylorwilsdon/google_workspace_mcp",
    token_url="https://console.cloud.google.com/auth/clients",
)

CHROME = Connector(
    id="chrome",
    name="Chrome",
    description="Your Chrome browser: open pages, click, type, take screenshots, and read the console and the "
                "network, through Chrome DevTools MCP (Apache-2.0).",
    kind="local",
    package="chrome-devtools-mcp@1.12.0",
    args=("--no-usage-statistics",),
    home_url="https://github.com/ChromeDevTools/chrome-devtools-mcp",
)

CONNECTORS: dict[str, Connector] = {GITHUB.id: GITHUB, OUTLOOK.id: OUTLOOK, GMAIL.id: GMAIL, CHROME.id: CHROME}

# The commands. Tests replace them.
GH: list[str] | None = None
NPX: list[str] | None = None  # The command that runs a device server, instead of "npx -y <package>".
UVX: list[str] | None = None  # The command that runs a Python server, instead of "uvx <package>".

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
#
# The accounts of a device connector are in groups: "personal" and "work". Each group is one MCP server
# with its own token cache, because a personal account needs the "consumers" tenant and a work account
# needs --org-mode. One server holds all the accounts of its group. With two or more accounts, the server
# adds an "account" parameter to each tool. The record:
#
#     {"source": "device", "accounts": [{"login": "pat@outlook.com", "type": "personal"}],
#      "read_only": {"personal": false, "work": true}}


def device_options(raw: Any) -> dict[str, Any]:
    """The options of a new sign-in: the account type and read-only (for all the accounts of that type)."""
    raw = raw if isinstance(raw, dict) else {}
    account = raw.get("account", "personal")
    if account not in ACCOUNTS:
        raise ConfigError(f"The account must be one of: {', '.join(ACCOUNTS)}.")
    return {"account": account, "read_only": bool(raw.get("read_only", False))}


def server_name(connector: Connector, group: str) -> str:
    """The name of the MCP server of a group in mcp.json: "outlook" and "outlook-work"."""
    return connector.id if group == "personal" else f"{connector.id}-{group}"


def server_names(connector_id: str) -> list[str]:
    """The names of all the MCP servers that a connector can add."""
    connector = get(connector_id)
    if connector.kind == "device":
        return [server_name(connector, group) for group in ACCOUNTS]
    return [connector.id]


def cache_dir(connector: Connector, group: str) -> Path:
    """The token cache of a group. Harness keeps it apart from the default cache of the server."""
    return harness_home() / "connectors" / f"{connector.id}-{group}"


def server_command(connector: Connector, group: str, read_only: bool) -> tuple[str, list[str], dict[str, str]]:
    """The command, the arguments, and the environment of the server of a group."""
    args = list(connector.args)
    cache = cache_dir(connector, group)
    env: dict[str, str] = {
        "MS365_MCP_TOKEN_CACHE_PATH": str(cache / ".token-cache.json"),
        "MS365_MCP_SELECTED_ACCOUNT_PATH": str(cache / ".selected-account.json"),
    }
    if group == "work":
        args.append("--org-mode")
    else:
        # A refresh token from the "common" authority fails at its first refresh for a personal account.
        env["MS365_MCP_TENANT_ID"] = "consumers"
    if read_only:
        args.append("--read-only")
    if NPX is not None:
        return NPX[0], [*NPX[1:], *args], env
    return "npx", ["-y", connector.package, *args], env


def _exec_command(command: str, args: list[str]) -> list[str]:
    path = shutil.which(command) if not re.search(r"[\\/]", command) else command
    if path is None:
        need = "uv (it has uvx)" if command == "uvx" else "Node.js (it has npx)"
        raise ConnectorError(f"'{command}' is not on the daemon computer. Install {need}, then connect again.")
    return [path, *args]


def _device_record(connector_id: str) -> dict[str, Any]:
    """The accounts and the read-only groups of a device connector."""
    record = mcp_auth.read_record(record_key(connector_id))
    accounts = []
    for item in record.get("accounts") or []:
        if isinstance(item, dict) and isinstance(item.get("login"), str) and item.get("type") in ACCOUNTS:
            accounts.append({"login": item["login"], "type": item["type"]})
    raw = record.get("read_only") if isinstance(record.get("read_only"), dict) else {}
    return {"accounts": accounts, "read_only": {group: bool(raw.get(group, False)) for group in ACCOUNTS}}


def _save_device_record(connector_id: str, data: dict[str, Any]) -> None:
    mcp_auth.clear_record(record_key(connector_id))
    if data["accounts"]:
        mcp_auth.update_record(record_key(connector_id), source="device", accounts=data["accounts"],
                               read_only=data["read_only"])


async def _run_command(connector: Connector, group: str, read_only: bool, extra: list[str],
                       timeout: float = LOGOUT_TIMEOUT) -> tuple[int | None, list[dict[str, Any]]]:
    """Run the server of a group with a command flag. Return the exit code and the JSON lines of its output."""
    command, args, env = server_command(connector, group, read_only)
    argv = _exec_command(command, [*args, *extra])  # Only device servers have command flags.
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, env={**os.environ, **env}, **_own_group())
    except OSError as e:
        raise ConnectorError(f"Harness could not start {connector.package or command}: {e}") from None
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        _kill_tree(proc)
        raise ConnectorError(f"The server of {connector.name} did not answer in {int(timeout)} seconds.") from None
    lines = []
    for line in out.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if isinstance(data, dict):
                lines.append(data)
    return proc.returncode, lines


async def _list_accounts(connector: Connector, group: str, read_only: bool) -> list[str] | None:
    """The account names in the cache of a group (--list-accounts), or None if the list failed."""
    try:
        code, lines = await _run_command(connector, group, read_only, ["--list-accounts"])
    except ConnectorError:
        return None
    for data in lines:
        if isinstance(data.get("accounts"), list):
            return [a["username"] for a in data["accounts"] if isinstance(a, dict) and isinstance(a.get("username"), str)]
    return None


async def _run_login(connector: Connector, group: str, read_only: bool, on_code: OnCode) -> str:
    """Run the server of a group with --login. Send the device code to ``on_code``. Return the account name."""
    command, args, env = server_command(connector, group, read_only)
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


async def add_account(connector: Connector, options: Any, on_code: OnCode) -> str:
    """Sign in one more account. Return its name. The other accounts stay."""
    opts = device_options(options)
    group, read_only = opts["account"], opts["read_only"]
    if connector.id in _LOGINS:
        raise ConnectorError("A sign-in already waits. Cancel it first.")
    _, servers = _user_file()
    _check_free(servers, connector, server_name(connector, group))  # Before the user signs in.
    before = await _list_accounts(connector, group, read_only) or []
    login = await _run_login(connector, group, read_only, on_code)
    after = await _list_accounts(connector, group, read_only)
    # The sign-in result names the selected account, which can be an older one. The new name is in the list.
    new = [name for name in (after or []) if name.lower() not in {b.lower() for b in before}]
    if new:
        login = new[0]
    data = _device_record(connector.id)
    names = after if after is not None else [*(a["login"] for a in data["accounts"] if a["type"] == group), login]
    others = [a for a in data["accounts"] if a["type"] != group]
    seen: set[str] = set()
    mine = []
    for name in names:
        if name.lower() not in seen:
            seen.add(name.lower())
            mine.append({"login": name, "type": group})
    data["accounts"] = [*others, *mine]
    data["read_only"][group] = read_only
    _save_device_record(connector.id, data)
    install(connector, group, read_only)
    return login


async def remove_account(connector_id: str, login: str) -> None:
    """Sign out one account (--remove-account). Remove its server when it was the last account of its group."""
    connector = get(connector_id)
    if connector.kind == "google":
        data = _google_record(connector_id)
        match = next((a for a in data["accounts"] if a["login"].lower() == login.lower()), None)
        if match is None:
            raise ConnectorError(f"{connector.name} has no account {login}.")
        await _revoke_google(connector, match["login"])
        data["accounts"] = [a for a in data["accounts"] if a is not match]
        if not data["accounts"]:
            uninstall_server(connector, connector.id)
        _save_google_record(connector_id, data)  # The client stays for the next account.
        return
    if connector.kind != "device":
        raise ConfigError(f"{connector.name} has no accounts to remove. Use Disconnect.")
    data = _device_record(connector_id)
    match = next((a for a in data["accounts"] if a["login"].lower() == login.lower()), None)
    if match is None:
        raise ConnectorError(f"{connector.name} has no account {login}.")
    group = match["type"]
    try:
        await _run_command(connector, group, data["read_only"][group], ["--remove-account", match["login"]])
    except ConnectorError:
        pass  # The record and the entry change in any case.
    data["accounts"] = [a for a in data["accounts"] if a is not match]
    if not any(a["type"] == group for a in data["accounts"]):
        uninstall_server(connector, server_name(connector, group))
    _save_device_record(connector_id, data)


async def _run_logout(connector: Connector, group: str, read_only: bool) -> None:
    try:
        await _run_command(connector, group, read_only, ["--logout"])
    except ConnectorError:
        pass  # The entry and the record go away in any case.


def cancel(connector_id: str) -> bool:
    """Stop a sign-in that waits for the user. True if one was running."""
    listener = _GOOGLE_FLOWS.get(connector_id)
    if listener is not None:
        listener.cancel()
        return True
    proc = _LOGINS.get(connector_id)
    if proc is None or proc.returncode is not None:
        return False
    _CANCELLED.add(connector_id)
    _kill_tree(proc)
    return True


# -- the kind "google" (Gmail) ------------------------------------------------------------------------------
#
# Harness signs in to Google itself, with the OAuth client that the user made in Google Cloud (Google has no
# dynamic client registration). It writes one credential file for each account, in the format of
# workspace-mcp, into the credential folder of the connector. The tools of workspace-mcp take a
# "user_google_email" parameter, so one server serves all the accounts. The record:
#
#     {"source": "google", "client_id": "...", "client_secret": "...", "read_only": false,
#      "accounts": [{"login": "pat@gmail.com", "type": "google"}]}

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GOOGLE_BASE_SCOPES = ["https://www.googleapis.com/auth/userinfo.email",
                      "https://www.googleapis.com/auth/userinfo.profile", "openid"]
GMAIL_SCOPES = [f"https://www.googleapis.com/auth/gmail.{name}"
                for name in ("readonly", "send", "compose", "modify", "labels", "settings.basic")]
GMAIL_READ_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

_GOOGLE_FLOWS: dict[str, mcp_auth.Callback] = {}  # The sign-ins that wait for the browser.

OnUrl = Callable[[str], Awaitable[None]]


def builtin_google_client() -> tuple[str, str] | None:
    """The Google OAuth client of Harness ("Continue with Google"), or None if this build has none.

    It comes from HARNESS_GOOGLE_CLIENT_ID and HARNESS_GOOGLE_CLIENT_SECRET, or from the module
    harness_daemon/_google_client.py (CLIENT_ID and CLIENT_SECRET). git ignores that module, so the secret
    is not in the public repository. Google treats the secret of a "Desktop app" client as not confidential,
    but a published secret can still be copied by other apps.
    """
    client_id = os.environ.get("HARNESS_GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("HARNESS_GOOGLE_CLIENT_SECRET", "").strip()
    if not (client_id and client_secret):
        import importlib

        try:
            _google_client = importlib.import_module(f"{__package__}._google_client")
        except ImportError:
            return None
        client_id = str(getattr(_google_client, "CLIENT_ID", "")).strip()
        client_secret = str(getattr(_google_client, "CLIENT_SECRET", "")).strip()
    return (client_id, client_secret) if client_id and client_secret else None


def google_scopes(read_only: bool) -> list[str]:
    return [*GOOGLE_BASE_SCOPES, *(GMAIL_READ_SCOPES if read_only else GMAIL_SCOPES)]


def credentials_dir(connector: Connector) -> Path:
    return harness_home() / "connectors" / connector.id / "credentials"


def credential_path(connector: Connector, email: str) -> Path:
    """The file of one account, with the name rule of workspace-mcp (the URL-encoded address)."""
    from urllib.parse import quote

    return credentials_dir(connector) / f"{quote(email, safe='@._-')}.json"


def _google_record(connector_id: str) -> dict[str, Any]:
    """The client, read-only, and the accounts. With the Harness client, the secret comes from the build."""
    record = mcp_auth.read_record(record_key(connector_id))
    accounts = [{"login": a["login"], "type": "google"} for a in record.get("accounts") or []
                if isinstance(a, dict) and isinstance(a.get("login"), str)]
    builtin = bool(record.get("builtin"))
    client_id = record.get("client_id") if isinstance(record.get("client_id"), str) else None
    client_secret = record.get("client_secret") if isinstance(record.get("client_secret"), str) else None
    if builtin:
        known = builtin_google_client()
        client_id, client_secret = known if known else (client_id, None)
    return {"client_id": client_id, "client_secret": client_secret, "builtin": builtin,
            "read_only": bool(record.get("read_only", False)), "accounts": accounts}


def _save_google_record(connector_id: str, data: dict[str, Any]) -> None:
    mcp_auth.clear_record(record_key(connector_id))
    if data["client_id"]:
        mcp_auth.update_record(record_key(connector_id), source="google", client_id=data["client_id"],
                               client_secret=None if data["builtin"] else data["client_secret"],
                               builtin=True if data["builtin"] else None,
                               read_only=data["read_only"], accounts=data["accounts"])


def _uvx_command(connector: Connector, read_only: bool) -> tuple[str, list[str], dict[str, str]]:
    args = list(connector.args)
    if read_only:
        args.append("--read-only")
    env = {"WORKSPACE_MCP_CREDENTIALS_DIR": str(credentials_dir(connector))}
    if UVX is not None:
        return UVX[0], [*UVX[1:], *args], env
    return "uvx", [connector.package, *args], env


async def add_google_account(connector: Connector, options: Any, on_url: OnUrl) -> str:
    """Sign in one more Google account in the browser, and write its credential file. Return the address."""
    import base64
    import hashlib
    import secrets
    from datetime import datetime, timedelta, timezone
    from urllib.parse import urlencode

    raw = options if isinstance(options, dict) else {}
    data = _google_record(connector.id)
    builtin = bool(raw.get("builtin")) if not data["client_id"] else data["builtin"]
    if builtin:
        known = builtin_google_client()
        if known is None:
            raise ConnectorError("This build of Harness has no Google client. Use your own OAuth client.")
        client_id, client_secret = known
    else:
        client_id = str(raw.get("client_id") or "").strip() or data["client_id"]
        client_secret = str(raw.get("client_secret") or "").strip() or data["client_secret"]
    if not client_id or not client_secret:
        raise ConnectorError("Enter the client ID and the client secret of your Google OAuth client first.")
    if any(ch.isspace() for ch in client_id + client_secret):
        raise ConnectorError("The client ID and the client secret have no spaces.")
    if client_id != data["client_id"] and data["accounts"]:
        raise ConnectorError("The accounts use another OAuth client. Disconnect all, then connect with the new client.")
    read_only = bool(raw.get("read_only", data["read_only"])) if not data["accounts"] else data["read_only"]
    if connector.id in _GOOGLE_FLOWS:
        raise ConnectorError("A sign-in already waits. Cancel it first.")
    _, servers = _user_file()
    _check_free(servers, connector)

    port = mcp_auth.free_port()
    redirect = f"http://127.0.0.1:{port}/"
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(24)
    scopes = google_scopes(read_only)
    url = GOOGLE_AUTH_URL + "?" + urlencode({
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect, "scope": " ".join(scopes),
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
        "access_type": "offline", "prompt": "consent select_account"})
    listener = mcp_auth.Callback(port, path="/")
    await listener.start()
    _GOOGLE_FLOWS[connector.id] = listener
    try:
        await on_url(url)
        try:
            result = await listener.wait()
        except mcp_auth.AuthCancelled as e:
            raise ConnectorError(str(e)) from None
        except Exception as e:  # noqa: BLE001 - the error of the authorization server.
            raise ConnectorError(str(e)) from None
    finally:
        _GOOGLE_FLOWS.pop(connector.id, None)
        await listener.close()
    if result.state != state:
        raise ConnectorError("The sign-in answer does not match this sign-in. Try again.")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(GOOGLE_TOKEN_URL, headers={"Accept": "application/json"}, data={
                "grant_type": "authorization_code", "code": result.code, "redirect_uri": redirect,
                "client_id": client_id, "client_secret": client_secret, "code_verifier": verifier})
            if response.status_code != 200:
                raise ConnectorError(f"Google refused the sign-in (HTTP {response.status_code}): {response.text[:200]}")
            tokens = response.json()
            info = await client.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {tokens['access_token']}"})
            email = info.json().get("email") if info.status_code == 200 else None
    except httpx.HTTPError as e:
        raise ConnectorError(f"Harness could not reach Google: {e}") from None
    except (ValueError, KeyError):
        raise ConnectorError("Google gave an answer that Harness cannot read.") from None
    if not isinstance(email, str) or not email:
        raise ConnectorError("Google did not give the address of the account.")
    if not tokens.get("refresh_token"):
        raise ConnectorError("Google gave no refresh token. Remove the access of the app in your Google account "
                             "(myaccount.google.com/permissions), then try again.")
    expiry = datetime.now(timezone.utc) + timedelta(seconds=int(tokens.get("expires_in") or 3600))
    granted = str(tokens.get("scope") or " ".join(scopes)).split()
    path = credential_path(connector, email)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"token": tokens["access_token"], "refresh_token": tokens["refresh_token"],
                   "token_uri": GOOGLE_TOKEN_URL, "client_id": client_id, "client_secret": client_secret,
                   "scopes": granted, "expiry": expiry.replace(tzinfo=None).isoformat()}, f, indent=2)
    data.update(client_id=client_id, client_secret=client_secret, builtin=builtin, read_only=read_only)
    data["accounts"] = [a for a in data["accounts"] if a["login"].lower() != email.lower()]
    data["accounts"].append({"login": email, "type": "google"})
    _save_google_record(connector.id, data)
    install(connector, read_only=read_only)
    return email


async def _revoke_google(connector: Connector, email: str) -> None:
    """Revoke the refresh token of an account (best effort), and delete its credential file."""
    path = credential_path(connector, email)
    try:
        token = json.loads(path.read_text(encoding="utf-8")).get("refresh_token")
    except (OSError, ValueError):
        token = None
    if token:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                await client.post(GOOGLE_REVOKE_URL, data={"token": token})
        except httpx.HTTPError:
            pass
    try:
        path.unlink()
    except OSError:
        pass


def google_code(connector_id: str, url: str) -> str | None:
    """The user pasted the URL of the callback page (a remote daemon). Return an error text, or None."""
    listener = _GOOGLE_FLOWS.get(connector_id)
    if listener is None:
        return "No sign-in is waiting. Click the sign-in button first."
    return listener.resolve(url)


# -- the kind "local" (Chrome) ------------------------------------------------------------------------------
#
# A local stdio server with no sign-in. The record keeps the options: {"source": "local", "options":
# {"profile": "own" or "separate"}}. "own" attaches to the Chrome window of the user (--autoConnect, Chrome
# 144 or newer, with remote debugging turned on in chrome://inspect/#remote-debugging). "separate" starts a
# Chrome with a profile of its own.

CHROME_PROFILES = ("own", "separate")


def _chrome_command(connector: Connector, profile: str) -> tuple[str, list[str], dict[str, str]]:
    args = list(connector.args)
    if profile == "own":
        args.append("--autoConnect")
    if NPX is not None:
        return NPX[0], [*NPX[1:], *args], {}
    return "npx", ["-y", connector.package, *args], {}


def server_env(connector_id: str) -> dict[str, str]:
    """The secret environment of a connector server, that the MCP client adds at each start. mcp.json has none."""
    connector = CONNECTORS.get(connector_id)
    if connector is None or connector.kind != "google":
        return {}
    data = _google_record(connector_id)
    if not data["client_id"]:
        return {}
    return {"GOOGLE_OAUTH_CLIENT_ID": data["client_id"], "GOOGLE_OAUTH_CLIENT_SECRET": data["client_secret"] or ""}


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


def _owned(entry: Any, connector_id: str) -> bool:
    return isinstance(entry, dict) and entry.get("connector") == connector_id


def installed(connector_id: str) -> bool:
    try:
        _, servers = _user_file()
    except ConfigError:
        return False
    return any(_owned(servers.get(name), connector_id) for name in server_names(connector_id))


def _check_free(servers: dict[str, Any], connector: Connector, name: str | None = None) -> None:
    name = name or connector.id
    entry = servers.get(name)
    if entry is not None and not _owned(entry, connector.id):
        raise ConnectorError(f"~/.harness/mcp.json already has a server named '{name}'. "
                             "Rename it or remove it, then connect again.")


def install(connector: Connector, group: str | None = None, read_only: bool = False) -> None:
    """Add the server entry to ~/.harness/mcp.json, or update the entry of this connector (or of a group)."""
    data, servers = _user_file()
    if connector.kind in ("device", "google", "local"):
        if connector.kind == "device":
            name = server_name(connector, group or "personal")
            command, args, env = server_command(connector, group or "personal", read_only)
        elif connector.kind == "google":
            name = connector.id
            command, args, env = _uvx_command(connector, read_only)
        else:
            name = connector.id
            command, args, env = _chrome_command(connector, group or "separate")
        entry: dict[str, Any] = {"command": command, "args": args}
        if env:
            entry["env"] = env
        entry["connector"] = connector.id
    else:
        name = connector.id
        entry = {"type": "http", "url": connector.url, "connector": connector.id}
    _check_free(servers, connector, name)
    if servers.get(name) != entry:
        servers[name] = entry
        write_json(harness_home() / "mcp.json", data)


def uninstall_server(connector: Connector, name: str) -> bool:
    data, servers = _user_file()
    if not _owned(servers.get(name), connector.id):
        return False
    del servers[name]
    write_json(harness_home() / "mcp.json", data)
    return True


def uninstall(connector_id: str) -> bool:
    """Remove all the server entries of the connector from ~/.harness/mcp.json. True if there was one."""
    connector = get(connector_id)
    removed = False
    for name in server_names(connector_id):
        removed = uninstall_server(connector, name) or removed
    return removed


# -- the client ------------------------------------------------------------------------------------------


def _status(connector: Connector, gh: bool) -> dict[str, Any]:
    record = mcp_auth.read_record(record_key(connector.id))
    body: dict[str, Any] = {
        "id": connector.id, "name": connector.name, "description": connector.description, "kind": connector.kind,
        "installed": installed(connector.id), "signing_in": connector.id in _LOGINS,
    }
    if connector.kind == "device":
        data = _device_record(connector.id)
        accounts = [{**a, "read_only": data["read_only"][a["type"]]} for a in data["accounts"]]
        body.update({"source": "device" if accounts else None, "login": accounts[0]["login"] if accounts else None,
                     "accounts": accounts, "url": connector.home_url, "package": connector.package})
    elif connector.kind == "google":
        data = _google_record(connector.id)
        accounts = [{**a, "read_only": data["read_only"]} for a in data["accounts"]]
        body.update({"source": "google" if accounts else None, "login": accounts[0]["login"] if accounts else None,
                     "accounts": accounts, "url": connector.home_url, "package": connector.package,
                     "token_url": connector.token_url,
                     "client_id": None if data["builtin"] else data["client_id"],
                     "client_builtin": data["builtin"] and bool(data["client_id"]),
                     "builtin_client": builtin_google_client() is not None,
                     "signing_in": connector.id in _GOOGLE_FLOWS})
    elif connector.kind == "local":
        options = record.get("options") if isinstance(record.get("options"), dict) else {}
        profile = options.get("profile") if options.get("profile") in CHROME_PROFILES else None
        on = record.get("source") == "local" and installed(connector.id)
        body.update({"source": "local" if on else None, "login": None, "url": connector.home_url,
                     "package": connector.package, "profile": profile if on else None})
    else:
        source = record.get("source") if record.get("source") in ("gh", "token") else None
        body.update({"source": source, "login": record.get("login") if source else None, "url": connector.url,
                     "gh_available": gh, "token_url": connector.token_url, "token_help": connector.token_help})
    return body


async def items() -> dict[str, Any]:
    gh = await asyncio.to_thread(gh_token) is not None
    return {"type": "connectors", "items": [_status(c, gh) for c in CONNECTORS.values()]}


async def connect(connector_id: str, source: str, pasted: str | None = None, *,
                  options: Any = None, on_code: OnCode | None = None, on_url: OnUrl | None = None) -> str:
    """Sign in, keep the record, and add the server to ~/.harness/mcp.json. Return the account name.

    A "token" connector takes the source "gh" or "token" (with ``pasted``). A "device" connector takes
    the source "device", the options, and ``on_code`` for the device code. It adds one more account.
    """
    connector = get(connector_id)
    allowed = {"device": ("device",), "google": ("google",), "local": ("local",)}.get(connector.kind, ("gh", "token"))
    if source not in allowed:
        raise ConfigError(f"The token source of {connector.name} must be one of: {', '.join(allowed)}.")
    if connector.kind == "device":
        async def no_code(url: str, code: str) -> None:
            return None

        return await add_account(connector, options, on_code or no_code)
    if connector.kind == "google":
        async def no_url(url: str) -> None:
            return None

        return await add_google_account(connector, options, on_url or no_url)
    if connector.kind == "local":
        raw = options if isinstance(options, dict) else {}
        profile = raw.get("profile", "own")
        if profile not in CHROME_PROFILES:
            raise ConfigError(f"The profile must be one of: {', '.join(CHROME_PROFILES)}.")
        _, servers = _user_file()
        _check_free(servers, connector)
        install(connector, profile)
        mcp_auth.clear_record(record_key(connector_id))
        mcp_auth.update_record(record_key(connector_id), source="local", options={"profile": profile})
        return profile
    _, servers = _user_file()
    _check_free(servers, connector)  # Before the token check.
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
    """Sign out all the accounts (a device connector), and remove the record and the server entries."""
    connector = get(connector_id)
    cancel(connector_id)
    if connector.kind == "device":
        data = _device_record(connector_id)
        for group in ACCOUNTS:
            if any(a["type"] == group for a in data["accounts"]):
                await _run_logout(connector, group, data["read_only"][group])
    elif connector.kind == "google":
        for account in _google_record(connector_id)["accounts"]:
            await _revoke_google(connector, account["login"])
    mcp_auth.clear_record(record_key(connector_id))
    uninstall(connector_id)
