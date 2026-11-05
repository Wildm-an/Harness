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

There is one more kind, described at its code: ``mail`` (Email, the IMAP and SMTP server that Harness has
built in, mail_server.py, with an app password for each account).

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

from .nethttp import async_client

from . import mcp_auth
from .config import ConfigError, harness_home, read_json, write_json

GH_TIMEOUT = 10
LOGIN_TIMEOUT = 900  # Seconds. A Microsoft device code expires after 15 minutes.
LOGOUT_TIMEOUT = 120  # The first npx run can download the package.
SOURCES = ("gh", "token", "device", "mail")
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

EMAIL = Connector(
    id="email",
    name="Email (IMAP)",
    description="Mail of Gmail, iCloud, Yahoo, Fastmail, and other IMAP accounts: search, read, send, move, and "
                "delete. Harness has the mail server built in.",
    kind="mail",
)

CONNECTORS: dict[str, Connector] = {GITHUB.id: GITHUB, OUTLOOK.id: OUTLOOK, EMAIL.id: EMAIL}

# Connectors that Harness had and removed. The Connectors tab removes their entries from ~/.harness/mcp.json
# (Harness made them), and the MCP client shows a clear message for an entry that is still there.
RETIRED: dict[str, str] = {"chrome": "Chrome (Harness 0.1.44)", "gmail": "Gmail (Harness 0.1.44)"}

# The commands. Tests replace them.
GH: list[str] | None = None
NPX: list[str] | None = None  # The command that runs a device server, instead of "npx -y <package>".
MAIL_COMMAND: list[str] | None = None  # The command of the built-in mail server. Tests replace it.

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
        async with async_client(timeout=20) as client:
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
        raise ConnectorError(f"'{command}' is not on the daemon computer. Install Node.js (it has npx), "
                             "then connect again.")
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
    if connector.kind == "mail":
        mail = _mail_record(connector_id)
        left = [a for a in mail["accounts"] if a["login"].lower() != login.lower()]
        if len(left) == len(mail["accounts"]):
            raise ConnectorError(f"{connector.name} has no account {login}.")
        mail["accounts"] = left
        if not left:
            uninstall_server(connector, connector.id)
        _save_mail_record(connector_id, mail)
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
    proc = _LOGINS.get(connector_id)
    if proc is None or proc.returncode is not None:
        return False
    _CANCELLED.add(connector_id)
    _kill_tree(proc)
    return True


# -- the kind "mail" (Email) --------------------------------------------------------------------------------
#
# The mail server is part of Harness (mail_server.py): the daemon runs itself with --mcp-server mail. Each
# account signs in with an app password, over IMAP (and SMTP to send). The record has the passwords, and the
# MCP client gives them to the server in its environment at each start (server_env), not in mcp.json:
#
#     {"source": "mail", "read_only": false, "accounts": [{"login": "pat@gmail.com", "type": "gmail",
#      "password": "...", "imap_host": "imap.gmail.com", "imap_port": 993, "imap_security": "ssl", ...}]}

# The settings of the common mail services. "other" takes the settings from the user.
MAIL_PROVIDERS: dict[str, dict[str, Any]] = {
    "gmail": {"name": "Gmail", "domains": ["gmail.com", "googlemail.com"],
              "imap": ["imap.gmail.com", 993, "ssl"], "smtp": ["smtp.gmail.com", 465, "ssl"],
              "password_url": "https://myaccount.google.com/apppasswords",
              "help": "Turn on 2-Step Verification in your Google account, then make an app password. "
                      "A Google Workspace admin can block app passwords."},
    "icloud": {"name": "iCloud Mail", "domains": ["icloud.com", "me.com", "mac.com"],
               "imap": ["imap.mail.me.com", 993, "ssl"], "smtp": ["smtp.mail.me.com", 587, "starttls"],
               "password_url": "https://support.apple.com/en-us/102654",
               "help": "Turn on two-factor authentication. In your Apple Account, open Sign-In and Security, "
                       "then App-Specific Passwords."},
    "yahoo": {"name": "Yahoo Mail", "domains": ["yahoo.com", "ymail.com", "rocketmail.com"],
              "imap": ["imap.mail.yahoo.com", 993, "ssl"], "smtp": ["smtp.mail.yahoo.com", 465, "ssl"],
              "password_url": "https://login.yahoo.com/account/security",
              "help": "In Account Security, click Create app password."},
    "fastmail": {"name": "Fastmail", "domains": ["fastmail.com", "fastmail.fm"],
                 "imap": ["imap.fastmail.com", 993, "ssl"], "smtp": ["smtp.fastmail.com", 465, "ssl"],
                 "password_url": "https://www.fastmail.help/hc/en-us/articles/360058752854",
                 "help": "In Settings, Privacy & Security, make an app password with IMAP and SMTP access. "
                         "It needs a plan above Basic."},
    "zoho": {"name": "Zoho Mail", "domains": ["zoho.com", "zohomail.com"],
             "imap": ["imap.zoho.com", 993, "ssl"], "smtp": ["smtp.zoho.com", 465, "ssl"],
             "password_url": "https://accounts.zoho.com/home#security/app_password",
             "help": "Turn on IMAP Access in the Zoho Mail settings. With two-factor authentication, make an "
                     "app password. A paid domain uses imappro.zoho.com: choose Other IMAP server for it."},
    "gmx": {"name": "GMX", "domains": ["gmx.com", "gmx.us"],
            "imap": ["imap.gmx.com", 993, "ssl"], "smtp": ["mail.gmx.com", 587, "starttls"],
            "password_url": "https://support.gmx.com/security/2fa/application-specific-passwords.html",
            "help": "Turn on POP3 & IMAP in the GMX settings. With two-factor authentication, make an "
                    "application-specific password."},
    "other": {"name": "Other IMAP server", "domains": [], "imap": ["", 993, "ssl"], "smtp": ["", 465, "ssl"],
              "password_url": "", "help": "Enter the settings of your mail service. Outlook.com and Microsoft "
                                          "365 do not take passwords: use the Microsoft Outlook connector."},
}


