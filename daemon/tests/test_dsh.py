"""Tests for DeepSeek Harness plugins through the Node plugin host (plugins/dsh.py).

They need the plugin host (npm install in plugin-host/) and a Node: the tests are skipped without them.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from harness_daemon.plugins.dsh import BRIDGE, dsh_home

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

FIXTURES = Path(__file__).resolve().parents[2] / "plugin-host" / "test" / "fixtures"

pytestmark = pytest.mark.skipif(BRIDGE.unavailable_reason() is not None,
                                reason=BRIDGE.unavailable_reason() or "")


@pytest.fixture(autouse=True)
def fresh_bridge():
    BRIDGE.stop_now()
    BRIDGE.agents.clear()
    yield
    BRIDGE.stop_now()
    BRIDGE.agents.clear()


def install(c: Client, name: str) -> dict:
    c.send({"type": "plugins.install", "kind": "deepseek", "source": str(FIXTURES / name)})
    return c.until("plugins", timeout=180)[0]


def test_install_with_no_session_and_the_plugins_screen(daemon, harness_home):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "plugins.list"})
    empty = c.until("plugins")[0]
    assert empty["deepseek"]["available"] is True and empty["deepseek"]["running"] is False
    assert not BRIDGE.running  # The Plugins screen does not start Node for an empty list.

    listing = install(c, "hello-dsh")
    assert listing["installed"] == "hello-dsh" and listing["installed_kind"] == "deepseek"
    bundle = listing["deepseek"]["bundles"][0]
    assert (bundle["name"], bundle["version"], bundle["enabled"], bundle["problem"]) == ("hello-dsh", "1.0.0", True, None)
    assert {r["id"]: r["state"] for r in bundle["rows"]} == {"hello": "active", "hello-guard": "disabled"}
    assert (dsh_home() / "node_modules" / "hello-dsh" / "index.js").is_file()

    c.send({"type": "plugins.install", "kind": "deepseek", "source": str(FIXTURES / "old-dsh")})
    assert "needs another DeepSeek Harness version" in c.until("error", timeout=120)[0]["message"]
    c.close()


def test_a_session_uses_deepseek_tools_commands_skills_and_prompt(daemon, harness_home, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    install(c, "hello-dsh")
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    ready = c.until("session.ready", timeout=60)[0]
    assert ready["warnings"] == []

    c.send({"type": "skills.list"})
    items = {i["name"]: i for i in c.until("skills")[0]["items"]}
    assert items["hello"]["source"] == "plugin (deepseek)" and items["hello"]["argument-hint"] == "[name]"
    assert items["greeting-style"]["source"] == "plugin (deepseek)"

    c.send({"type": "command", "name": "hello", "args": "Ada"})
    assert "Ada!" in c.until("command.result", timeout=30)[0]["text"]

    fake_model.script(
        {"tool_calls": [{"name": "greet", "arguments": {"name": "Bo"}}]},
        {"tool_calls": [{"name": "danger", "arguments": {}}]},
        {"text": "Done."})
    c.send({"type": "prompt", "text": "Greet Bo."})
    request, events = c.until("permission.request", timeout=60)
    assert request["tool"] == "greet" and request["rule"] == "greet" and request["input"] == {"name": "Bo"}
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    request, seen = c.until("permission.request", timeout=60)
    events += seen
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    events += c.until("turn.end", timeout=60)[1]
    results = [e for e in events if e["type"] == "tool.result"]
    assert results[0]["output"] == "Hi, Bo! (checked)" and not results[0]["is_error"]
    assert results[1]["is_error"] and "hello-dsh blocks the danger tool" in results[1]["output"]

    system = fake_model.requests[0]["messages"][0]["content"]
    assert "use the greet tool" in system and "greeting-style" in system
    assert "harness:identity" not in system
    tool_names = [t["function"]["name"] for t in fake_model.requests[0]["tools"]]
    assert "greet" in tool_names and "danger" in tool_names

    # A row that is off: its tools and commands leave the session.
    c.send({"type": "plugins.set_plugin", "kind": "deepseek", "id": "hello", "enabled": False})
    listing = c.until("plugins", timeout=60)[0]
    assert listing["deepseek"]["bundles"][0]["rows"][0]["state"] == "disabled"
    c.send({"type": "skills.list"})
    assert "hello" not in {i["name"] for i in c.until("skills")[0]["items"]}
    c.close()


def test_build_scripts_need_approval_and_remove(daemon, harness_home):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "plugins.install", "kind": "deepseek", "source": str(FIXTURES / "script-dsh")})
    error = c.until("error", timeout=180)[0]
    pending = error["data"]["pending_builds"]
    assert error["ref"] == "plugins.install" and pending[0].startswith("script-dsh@file:")
    c.send({"type": "plugins.install", "kind": "deepseek", "source": str(FIXTURES / "script-dsh"),
            "approved_builds": pending})
    listing = c.until("plugins", timeout=180)[0]
    assert listing["installed"] == "script-dsh"
    assert (dsh_home() / "node_modules" / "script-dsh" / "ran.txt").is_file()

    c.send({"type": "plugins.remove", "kind": "deepseek", "name": "script-dsh"})
    listing = c.until("plugins", timeout=180)[0]
    assert listing["removed"] == "script-dsh" and listing["deepseek"]["bundles"] == []
    c.close()


# -- phase 2: the agent and tool events ---------------------------------------------------------------


def answer(c: Client, seen: list, decision: str = "allow_once", timeout: float = 60) -> dict:
    """Wait for the next permission request, answer it, and keep the messages before it."""
    request, before = c.until("permission.request", timeout=timeout)
    seen += before
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": decision})
    return request


def test_deepseek_plugins_get_the_events_of_the_loop(daemon, harness_home, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    install(c, "events-dsh")
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    assert c.until("session.ready", timeout=60)[0]["warnings"] == []

    fake_model.script(
        {"error": "The server is busy.", "status": 400},  # agent/request-error asks for one retry.
        {"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]},
        {"tool_calls": [{"name": "write", "arguments": {"path": "x.txt", "content": "x"}}]},
        {"tool_calls": [{"name": "glob", "arguments": {"pattern": "*.py"}}]},
        {"text": "Done."},
        {"text": "Goodbye."},  # After the steer of agent/turn-stopping.
    )
    c.send({"type": "prompt", "text": "Hello"})
    seen: list = []
    request = answer(c, seen)  # tools/pre-execute "ask" for glob: glob needs no approval without the plugin.
    assert request["tool"] == "glob" and request["reason"] == "events-dsh asks before glob" and request["rule"] is None
    end, rest = c.until("turn.end", timeout=60)
    seen += rest
    assert end["stop_reason"] == "end"

    first = fake_model.requests[0]
    assert first["messages"][-1] == {"role": "user", "content": "[checked] Hello"}  # agent/pre-step
    assert first["temperature"] == 0.25 and first["max_tokens"] == 77  # agent/request
    assert fake_model.requests[1]["messages"][-1]["content"] == "[checked] Hello"  # The retry sends the same request.

    results = {r["id"]: r for r in seen if r["type"] == "tool.result"}
    outputs = [r["output"] for r in results.values()]
    assert any(o.endswith("[read checked]") for o in outputs)  # tools/post-execute
    assert any("events-dsh blocks write" in o for o in outputs)  # tools/pre-execute "deny"
    assert not (project / "x.txt").exists()
    after_read = fake_model.requests[2]["messages"]
    assert {"role": "user", "content": "Note from events-dsh."} in after_read  # additionalContexts
    last = fake_model.requests[-1]["messages"]
    assert last[-1] == {"role": "user", "content": "Also say goodbye."}  # agent/turn-stopping steer
    assert len(fake_model.requests) == 6

    c.send({"type": "command", "name": "events", "args": ""})
    events = json.loads(c.until("command.result", timeout=30)[0]["text"])
    names = [e["name"] for e in events]
    assert "agent/created" in names and "agent/request-error" in names
    assert {"name": "agent/status", "status": "running"} in events and {"name": "agent/status", "status": "idle"} in events
    assert {"name": "agent/inbox/claimed", "text": "Hello"} in events
    assert {"name": "tools/result", "tool": "read", "isError": False} in events
    assert {"name": "tools/result", "tool": "write", "isError": True} in events
    assert {"name": "agent/assistant-stream", "type": "start"} in events and {"name": "agent/assistant-stream", "type": "end"} in events

    # agent/pre-step "reject": the turn ends with no model call.
    count = len(fake_model.requests)
    c.send({"type": "prompt", "text": "please reject this"})
    assert c.until("turn.end", timeout=60)[0]["stop_reason"] == "blocked"
    assert len(fake_model.requests) == count
    c.close()


def test_a_hook_that_asks_about_a_deepseek_tool_uses_the_permission_card(daemon, harness_home, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    install(c, "events-dsh")
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    c.until("session.ready", timeout=60)
    fake_model.script({"tool_calls": [{"name": "askme", "arguments": {}}]}, {"text": "Done."}, {"text": "Bye."})
    c.send({"type": "prompt", "text": "Run askme."})
    seen: list = []
    first = answer(c, seen)  # The Harness approval of a DeepSeek tool.
    assert first["tool"] == "askme" and first["rule"] == "askme"
    second = answer(c, seen)  # The approval service of the host: the plugin asked.
    assert second["tool"] == "askme" and second["reason"] == "events-dsh asks before askme" and second["rule"] is None
    seen += c.until("turn.end", timeout=60)[1]
    result = next(m for m in seen if m["type"] == "tool.result")
    assert result["output"] == "askme ran" and not result["is_error"]
    c.close()
