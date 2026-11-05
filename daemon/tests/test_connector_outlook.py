"""Tests for the Outlook connector (connectors.py, the kind "device"), with a fake ms-365-mcp-server."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from harness_daemon import connectors, mcp_auth
from harness_daemon.config import harness_home
from harness_daemon.mcp_client import McpManager, load_mcp_config

from test_mcp import PYTHON, write_config
from test_server import Client, daemon  # noqa: F401 - the daemon fixture

FAKE = (Path(__file__).parent / "fake_ms365.py").as_posix()


@pytest.fixture
def fake_outlook(harness_home, monkeypatch, tmp_path):
    """The Outlook connector runs fake_ms365.py instead of npx. Return the log file of its runs."""
    monkeypatch.setattr(connectors, "NPX", [PYTHON, FAKE])
    log = tmp_path / "ms365.log"
    monkeypatch.setenv("FAKE_MS365_LOG", str(log))
    for name in ("FAKE_MS365_APPROVE", "FAKE_MS365_FAIL", "FAKE_MS365_USER"):
        monkeypatch.delenv(name, raising=False)
    return log


def runs(log: Path) -> list[dict]:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]


def user_servers() -> dict:
    return json.loads((harness_home() / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]


def outlook_status() -> dict:
    return next(i for i in asyncio.run(connectors.items())["items"] if i["id"] == "outlook")


def sign_in(monkeypatch, user: str, account: str = "personal", read_only: bool = False) -> str:
    monkeypatch.setenv("FAKE_MS365_USER", user)
    return asyncio.run(connectors.connect("outlook", "device", options={"account": account, "read_only": read_only}))


def test_the_real_command(harness_home):
    command, args, env = connectors.server_command(connectors.OUTLOOK, "personal", False)
    assert command == "npx"
    assert args == ["-y", "@softeria/ms-365-mcp-server@0.179.1", "--preset", "outlook"]
    cache = harness_home / "connectors" / "outlook-personal"
    assert env == {"MS365_MCP_TENANT_ID": "consumers",
                   "MS365_MCP_TOKEN_CACHE_PATH": str(cache / ".token-cache.json"),
                   "MS365_MCP_SELECTED_ACCOUNT_PATH": str(cache / ".selected-account.json")}
    _, args, env = connectors.server_command(connectors.OUTLOOK, "work", True)
    assert args[-2:] == ["--org-mode", "--read-only"] and "MS365_MCP_TENANT_ID" not in env
    assert "outlook-work" in env["MS365_MCP_TOKEN_CACHE_PATH"]
    assert connectors.server_names("outlook") == ["outlook", "outlook-work"]
    assert connectors.server_names("github") == ["github"]


def test_sign_in_with_a_personal_account(fake_outlook):
    codes: list[tuple[str, str]] = []

    async def on_code(url: str, code: str) -> None:
        codes.append((url, code))

    login = asyncio.run(connectors.connect("outlook", "device", options={"account": "personal"}, on_code=on_code))
    assert login == "pat@outlook.com"
    assert codes == [("https://microsoft.com/devicelogin", "FAKE1234X")]
    assert [r["args"][-1] for r in runs(fake_outlook)] == ["--list-accounts", "--login", "--list-accounts"]
    assert all(r["tenant"] == "consumers" and "outlook-personal" in r["cache"] for r in runs(fake_outlook))
    entry = user_servers()["outlook"]
    assert entry["command"] == PYTHON and entry["args"] == [FAKE, "--preset", "outlook"]
    assert entry["connector"] == "outlook" and entry["env"]["MS365_MCP_TENANT_ID"] == "consumers"
    status = outlook_status()
    assert (status["kind"], status["source"], status["login"]) == ("device", "device", "pat@outlook.com")
    assert status["accounts"] == [{"login": "pat@outlook.com", "type": "personal", "read_only": False}]


def test_several_accounts(fake_outlook, monkeypatch):
    assert sign_in(monkeypatch, "pat@outlook.com") == "pat@outlook.com"
    # The server reports the selected account (pat). Harness finds the new account in the list.
    assert sign_in(monkeypatch, "sam@outlook.com") == "sam@outlook.com"
    assert sign_in(monkeypatch, "jo@contoso.com", account="work", read_only=True) == "jo@contoso.com"
    sign_in(monkeypatch, "sam@outlook.com")  # Again: the list has no second copy.
    assert outlook_status()["accounts"] == [
        {"login": "jo@contoso.com", "type": "work", "read_only": True},
        {"login": "pat@outlook.com", "type": "personal", "read_only": False},
        {"login": "sam@outlook.com", "type": "personal", "read_only": False},
    ]
    servers = user_servers()
    assert set(servers) == {"outlook", "outlook-work"}  # One server for each account type.
    assert servers["outlook-work"]["args"][-2:] == ["--org-mode", "--read-only"]
    assert "outlook-work" in servers["outlook-work"]["env"]["MS365_MCP_TOKEN_CACHE_PATH"]

    asyncio.run(connectors.remove_account("outlook", "SAM@outlook.com"))
    assert runs(fake_outlook)[-1]["args"][-2:] == ["--remove-account", "sam@outlook.com"]
    assert [a["login"] for a in outlook_status()["accounts"]] == ["jo@contoso.com", "pat@outlook.com"]
    assert set(user_servers()) == {"outlook", "outlook-work"}

    asyncio.run(connectors.remove_account("outlook", "jo@contoso.com"))
    assert set(user_servers()) == {"outlook"}  # The last work account: its server goes away.
    with pytest.raises(connectors.ConnectorError, match="no account"):
        asyncio.run(connectors.remove_account("outlook", "nobody@outlook.com"))

    asyncio.run(connectors.disconnect("outlook"))
    assert runs(fake_outlook)[-1]["args"][-1] == "--logout"
    assert user_servers() == {}
    assert outlook_status()["accounts"] == [] and outlook_status()["source"] is None


def test_a_failed_sign_in(fake_outlook, monkeypatch):
    monkeypatch.setenv("FAKE_MS365_FAIL", "1")
    with pytest.raises(connectors.ConnectorError, match="denied the sign-in"):
        asyncio.run(connectors.connect("outlook", "device"))
    assert not connectors.installed("outlook")
    with pytest.raises(Exception, match="source of Microsoft Outlook"):
        asyncio.run(connectors.connect("outlook", "token", "abc"))
    with pytest.raises(Exception, match="account must be"):
        asyncio.run(connectors.connect("outlook", "device", options={"account": "school"}))


def test_cancel_a_sign_in(fake_outlook, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_MS365_APPROVE", str(tmp_path / "never"))

    async def main() -> None:
        shown = asyncio.Event()

        async def on_code(url: str, code: str) -> None:
            shown.set()

        task = asyncio.create_task(connectors.connect("outlook", "device", on_code=on_code))
        await asyncio.wait_for(shown.wait(), 30)
        assert next(i for i in (await connectors.items())["items"] if i["id"] == "outlook")["signing_in"]
        assert connectors.cancel("outlook")
        with pytest.raises(connectors.ConnectorError, match="cancelled"):
            await asyncio.wait_for(task, 30)
        assert not connectors.cancel("outlook")
        assert not connectors.installed("outlook")

    asyncio.run(main())


def test_the_device_servers_connect(fake_outlook, project, monkeypatch):
    sign_in(monkeypatch, "pat@outlook.com")
    sign_in(monkeypatch, "jo@contoso.com", account="work")
    servers, problems = load_mcp_config(project)
    assert problems == []
    assert servers["outlook"].connector == "outlook" and servers["outlook-work"].connector == "outlook"

    async def main() -> None:
        box: dict = {"tools": []}

        async def emit(event: dict) -> None:
            return None

        manager = McpManager(project, emit, lambda tools: box.__setitem__("tools", tools))
        try:
            await manager.start()
            for name in ("outlook", "outlook-work"):
                assert manager.servers[name].state == "connected", manager.servers[name].error
            names = {t.name for t in box["tools"]}
            assert {"mcp__outlook__echo", "mcp__outlook-work__echo"} <= names
        finally:
            await manager.close()

    asyncio.run(main())


def test_a_device_connector_needs_a_stdio_entry(harness_home, project):
    write_config(project / ".harness" / "mcp.json", {
        "mail": {"type": "http", "url": "https://x.example/mcp", "connector": "outlook"},
        "gh": {"command": "github-mcp-server", "connector": "github"},
    })
    _, problems = load_mcp_config(project)
    assert any("outlook needs a stdio server" in p for p in problems)
    assert any("github needs a http server" in p for p in problems)


def test_device_code_messages(daemon, project, fake_model, fake_outlook, monkeypatch):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "connectors.connect", "id": "outlook", "source": "device",
            "options": {"account": "personal", "read_only": True}})
    code = c.until("connectors.device_code", timeout=30)[0]
    assert code == {"type": "connectors.device_code", "id": "outlook",
                    "url": "https://microsoft.com/devicelogin", "code": "FAKE1234X"}
    listing = c.until("connectors", timeout=30)[0]
    outlook = next(i for i in listing["items"] if i["id"] == "outlook")
    assert outlook["accounts"] == [{"login": "pat@outlook.com", "type": "personal", "read_only": True}]
    status = c.until("mcp", timeout=60)[0]
    while not any(i["name"] == "outlook" and i["state"] == "connected" for i in status["items"]):
        status = c.until("mcp", timeout=60)[0]

    monkeypatch.setenv("FAKE_MS365_USER", "sam@outlook.com")
    c.send({"type": "connectors.connect", "id": "outlook", "source": "device", "options": {"account": "personal"}})
    listing = c.until("connectors", timeout=30)[0]
    outlook = next(i for i in listing["items"] if i["id"] == "outlook")
    assert [a["login"] for a in outlook["accounts"]] == ["pat@outlook.com", "sam@outlook.com"]

    c.send({"type": "connectors.remove_account", "id": "outlook", "login": "pat@outlook.com"})
    listing = c.until("connectors", timeout=30)[0]
    outlook = next(i for i in listing["items"] if i["id"] == "outlook")
    assert [a["login"] for a in outlook["accounts"]] == ["sam@outlook.com"]

    c.send({"type": "connectors.disconnect", "id": "outlook"})
    listing = c.until("connectors", timeout=30)[0]
    assert next(i for i in listing["items"] if i["id"] == "outlook")["source"] is None
    c.close()