def mail_command(connector_id: str) -> tuple[str, list[str]] | None:
    """The command of a built-in server, that the MCP client runs in place of the command in mcp.json."""
    connector = CONNECTORS.get(connector_id)
    if connector is None or connector.kind != "mail":
        return None
    if MAIL_COMMAND is not None:
        return MAIL_COMMAND[0], MAIL_COMMAND[1:]
    from .frozen import is_frozen

    if is_frozen():
        return sys.executable, ["--mcp-server", "mail"]
    return sys.executable, ["-m", "harness_daemon", "--mcp-server", "mail"]


def _mail_record(connector_id: str) -> dict[str, Any]:
    record = mcp_auth.read_record(record_key(connector_id))
    accounts = [a for a in record.get("accounts") or []
                if isinstance(a, dict) and isinstance(a.get("login"), str) and isinstance(a.get("password"), str)]
    return {"read_only": bool(record.get("read_only", False)), "accounts": accounts}


def _save_mail_record(connector_id: str, data: dict[str, Any]) -> None:
    mcp_auth.clear_record(record_key(connector_id))
    if data["accounts"]:
        mcp_auth.update_record(record_key(connector_id), source="mail", read_only=data["read_only"],
                               accounts=data["accounts"])


def _mail_account(raw: Any) -> dict[str, Any]:
    """The settings of a new account, from the options of the client and the provider presets."""
    raw = raw if isinstance(raw, dict) else {}
    address = str(raw.get("email") or "").strip()
    password = str(raw.get("password") or "").replace(" ", "")  # Google shows an app password in groups of 4.
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", address):
        raise ConnectorError("Enter the email address.")
    if not password:
        raise ConnectorError("Enter the app password.")
    provider = raw.get("provider") if raw.get("provider") in MAIL_PROVIDERS else "other"
    preset = MAIL_PROVIDERS[provider]
    imap_host, imap_port, imap_security = preset["imap"]
    smtp_host, smtp_port, smtp_security = preset["smtp"]
    if provider == "other":
        imap_host = str(raw.get("imap_host") or "").strip()
        smtp_host = str(raw.get("smtp_host") or "").strip()
        try:
            imap_port = int(raw.get("imap_port") or imap_port)
            smtp_port = int(raw.get("smtp_port") or smtp_port)
        except (TypeError, ValueError):
            raise ConnectorError("The ports must be numbers.") from None
        imap_security = str(raw.get("imap_security") or imap_security)
        smtp_security = str(raw.get("smtp_security") or smtp_security)
        if not imap_host:
            raise ConnectorError("Enter the IMAP server of your mail service.")
    return {"login": address, "type": provider, "password": password,
            "imap_host": imap_host, "imap_port": imap_port, "imap_security": imap_security,
            "smtp_host": smtp_host, "smtp_port": smtp_port, "smtp_security": smtp_security}


def _server_account(account: dict[str, Any]) -> dict[str, Any]:
    """An account as mail_server.Account takes it."""
    return {"email": account["login"], **{k: v for k, v in account.items() if k not in ("login", "type")}}


