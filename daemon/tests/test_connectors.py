"""Tests for the connectors (connectors.py): the GitHub token sources, mcp.json, and the MCP connection."""

from __future__ import annotations

import asyncio
import dataclasses
import json
import sys
from pathlib import Path

import pytest

from harness_daemon import connectors, mcp_auth
from harness_daemon.config import ConfigError
from harness_daemon.mcp_client import McpManager, load_mcp_config

from test_mcp import PYTHON, write_config
from test_mcp_auth import oauth_server  # noqa: F401 - the fake server fixture
from test_server import Client, daemon  # noqa: F401 - the daemon fixture


@pytest.fixture
def fake_github(oauth_server, monkeypatch, tmp_path):  # noqa: F811
    """GitHub is the fake server: /user checks the token, and /mcp takes "static-token"."""
    github = dataclasses.replace(connectors.GITHUB, url=f"{oauth_server}/mcp", user_api=f"{oauth_server}/user")
    monkeypatch.setitem(connectors.CONNECTORS, "github", github)
    gh = tmp_path / "fake_gh.py"
    gh.write_text("import sys\nprint('static-token')\n", encoding="utf-8")
    monkeypatch.setattr(connectors, "GH", [PYTHON, gh.as_posix()])
    return github


def user_file() -> dict:
    return json.loads((mcp_auth.store_path().parent / "mcp.json").read_text(encoding="utf-8"))


def test_connect_with_a_token_and_disconnect(harness_home, fake_github):
    login = asyncio.run(connectors.connect("github", "token", " static-token "))
    assert login == "octo"
    entry = user_file()["mcpServers"]["github"]
    assert entry == {"type": "http", "url": fake_github.url, "connector": "github"}
    assert "static-token" not in json.dumps(user_file())  # mcp.json has no token.
    assert connectors.token("github") == "static-token"
    status = asyncio.run(connectors.items())["items"][0]
    assert (status["installed"], status["source"], status["login"], status["gh_available"]) == (
        True, "token", "octo", True)
    assert "token" not in status

    asyncio.run(connectors.disconnect("github"))
    assert "github" not in user_file()["mcpServers"]
    assert connectors.token("github") is None
    assert asyncio.run(connectors.items())["items"][0]["source"] is None


def test_connect_with_the_github_cli(harness_home, fake_github, monkeypatch, tmp_path):
    assert asyncio.run(connectors.connect("github", "gh")) == "octo"
    record = mcp_auth.read_record(connectors.record_key("github"))
    assert record["source"] == "gh" and "token" not in record  # The daemon asks gh at each connection.
    assert connectors.token("github") == "static-token"

    failing = tmp_path / "gh_signed_out.py"
    failing.write_text("import sys\nsys.exit(1)\n", encoding="utf-8")
    monkeypatch.setattr(connectors, "GH", [PYTHON, failing.as_posix()])
    assert connectors.token("github") is None
    with pytest.raises(connectors.ConnectorError, match="gh auth login"):
        asyncio.run(connectors.connect("github", "gh"))


def test_bad_tokens(harness_home, fake_github):
    with pytest.raises(connectors.ConnectorError, match="refused the token"):
        asyncio.run(connectors.connect("github", "token", "wrong"))
    with pytest.raises(connectors.ConnectorError, match="no spaces"):
        asyncio.run(connectors.connect("github", "token", "two words"))
    with pytest.raises(ConfigError, match="token source"):
        asyncio.run(connectors.connect("github", "keychain"))
    assert not connectors.installed("github")


def test_a_server_with_the_same_name_stays(harness_home, fake_github):
    write_config(mcp_auth.store_path().parent / "mcp.json", {"github": {"command": "github-mcp-server"}})
    with pytest.raises(connectors.ConnectorError, match="already has a server named 'github'"):
        asyncio.run(connectors.connect("github", "token", "static-token"))
    assert user_file()["mcpServers"]["github"] == {"command": "github-mcp-server"}
    assert not connectors.uninstall("github")


def test_config_of_a_connector_server(harness_home, project):
    write_config(project / ".harness" / "mcp.json", {
        "gh": {"type": "http", "url": "https://x.example/mcp", "connector": "github"},
        "bad": {"type": "http", "url": "https://x.example/mcp", "connector": "nope"},
    })
    servers, problems = load_mcp_config(project)
    assert servers["gh"].connector == "github" and servers["gh"].oauth is None
    assert any("unknown connector" in p for p in problems)


def test_the_mcp_server_uses_the_token(harness_home, project, fake_github):
    async def main() -> None:
        events: list[dict] = []
        box: dict = {"tools": []}

        async def emit(event: dict) -> None:
            events.append(event)

        # The entry is in mcp.json, but the user did not connect GitHub yet.
        connectors.install(fake_github)
        manager = McpManager(project, emit, lambda tools: box.__setitem__("tools", tools))
        try:
            await manager.start()
            s = manager.servers["github"]
            assert s.state == "needs_auth" and s.error == "Connect GitHub on the Connectors tab."
            assert manager.items()["items"][0]["connector"] == "github"
            with pytest.raises(Exception, match="connect GitHub on the Connectors tab"):
                await manager.call("github", "echo", {"text": "x"})

            await connectors.connect("github", "token", "static-token")
            await manager.restart("github")
            assert manager.servers["github"].state == "connected", manager.servers["github"].error
            echo = next(t for t in box["tools"] if t.name == "mcp__github__echo")
            assert (await echo.run({"text": "via connector"}, None)).output == "via connector"

            # A token that the service refuses.
            mcp_auth.update_record(connectors.record_key("github"), token="revoked")
            await manager.restart("github")
            s = manager.servers["github"]
            assert s.state == "needs_auth" and "refused the token" in (s.error or ""), s.error

            # Disconnect: the server leaves the session.
            await connectors.disconnect("github")
            await manager.restart("github")
            assert "github" not in manager.servers
            assert not any(t.name.startswith("mcp__github__") for t in box["tools"])
        finally:
            await manager.close()

    asyncio.run(main())


def test_connector_messages(daemon, project, fake_model, fake_github):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "connectors.list"})
    listing = c.until("connectors")[0]
    assert [i["id"] for i in listing["items"]] == ["github", "outlook", "email"]
    assert listing["items"][0]["installed"] is False

    c.send({"type": "connectors.connect", "id": "github", "source": "token", "token": "wrong"})
    error, _ = c.until("error", timeout=30)
    assert error["ref"] == "connectors.connect" and "refused" in error["message"]

    c.send({"type": "connectors.connect", "id": "github", "source": "gh"})
    listing = c.until("connectors", timeout=30)[0]
    assert listing["items"][0]["login"] == "octo"
    status = c.until("mcp", timeout=60)[0]
    while not any(i["name"] == "github" and i["state"] == "connected" for i in status["items"]):
        status = c.until("mcp", timeout=60)[0]

    c.send({"type": "connectors.disconnect", "id": "github"})
    assert c.until("connectors")[0]["items"][0]["installed"] is False
    status = c.until("mcp", timeout=30)[0]
    assert not any(i["name"] == "github" for i in status["items"])
    c.close()
