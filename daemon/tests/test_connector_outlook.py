"""Tests for the Outlook connector (connectors.py, the kind "device"), with a fake ms-365-mcp-server."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from harness_daemon import connectors, mcp_auth
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
    monkeypatch.delenv("FAKE_MS365_APPROVE", raising=False)
    monkeypatch.delenv("FAKE_MS365_FAIL", raising=False)
    return log


def runs(log: Path) -> list[dict]:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]


def user_servers() -> dict:
    return json.loads((mcp_auth.store_path().parent / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]


def test_the_real_command():
    command, args, env = connectors.server_command(connectors.OUTLOOK, {"account": "personal", "read_only": False})
    assert command == "npx"
    assert args == ["-y", "@softeria/ms-365-mcp-server@0.179.1", "--preset", "outlook"]
    assert env == {"MS365_MCP_TENANT_ID": "consumers"}
    _, args, env = connectors.server_command(connectors.OUTLOOK, {"account": "work", "read_only": True})
    assert args[-2:] == ["--org-mode", "--read-only"] and env == {}


def test_sign_in_with_a_personal_account(fake_outlook):
    codes: list[tuple[str, str]] = []

    async def on_code(url: str, code: str) -> None:
        codes.append((url, code))

    login = asyncio.run(connectors.connect("outlook", "device", options={"account": "personal"}, on_code=on_code))
    assert login == "pat@outlook.com"
    assert codes == [("https://microsoft.com/devicelogin", "FAKE1234X")]
    assert runs(fake_outlook) == [{"args": ["--preset", "outlook", "--login"], "tenant": "consumers"}]
    entry = user_servers()["outlook"]
    assert entry == {"command": PYTHON, "args": [FAKE, "--preset", "outlook"],
                     "env": {"MS365_MCP_TENANT_ID": "consumers"}, "connector": "outlook"}
    record = mcp_auth.read_record(connectors.record_key("outlook"))
    assert record == {"source": "device", "login": "pat@outlook.com",
                      "options": {"account": "personal", "read_only": False}}
    status = next(i for i in asyncio.run(connectors.items())["items"] if i["id"] == "outlook")
    assert (status["kind"], status["source"], status["login"], status["options"]) == (
        "device", "device", "pat@outlook.com", {"account": "personal", "read_only": False})

    asyncio.run(connectors.disconnect("outlook"))
    assert runs(fake_outlook)[-1]["args"][-1] == "--logout"
    assert "outlook" not in user_servers()
    assert mcp_auth.read_record(connectors.record_key("outlook")) == {}


def test_a_work_account_that_is_read_only(fake_outlook):
    asyncio.run(connectors.connect("outlook", "device", options={"account": "work", "read_only": True}))
    assert runs(fake_outlook)[0] == {"args": ["--preset", "outlook", "--org-mode", "--read-only", "--login"],
                                     "tenant": None}
    assert "env" not in user_servers()["outlook"]


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


def test_the_device_server_connects(fake_outlook, project):
    asyncio.run(connectors.connect("outlook", "device"))
    servers, problems = load_mcp_config(project)
    assert problems == [] and servers["outlook"].connector == "outlook" and servers["outlook"].transport == "stdio"

    async def main() -> None:
        box: dict = {"tools": []}

        async def emit(event: dict) -> None:
            return None

        manager = McpManager(project, emit, lambda tools: box.__setitem__("tools", tools))
        try:
            await manager.start()
            assert manager.servers["outlook"].state == "connected", manager.servers["outlook"].error
            echo = next(t for t in box["tools"] if t.name == "mcp__outlook__echo")
            assert (await echo.run({"text": "mail"}, None)).output == "mail"
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


def test_device_code_messages(daemon, project, fake_model, fake_outlook):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "connectors.connect", "id": "outlook", "source": "device",
            "options": {"account": "personal", "read_only": True}})
    code = c.until("connectors.device_code", timeout=30)[0]
    assert code == {"type": "connectors.device_code", "id": "outlook",
                    "url": "https://microsoft.com/devicelogin", "code": "FAKE1234X"}
    listing = c.until("connectors", timeout=30)[0]
    outlook = next(i for i in listing["items"] if i["id"] == "outlook")
    assert outlook["login"] == "pat@outlook.com" and outlook["options"]["read_only"] is True
    status = c.until("mcp", timeout=60)[0]
    while not any(i["name"] == "outlook" and i["state"] == "connected" for i in status["items"]):
        status = c.until("mcp", timeout=60)[0]

    c.send({"type": "connectors.disconnect", "id": "outlook"})
    listing = c.until("connectors", timeout=30)[0]
    assert next(i for i in listing["items"] if i["id"] == "outlook")["source"] is None
    c.close()
