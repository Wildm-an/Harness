"""Tests for OAuth of the MCP servers (mcp_auth.py): the configuration, the callback, and the full sign-in."""

from __future__ import annotations

import asyncio
import json
import socket
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from harness_daemon import mcp_auth
from harness_daemon.config import ConfigError
from harness_daemon.mcp_client import McpManager, load_mcp_config

from test_mcp import PYTHON, SERVER, free_port, write_config


def http_entry(url: str, **extra) -> dict:
    return {"type": "http", "url": url, **extra}


# -- the configuration ---------------------------------------------------------------------------


def test_oauth_config(harness_home, project, monkeypatch):
    monkeypatch.setenv("GH_SECRET", "s3cret")
    write_config(project / ".harness" / "mcp.json", {
        "auto": http_entry("https://a.example/mcp"),
        "header": http_entry("https://b.example/mcp", headers={"Authorization": "Bearer x"}),
        "off": http_entry("https://c.example/mcp", oauth=False),
        "fixed": http_entry("https://d.example/mcp", oauth={
            "client_id": "abc", "client_secret": "${GH_SECRET}", "scopes": "repo read:org", "callback_port": 33418}),
        "local": {"command": "python", "args": ["x.py"]},
    })
    servers, problems = load_mcp_config(project)
    assert problems == []
    assert servers["auto"].oauth == mcp_auth.OAuthConfig()
    assert servers["header"].oauth is None
    assert servers["off"].oauth is None
    assert servers["local"].oauth is None
    fixed = servers["fixed"].oauth
    assert fixed is not None
    assert (fixed.client_id, fixed.client_secret, fixed.scopes, fixed.callback_port) == (
        "abc", "s3cret", ["repo", "read:org"], 33418)


@pytest.mark.parametrize("oauth, text", [
    ("yes", "must be true, false, or an object"),
    ({"client_secret": "x"}, "needs 'oauth.client_id'"),
    ({"callback_port": 80}, "callback_port"),
    ({"scopes": [1]}, "list of strings"),
])
def test_oauth_config_errors(oauth, text):
    with pytest.raises(ConfigError, match=text):
        mcp_auth.parse_oauth("x", oauth, {}, lambda v: v)


def test_oauth_and_header_conflict():
    with pytest.raises(ConfigError, match="not both"):
        mcp_auth.parse_oauth("x", {"client_id": "a"}, {"authorization": "Bearer t"}, lambda v: v)


def test_store_and_port(harness_home):
    key = mcp_auth.record_key("gh", "https://x/mcp")
    port = mcp_auth.callback_port(key, mcp_auth.OAuthConfig())
    assert mcp_auth.callback_port(key, mcp_auth.OAuthConfig()) == port  # The port stays the same.
    assert mcp_auth.callback_port(key, mcp_auth.OAuthConfig(callback_port=40000)) == 40000
    assert not mcp_auth.has_tokens(key)
    mcp_auth.update_record(key, tokens={"access_token": "t"})
    assert mcp_auth.has_tokens(key)
    assert mcp_auth.clear_record(key)
    assert not mcp_auth.has_tokens(key)
    assert not mcp_auth.clear_record(key)


def test_callback_resolve_and_listener(harness_home):
    async def main() -> None:
        cb = mcp_auth.Callback(free_port())
        await cb.start()
        try:
            assert "no 'code'" in cb.resolve("http://127.0.0.1/callback?state=x")
            async with httpx.AsyncClient() as client:
                missing = await client.get(f"http://127.0.0.1:{cb.port}/other")
                assert missing.status_code == 404
                page = await client.get(f"http://127.0.0.1:{cb.port}/callback?code=abc&state=st")
                assert page.status_code == 200 and "Signed in" in page.text
            result = await cb.wait()
            assert (result.code, result.state) == ("abc", "st")
            assert cb.resolve("?code=again") == "No sign-in is waiting for a code."
        finally:
            await cb.close()

        cb = mcp_auth.Callback(free_port())
        await cb.start()
        try:
            assert cb.resolve("code=1&error=access_denied&error_description=No") is None
            with pytest.raises(Exception, match="refused the sign-in: No"):
                await cb.wait()
        finally:
            await cb.close()

    asyncio.run(main())


# -- the full sign-in --------------------------------------------------------------------------------


