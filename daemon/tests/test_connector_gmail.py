"""Tests for the Gmail connector (the kind "google"), and the removal of the old Chrome connector."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

from harness_daemon import connectors, mcp_auth
from harness_daemon.config import harness_home
from harness_daemon.mcp_client import McpManager

from test_mcp import PYTHON
from test_mcp_auth import oauth_server  # noqa: F401 - the fake OAuth server fixture
from test_server import Client, daemon  # noqa: F401 - the daemon fixture

FAKE_WORKSPACE = (Path(__file__).parent / "fake_workspace_mcp.py").as_posix()
CLIENT = {"client_id": "fixed-client", "client_secret": "s3cret"}


@pytest.fixture
def fake_google(oauth_server, monkeypatch):  # noqa: F811
    """Google is the fake OAuth server, and workspace-mcp is fake_workspace_mcp.py."""
    monkeypatch.setattr(connectors, "GOOGLE_AUTH_URL", f"{oauth_server}/authorize")
    monkeypatch.setattr(connectors, "GOOGLE_TOKEN_URL", f"{oauth_server}/token")
    monkeypatch.setattr(connectors, "GOOGLE_USERINFO_URL", f"{oauth_server}/userinfo")
    monkeypatch.setattr(connectors, "GOOGLE_REVOKE_URL", f"{oauth_server}/revoke")
    monkeypatch.setattr(connectors, "UVX", [PYTHON, FAKE_WORKSPACE])
    return oauth_server


async def browser(url: str) -> None:
    """The browser: the fake sign-in page sends it to the callback of the daemon at once."""
    async def go() -> None:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            await client.get(url)
    asyncio.ensure_future(go())


def gmail_status(items: dict | None = None) -> dict:
    items = items or asyncio.run(connectors.items())
    return next(i for i in items["items"] if i["id"] == "gmail")


def user_servers() -> dict:
    return json.loads((harness_home() / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]


def test_gmail_accounts(harness_home, fake_google):
    login = asyncio.run(connectors.connect("gmail", "google", options={**CLIENT, "read_only": False}, on_url=browser))
    assert login == "pat@gmail.com"
    creds = json.loads(connectors.credential_path(connectors.GMAIL, "pat@gmail.com").read_text(encoding="utf-8"))
    assert creds["client_id"] == "fixed-client" and creds["client_secret"] == "s3cret" and creds["refresh_token"]
    assert "https://www.googleapis.com/auth/gmail.send" in creds["scopes"]
    entry = user_servers()["gmail"]
    assert entry["command"] == PYTHON and entry["args"] == [FAKE_WORKSPACE, "--tools", "gmail"]
    assert entry["env"] == {"WORKSPACE_MCP_CREDENTIALS_DIR": str(connectors.credentials_dir(connectors.GMAIL))}
    assert "s3cret" not in json.dumps(user_servers())  # mcp.json has no secret.
    assert connectors.server_env("gmail") == {"GOOGLE_OAUTH_CLIENT_ID": "fixed-client",
                                              "GOOGLE_OAUTH_CLIENT_SECRET": "s3cret"}
    status = gmail_status()
    assert status["accounts"] == [{"login": "pat@gmail.com", "type": "google", "read_only": False}]
    assert status["client_id"] == "fixed-client" and "client_secret" not in status

    # A second account uses the client that Harness keeps.
    httpx.get(f"{fake_google}/set-email", params={"email": "sam@gmail.com"})
    assert asyncio.run(connectors.connect("gmail", "google", on_url=browser)) == "sam@gmail.com"
    assert [a["login"] for a in gmail_status()["accounts"]] == ["pat@gmail.com", "sam@gmail.com"]

    asyncio.run(connectors.remove_account("gmail", "pat@gmail.com"))
    assert not connectors.credential_path(connectors.GMAIL, "pat@gmail.com").exists()
    assert httpx.get(f"{fake_google}/revoked").json() == [creds["refresh_token"]]
    assert [a["login"] for a in gmail_status()["accounts"]] == ["sam@gmail.com"]

    asyncio.run(connectors.disconnect("gmail"))
    assert "gmail" not in user_servers()
    assert not connectors.credential_path(connectors.GMAIL, "sam@gmail.com").exists()
    assert gmail_status()["source"] is None and gmail_status()["client_id"] is None


def test_gmail_read_only_and_errors(harness_home, fake_google):
    with pytest.raises(connectors.ConnectorError, match="client ID and the client secret"):
        asyncio.run(connectors.connect("gmail", "google", on_url=browser))
    asyncio.run(connectors.connect("gmail", "google", options={**CLIENT, "read_only": True}, on_url=browser))
    creds = json.loads(connectors.credential_path(connectors.GMAIL, "pat@gmail.com").read_text(encoding="utf-8"))
    assert [s for s in creds["scopes"] if "gmail" in s] == ["https://www.googleapis.com/auth/gmail.readonly"]
    assert user_servers()["gmail"]["args"][-1] == "--read-only"
    with pytest.raises(connectors.ConnectorError, match="another OAuth client"):
        asyncio.run(connectors.connect("gmail", "google", options={"client_id": "other", "client_secret": "x"},
                                       on_url=browser))


def test_gmail_cancel_and_paste(harness_home, fake_google):
    async def main() -> None:
        urls: list[str] = []
        shown = asyncio.Event()

        async def on_url(url: str) -> None:
            urls.append(url)
            shown.set()

        task = asyncio.create_task(connectors.connect("gmail", "google", options=CLIENT, on_url=on_url))
        await asyncio.wait_for(shown.wait(), 10)
        assert (await connectors.items())["items"][2]["signing_in"]
        assert connectors.cancel("gmail")
        with pytest.raises(connectors.ConnectorError, match="cancelled"):
            await asyncio.wait_for(task, 10)

        # A remote daemon: the browser cannot open the callback. The user pastes its URL.
        shown.clear()
        task = asyncio.create_task(connectors.connect("gmail", "google", options=CLIENT, on_url=on_url))
        await asyncio.wait_for(shown.wait(), 10)
        async with httpx.AsyncClient() as client:
            answer = await client.get(urls[-1])
        assert answer.status_code == 302
        assert connectors.google_code("gmail", "no code here") is not None
        assert connectors.google_code("gmail", answer.headers["location"]) is None
        assert await asyncio.wait_for(task, 10) == "pat@gmail.com"

    asyncio.run(main())


def test_the_gmail_server_gets_the_secret(harness_home, fake_google, project):
    asyncio.run(connectors.connect("gmail", "google", options=CLIENT, on_url=browser))

    async def main() -> None:
        box: dict = {"tools": []}

        async def emit(event: dict) -> None:
            return None

        manager = McpManager(project, emit, lambda tools: box.__setitem__("tools", tools))
        try:
            await manager.start()
            assert manager.servers["gmail"].state == "connected", manager.servers["gmail"].error
            secret = next(t for t in box["tools"] if t.name == "mcp__gmail__secret")
            assert (await secret.run({}, None)).output == "s3cret"
        finally:
            await manager.close()

    asyncio.run(main())


def test_the_retired_chrome_connector(harness_home, project):
    """Harness 0.1.44 had a Chrome connector. Its entry gives a clear message, and the Connectors tab removes it."""
    from harness_daemon.mcp_client import load_mcp_config

    path = harness_home / "mcp.json"
    path.write_text(json.dumps({"mcpServers": {
        "chrome": {"command": "npx", "args": ["-y", "chrome-devtools-mcp@1.12.0"], "connector": "chrome"},
        "mine": {"command": "my-server"},
    }}), encoding="utf-8")
    mcp_auth.update_record(connectors.record_key("chrome"), source="local", options={"profile": "own"})
    servers, problems = load_mcp_config(project)
    assert "chrome" not in servers and "mine" in servers
    assert any("no longer has the Chrome" in p for p in problems)

    items = asyncio.run(connectors.items())["items"]
    assert [i["id"] for i in items] == ["github", "outlook", "gmail"]
    assert list(user_servers()) == ["mine"]  # The other server stays.
    assert mcp_auth.read_record(connectors.record_key("chrome")) == {}
    with pytest.raises(Exception):
        asyncio.run(connectors.connect("chrome", "local"))


def test_gmail_messages(daemon, project, fake_model, fake_google):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "connectors.connect", "id": "gmail", "source": "google", "options": CLIENT})
    url = c.until("connectors.auth_url", timeout=30)[0]["url"]
    assert url.startswith(f"{fake_google}/authorize?")
    httpx.get(url, follow_redirects=True)  # The browser.
    listing = c.until("connectors", timeout=30)[0]
    assert gmail_status(listing)["accounts"][0]["login"] == "pat@gmail.com"
    status = c.until("mcp", timeout=60)[0]
    while not any(i["name"] == "gmail" and i["state"] == "connected" for i in status["items"]):
        status = c.until("mcp", timeout=60)[0]
    c.send({"type": "connectors.disconnect", "id": "gmail"})
    assert gmail_status(c.until("connectors", timeout=30)[0])["source"] is None
    c.close()


def test_gmail_with_the_harness_client(harness_home, fake_google, monkeypatch):
    monkeypatch.delenv("HARNESS_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("HARNESS_GOOGLE_CLIENT_SECRET", raising=False)
    # A build with no client: the module _google_client cannot be imported (a local copy can have values).
    monkeypatch.setitem(sys.modules, "harness_daemon._google_client", None)
    assert gmail_status()["builtin_client"] is False
    with pytest.raises(connectors.ConnectorError, match="has no Google client"):
        asyncio.run(connectors.connect("gmail", "google", options={"builtin": True}, on_url=browser))

    monkeypatch.setenv("HARNESS_GOOGLE_CLIENT_ID", "fixed-client")
    monkeypatch.setenv("HARNESS_GOOGLE_CLIENT_SECRET", "built-in-secret")
    assert asyncio.run(connectors.connect("gmail", "google", options={"builtin": True}, on_url=browser)) == "pat@gmail.com"
    record = mcp_auth.read_record(connectors.record_key("gmail"))
    assert record["builtin"] is True and "client_secret" not in record  # The secret stays in the build.
    assert connectors.server_env("gmail")["GOOGLE_OAUTH_CLIENT_SECRET"] == "built-in-secret"
    status = gmail_status()
    assert (status["builtin_client"], status["client_builtin"], status["client_id"]) == (True, True, None)

    # A second account uses the Harness client again, with no options.
    httpx.get(f"{fake_google}/set-email", params={"email": "sam@gmail.com"})
    assert asyncio.run(connectors.connect("gmail", "google", on_url=browser)) == "sam@gmail.com"


def test_the_harness_client_from_the_module(monkeypatch):
    import types

    monkeypatch.delenv("HARNESS_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("HARNESS_GOOGLE_CLIENT_SECRET", raising=False)
    module = types.ModuleType("harness_daemon._google_client")
    module.CLIENT_ID, module.CLIENT_SECRET = "id.apps.googleusercontent.com", "secret"
    monkeypatch.setitem(sys.modules, "harness_daemon._google_client", module)
    assert connectors.builtin_google_client() == ("id.apps.googleusercontent.com", "secret")
    module.CLIENT_SECRET = ""  # The empty file in a checkout: no Harness client.
    assert connectors.builtin_google_client() is None
    monkeypatch.setenv("HARNESS_GOOGLE_CLIENT_ID", "env-id")
    monkeypatch.setenv("HARNESS_GOOGLE_CLIENT_SECRET", "env-secret")
    assert connectors.builtin_google_client() == ("env-id", "env-secret")  # The environment wins.
