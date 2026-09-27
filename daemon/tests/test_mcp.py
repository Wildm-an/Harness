"""Tests for the MCP client (build phase 12): the configuration, the tools, approval, and transports."""

from __future__ import annotations

import asyncio
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from harness_daemon.mcp_client import McpManager, load_mcp_config, tool_name
from harness_daemon.permissions import rule_matches
from harness_daemon.tools import ToolError

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

SERVER = (Path(__file__).parent / "mcp_test_server.py").as_posix()
PYTHON = Path(sys.executable).as_posix()


def write_config(path: Path, servers: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"mcpServers": servers}), encoding="utf-8")


def stdio_entry(**extra) -> dict:
    return {"command": PYTHON, "args": [SERVER], **extra}


# -- the configuration ---------------------------------------------------------------------------


def test_config_merge_env_and_errors(harness_home, project, monkeypatch):
    monkeypatch.setenv("MCP_TOKEN", "t0k")
    monkeypatch.delenv("MCP_MISSING", raising=False)
    write_config(harness_home / "mcp.json", {
        "shared": {"command": "user-command"},
        "web": {"type": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer ${MCP_TOKEN}"}},
    })
    write_config(project / ".harness" / "mcp.json", {
        "shared": {"command": "npx", "args": ["-y", "pkg", "${MCP_MISSING:-fallback}"], "env": {"K": "${MCP_MISSING}"}},
        "old": {"type": "sse", "url": "http://127.0.0.1:1/sse", "disabled": True},
        "bad name": {"command": "x"},
        "nocmd": {"type": "stdio"},
        "badtype": {"type": "ws", "url": "ws://x"},
    })
    servers, problems = load_mcp_config(project)
    assert list(servers) == ["shared", "web", "old"]
    shared = servers["shared"]
    assert (shared.scope, shared.command, shared.args, shared.env) == ("project", "npx", ["-y", "pkg", "fallback"], {"K": ""})
    assert shared.cwd == str(project)  # The default working folder of a stdio server.
    assert servers["web"].headers == {"Authorization": "Bearer t0k"} and servers["web"].transport == "http"
    assert servers["old"].disabled and servers["old"].transport == "sse"
    text = "\n".join(problems)
    assert "MCP_MISSING is not set" in text and "bad name" in text and "needs a 'command'" in text and "stdio, http, or sse" in text


def test_tool_names_and_wildcard_rules():
    assert tool_name("github", "create_issue", set()) == "mcp__github__create_issue"
    assert tool_name("files", "read.file", set()) == "mcp__files__read_file"
    long = tool_name("server", "x" * 80, set())
    assert len(long) == 64 and long.startswith("mcp__server__xxx")
    assert tool_name("a", "b", {"mcp__a__b"}) != "mcp__a__b"
    assert rule_matches("mcp__github__*", "mcp__github__create_issue", "{}")
    assert not rule_matches("mcp__github__*", "mcp__gitlab__create_issue", "{}")
    assert rule_matches("mcp__github__create_issue", "mcp__github__create_issue", "{}")
    assert not rule_matches("mcp__github__create", "mcp__github__create_issue", "{}")


# -- the client with real servers ---------------------------------------------------------------


def run_manager(project: Path, body) -> list[dict]:
    """Start the MCP manager of a project, run ``body(manager, tools)``, and close it. Return the status messages."""
    events: list[dict] = []
    tools_box: dict[str, list] = {"tools": []}

    async def emit(event: dict) -> None:
        events.append(event)

    async def main() -> None:
        manager = McpManager(project, emit, lambda tools: tools_box.__setitem__("tools", tools))
        try:
            await manager.start()
            await body(manager, tools_box)
        finally:
            await manager.close()

    asyncio.run(main())
    return events


def test_stdio_server_tools_results_and_list_changes(harness_home, project, monkeypatch):
    monkeypatch.setenv("MCP_TEST_SECRET", "from-daemon-env")
    write_config(project / ".harness" / "mcp.json", {
        "test": stdio_entry(env={"MCP_TEST_SECRET": "from-config"}),
        "broken": {"command": "no-such-command-harness-test"},
        "off": stdio_entry(disabled=True),
    })

    async def body(manager: McpManager, box: dict) -> None:
        states = {name: s.state for name, s in manager.servers.items()}
        assert states == {"test": "connected", "broken": "failed", "off": "disabled"}
        assert manager.servers["broken"].error
        tools = {t.name: t for t in box["tools"]}
        assert {"mcp__test__add", "mcp__test__echo", "mcp__test__fail", "mcp__test__picture"} <= set(tools)
        add = tools["mcp__test__add"]
        assert add.needs_approval and add.description.startswith("[MCP server test] Add two integers")
        assert add.parameters["required"] == ["a", "b"] and "title" not in add.parameters

        result = await add.run({"a": 2, "b": 3}, None)
        assert (result.output, result.is_error) == ("5", False)
        failed = await tools["mcp__test__fail"].run({}, None)
        assert failed.is_error and "fail" in failed.output
        picture = await tools["mcp__test__picture"].run({}, None)
        assert picture.image.startswith("data:image/png;base64,") and "[An image: image/png]" in picture.output
        secret = await tools["mcp__test__secret"].run({}, None)
        assert secret.output == "from-config"  # The env of the config goes over the env of the daemon.

        # tools/list_changed: the new tool comes to the agent.
        assert "mcp__test__late" not in tools
        await tools["mcp__test__add_tool"].run({}, None)
        deadline = time.time() + 10
        while "mcp__test__late" not in {t.name for t in box["tools"]} and time.time() < deadline:
            await asyncio.sleep(0.1)
        late = next(t for t in box["tools"] if t.name == "mcp__test__late")
        assert (await late.run({}, None)).output == "late tool"

        # A restart of one server connects again.
        await manager.restart("test")
        assert manager.servers["test"].state == "connected"
        assert (await next(t for t in box["tools"] if t.name == "mcp__test__echo").run({"text": "hi"}, None)).output == "hi"
        items = manager.items()
        assert [i["state"] for i in items["items"]] == ["connected", "failed", "disabled"]
        assert items["items"][0]["tools"][0]["agent_name"].startswith("mcp__test__")

    events = run_manager(project, body)
    assert events and events[-1]["type"] == "mcp"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_http_server(harness_home, project):
    port = free_port()
    proc = subprocess.Popen([PYTHON, SERVER, "http", str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 20
        while time.time() < deadline:
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.2)
        write_config(project / ".harness" / "mcp.json", {"remote": {"type": "http", "url": f"http://127.0.0.1:{port}/mcp"}})

        async def body(manager: McpManager, box: dict) -> None:
            assert manager.servers["remote"].state == "connected", manager.servers["remote"].error
            echo = next(t for t in box["tools"] if t.name == "mcp__remote__echo")
            assert (await echo.run({"text": "over http"}, None)).output == "over http"

        run_manager(project, body)
    finally:
        proc.kill()


def test_call_to_a_server_that_is_not_connected(harness_home, project):
    write_config(project / ".harness" / "mcp.json", {"test": stdio_entry()})

    async def body(manager: McpManager, box: dict) -> None:
        add = next(t for t in box["tools"] if t.name == "mcp__test__add")
        await manager._stop_one(manager.servers["test"])
        with pytest.raises(ToolError, match="not connected"):
            await add.run({"a": 1, "b": 1}, None)

    run_manager(project, body)


# -- through the protocol -----------------------------------------------------------------------------


def test_mcp_tool_call_needs_approval(daemon, project, fake_model):  # noqa: F811
    write_config(project / ".harness" / "mcp.json", {"test": stdio_entry()})
    fake_model.script(
        {"tool_calls": [{"name": "mcp__test__add", "arguments": {"a": 2, "b": 3}}]},
        {"text": "The sum is 5."},
        {"tool_calls": [{"name": "mcp__test__add", "arguments": {"a": 4, "b": 4}}]},
        {"text": "8."},
    )
    c = Client(daemon)
    c.new_session(project)
    status = c.until("mcp", timeout=60, )[0]
    while status["items"][0]["state"] == "starting":
        status = c.until("mcp", timeout=60)[0]
    assert status["items"][0]["state"] == "connected"
    c.send({"type": "prompt", "text": "add 2 and 3"})
    request = c.until("permission.request", timeout=60)[0]
    assert request["tool"] == "mcp__test__add" and request["rule"] == "mcp__test__add"
    assert request["input"] == {"a": 2, "b": 3}
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_always"})
    end, seen = c.until("turn.end", timeout=60)
    result = next(m for m in seen if m["type"] == "tool.result")
    assert result["output"] == "5" and not result["is_error"]
    tools = {t["function"]["name"] for t in fake_model.requests[0]["tools"]}
    assert "mcp__test__add" in tools
    assert "mcp__test__add" in json.loads((project / ".harness" / "settings.json").read_text())["allow"]

    # The rule is saved: the second call needs no approval.
    c.send({"type": "prompt", "text": "add 4 and 4"})
    end, seen = c.until("turn.end", timeout=60)
    assert not any(m["type"] == "permission.request" for m in seen)
    assert next(m for m in seen if m["type"] == "tool.result")["output"] == "8"

    c.send({"type": "mcp.list"})
    listing = c.until("mcp")[0]
    assert listing["paths"]["project"] == ".harness/mcp.json" and listing["items"][0]["scope"] == "project"
    c.send({"type": "mcp.init"})
    assert c.until("mcp.init")[0] == {"type": "mcp.init", "path": ".harness/mcp.json", "created": False}
    c.send({"type": "command", "name": "mcp", "args": ""})
    assert c.until("command.result")[0]["panel"] == "mcp"
    c.close()
