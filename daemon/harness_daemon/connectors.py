"""Connectors: MCP servers that the Connectors tab of the Capabilities page sets up in one step.

A connector is an MCP server entry in the user file ``~/.harness/mcp.json`` with a ``connector``
key, and a token in ``~/.harness/mcp-auth.json`` (the store of mcp_auth.py, which only the user can
read). ``mcp.json`` never has the token::

    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "connector": "github" }

The MCP client asks ``token()`` for the token at each connection, and sends it as
``Authorization: Bearer <token>``.

GitHub has two token sources:

- ``gh``: the token of the GitHub CLI (``gh auth token``) on the daemon computer. The daemon reads
  it again at each connection, so a new ``gh auth login`` takes effect at the next restart.
- ``token``: a personal access token that the user pastes.

GitHub has no dynamic client registration, so the OAuth flow of mcp_auth.py does not work for it
without a registered OAuth app. The ``oauth`` key in ``mcp.json`` is for that case.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Any

import httpx

from . import mcp_auth
from .config import ConfigError, harness_home, read_json, write_json

GH_TIMEOUT = 10
SOURCES = ("gh", "token")


class ConnectorError(Exception):
    """A connector could not connect. The text is for the user."""


@dataclass(frozen=True)
class Connector:
    id: str
    name: str
    description: str
    url: str  # The MCP server.
    user_api: str  # An API that returns the account of the token, to check the token.
    token_url: str  # The page where the user makes a token.
    token_help: str


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

CONNECTORS: dict[str, Connector] = {GITHUB.id: GITHUB}

# The GitHub CLI command. Tests replace it.
GH: list[str] | None = None


def get(connector_id: str) -> Connector:
    connector = CONNECTORS.get(connector_id)
    if connector is None:
        raise ConfigError(f"Unknown connector: {connector_id}")
    return connector


def record_key(connector_id: str) -> str:
    return f"connector {connector_id}"


# -- tokens --------------------------------------------------------------------------------------------


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
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        result = subprocess.run([*command, "auth", "token", "--hostname", "github.com"], capture_output=True,
                                text=True, timeout=GH_TIMEOUT, stdin=subprocess.DEVNULL, **kwargs)
    except (OSError, subprocess.TimeoutExpired):
        return None
    token = result.stdout.strip()
    return token if result.returncode == 0 and token else None


def token(connector_id: str) -> str | None:
    """The token of a connector for a connection, or None if the user did not connect it. Blocks: use a thread."""
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


def install(connector: Connector) -> None:
    """Add the server entry to ~/.harness/mcp.json. Keep an entry of this connector that is already there."""
    data, servers = _user_file()
    entry = servers.get(connector.id)
    if isinstance(entry, dict) and entry.get("connector") == connector.id:
        if entry.get("disabled") or entry.get("enabled") is False:
            entry.pop("disabled", None)
            entry.pop("enabled", None)
            write_json(harness_home() / "mcp.json", data)
        return
    if entry is not None:
        raise ConnectorError(f"~/.harness/mcp.json already has a server named '{connector.id}'. "
                             "Rename it or remove it, then connect again.")
    servers[connector.id] = {"type": "http", "url": connector.url, "connector": connector.id}
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
    return {
        "id": connector.id, "name": connector.name, "description": connector.description, "url": connector.url,
        "installed": installed(connector.id), "source": source,
        "login": record.get("login") if source else None,
        "gh_available": gh, "token_url": connector.token_url, "token_help": connector.token_help,
    }


async def items() -> dict[str, Any]:
    gh = await asyncio.to_thread(gh_token) is not None
    return {"type": "connectors", "items": [_status(c, gh) for c in CONNECTORS.values()]}


async def connect(connector_id: str, source: str, pasted: str | None = None) -> str:
    """Check the token, keep it, and add the server to ~/.harness/mcp.json. Return the account name."""
    connector = get(connector_id)
    if source not in SOURCES:
        raise ConfigError(f"The token source must be one of: {', '.join(SOURCES)}.")
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


def disconnect(connector_id: str) -> None:
    """Remove the token and the server entry."""
    get(connector_id)
    mcp_auth.clear_record(record_key(connector_id))
    uninstall(connector_id)