async def add_mail_account(connector: Connector, options: Any) -> str:
    """Check the login of one more account (IMAP, and SMTP unless read-only), and keep it. Return the address."""
    from . import mail_server

    raw = options if isinstance(options, dict) else {}
    data = _mail_record(connector.id)
    read_only = bool(raw.get("read_only", False)) if not data["accounts"] else data["read_only"]
    account = _mail_account(raw)
    _, servers = _user_file()
    _check_free(servers, connector)
    try:
        await asyncio.to_thread(mail_server.check_account,
                                mail_server.Account.from_json(_server_account(account)), not read_only)
    except mail_server.MailError as e:
        raise ConnectorError(str(e)) from None
    data["accounts"] = [a for a in data["accounts"] if a["login"].lower() != account["login"].lower()]
    data["accounts"].append(account)
    data["read_only"] = read_only
    _save_mail_record(connector.id, data)
    install(connector)
    return account["login"]


def server_env(connector_id: str) -> dict[str, str]:
    """The secret environment of a connector server, that the MCP client adds at each start. mcp.json has none."""
    connector = CONNECTORS.get(connector_id)
    if connector is None or connector.kind != "mail":
        return {}
    data = _mail_record(connector_id)
    return {"HARNESS_MAIL_ACCOUNTS": json.dumps([_server_account(a) for a in data["accounts"]]),
            "HARNESS_MAIL_READ_ONLY": "1" if data["read_only"] else "0"}


def remove_retired() -> list[str]:
    """Remove the mcp.json entries and the records of the retired connectors. Return the removed names."""
    try:
        data, servers = _user_file()
    except ConfigError:
        return []
    removed = [name for name, entry in list(servers.items())
               if isinstance(entry, dict) and entry.get("connector") in RETIRED]
    for name in removed:
        del servers[name]
    if removed:
        write_json(harness_home() / "mcp.json", data)
    for connector_id in RETIRED:
        mcp_auth.clear_record(record_key(connector_id))
        folder = harness_home() / "connectors" / connector_id
        if folder.is_dir():
            shutil.rmtree(folder, ignore_errors=True)  # The Gmail credential files of Harness 0.1.44.
    return removed


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
    if connector.kind == "mail":
        name = connector.id
        entry: dict[str, Any] = {"command": "harness-daemon", "args": ["--mcp-server", "mail"],
                                 "connector": connector.id}
    elif connector.kind == "device":
        name = server_name(connector, group or "personal")
        command, args, env = server_command(connector, group or "personal", read_only)
        entry = {"command": command, "args": args}
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
    if connector.kind == "mail":
        mail = _mail_record(connector.id)
        accounts = [{"login": a["login"], "type": a.get("type", "other"), "read_only": mail["read_only"]}
                    for a in mail["accounts"]]
        body.update({"source": "mail" if accounts else None, "login": accounts[0]["login"] if accounts else None,
                     "accounts": accounts, "url": "", "providers": [
                         {"id": key, "name": value["name"], "domains": value["domains"],
                          "imap": value["imap"], "smtp": value["smtp"], "password_url": value["password_url"],
                          "help": value["help"]} for key, value in MAIL_PROVIDERS.items()]})
    elif connector.kind == "device":
        data = _device_record(connector.id)
        accounts = [{**a, "read_only": data["read_only"][a["type"]]} for a in data["accounts"]]
        body.update({"source": "device" if accounts else None, "login": accounts[0]["login"] if accounts else None,
                     "accounts": accounts, "url": connector.home_url, "package": connector.package})
    else:
        source = record.get("source") if record.get("source") in ("gh", "token") else None
        body.update({"source": source, "login": record.get("login") if source else None, "url": connector.url,
                     "gh_available": gh, "token_url": connector.token_url, "token_help": connector.token_help})
    return body


async def items() -> dict[str, Any]:
    remove_retired()
    gh = await asyncio.to_thread(gh_token) is not None
    return {"type": "connectors", "items": [_status(c, gh) for c in CONNECTORS.values()]}


async def connect(connector_id: str, source: str, pasted: str | None = None, *,
                  options: Any = None, on_code: OnCode | None = None) -> str:
    """Sign in, keep the record, and add the server to ~/.harness/mcp.json. Return the account name.

    A "token" connector takes the source "gh" or "token" (with ``pasted``). A "device" connector takes
    the source "device", the options, and ``on_code`` for the device code. It adds one more account.
    """
    connector = get(connector_id)
    allowed = {"device": ("device",), "mail": ("mail",)}.get(connector.kind, ("gh", "token"))
    if source not in allowed:
        raise ConfigError(f"The token source of {connector.name} must be one of: {', '.join(allowed)}.")
    if connector.kind == "mail":
        return await add_mail_account(connector, options)
    if connector.kind == "device":
        async def no_code(url: str, code: str) -> None:
            return None

        return await add_account(connector, options, on_code or no_code)
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
    mcp_auth.clear_record(record_key(connector_id))
    uninstall(connector_id)