@pytest.fixture
def oauth_server():
    port = free_port()
    proc = subprocess.Popen([PYTHON, SERVER, "oauth", str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 20
        while time.time() < deadline:
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.2)
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.kill()


def run(project: Path, body) -> list[dict]:
    events: list[dict] = []
    box: dict = {"tools": []}

    async def emit(event: dict) -> None:
        events.append(event)

    async def main() -> None:
        manager = McpManager(project, emit, lambda tools: box.__setitem__("tools", tools))
        try:
            await manager.start()
            await body(manager, box, events)
        finally:
            await manager.close()

    asyncio.run(main())
    return events


async def wait_for_url(events: list[dict], name: str) -> str:
    for _ in range(200):
        for e in events:
            if e.get("type") == "mcp.auth_url" and e["name"] == name:
                return e["url"]
        await asyncio.sleep(0.05)
    raise AssertionError("no mcp.auth_url event")


def test_sign_in_with_the_browser(harness_home, project, oauth_server):
    write_config(project / ".harness" / "mcp.json", {"remote": http_entry(f"{oauth_server}/mcp")})

    async def body(manager: McpManager, box: dict, events: list[dict]) -> None:
        s = manager.servers["remote"]
        assert s.state == "needs_auth", s.error
        status = manager.items()["items"][0]
        assert status["oauth"] is True and status["signed_in"] is False
        with pytest.raises(Exception, match="needs authentication"):
            await manager.call("remote", "echo", {"text": "x"})

        task = asyncio.create_task(manager.authenticate("remote"))
        url = await wait_for_url(events, "remote")
        assert manager.servers["remote"].state == "authenticating"
        assert manager.items()["items"][0]["auth_url"] == url
        async with httpx.AsyncClient(follow_redirects=True) as client:  # The browser.
            page = await client.get(url)
            assert "Signed in" in page.text
        await asyncio.wait_for(task, 30)
        s = manager.servers["remote"]
        assert s.state == "connected", s.error
        echo = next(t for t in box["tools"] if t.name == "mcp__remote__echo")
        assert (await echo.run({"text": "signed in"}, None)).output == "signed in"
        assert manager.items()["items"][0]["signed_in"] is True

        # The tokens stay: a new connection needs no sign-in.
        await manager.restart("remote")
        assert manager.servers["remote"].state == "connected"

        # Clear authentication.
        await manager.logout("remote")
        assert manager.servers["remote"].state == "needs_auth"
        assert manager.items()["items"][0]["signed_in"] is False

    run(project, body)
    store = json.loads(mcp_auth.store_path().read_text(encoding="utf-8"))
    assert all("tokens" not in r for r in store.values())


def test_sign_in_with_a_pasted_url_and_a_fixed_client(harness_home, project, oauth_server):
    write_config(project / ".harness" / "mcp.json", {"remote": http_entry(
        f"{oauth_server}/mcp", oauth={"client_id": "fixed-client", "scopes": ["read"]})})

    async def body(manager: McpManager, box: dict, events: list[dict]) -> None:
        assert manager.servers["remote"].state == "needs_auth"
        task = asyncio.create_task(manager.authenticate("remote"))
        url = await wait_for_url(events, "remote")
        async with httpx.AsyncClient() as client:
            # The browser is on another computer: it cannot open the callback. The user pastes its URL.
            answer = await client.get(url)
            assert answer.status_code == 302
            debug = (await client.get(f"{oauth_server}/debug")).json()
        assert debug["client_id"] == "fixed-client"
        assert debug["scope"] == "read"  # The configured scopes, not the scopes of the server.
        assert await manager.auth_code("remote", "not a url") is not None
        assert await manager.auth_code("remote", answer.headers["location"]) is None
        await asyncio.wait_for(task, 30)
        assert manager.servers["remote"].state == "connected", manager.servers["remote"].error

    run(project, body)


def test_cancel_the_sign_in(harness_home, project, oauth_server):
    write_config(project / ".harness" / "mcp.json", {"remote": http_entry(f"{oauth_server}/mcp")})

    async def body(manager: McpManager, box: dict, events: list[dict]) -> None:
        task = asyncio.create_task(manager.authenticate("remote"))
        await wait_for_url(events, "remote")
        await manager.auth_cancel("remote")
        await asyncio.wait_for(task, 30)
        s = manager.servers["remote"]
        assert s.state == "needs_auth"
        assert s.error == "The sign-in was cancelled."

    run(project, body)


def test_authenticate_needs_an_oauth_server(harness_home, project):
    write_config(project / ".harness" / "mcp.json", {
        "token": http_entry("http://127.0.0.1:9/mcp", headers={"Authorization": "Bearer x"}, disabled=True)})

    async def body(manager: McpManager, box: dict, events: list[dict]) -> None:
        with pytest.raises(ConfigError, match="does not use OAuth"):
            await manager.authenticate("token")

    run(project, body)
