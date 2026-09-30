"""Tests for DeepSeek Harness plugins through the Node plugin host (plugins/dsh.py).

They need the plugin host (npm install in plugin-host/) and a Node: the tests are skipped without them.
"""

from __future__ import annotations

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
