"""Settings > Agents: the updates of the agent programs that the user installed (agent_updates.py), "Update all",
and "Update agents automatically"."""

from __future__ import annotations

import asyncio

from harness_daemon import agent_updates
from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_the_version_texts():
    assert agent_updates.parse_version("2.1.325 (Claude Code)") == "2.1.325"
    assert agent_updates.parse_version("Hermes Agent v0.22.5 (2026.9.24) · stable") == "0.22.5"
    assert agent_updates.parse_version("opencode 1.4.0-beta.2") == "1.4.0-beta.2"
    assert agent_updates.parse_version("no version") is None
    text = "→ Update channel: stable\n→ Selected release available: stable v0.23.2 (ae2a81ccc00e)\n  Run `hermes update`"
    assert agent_updates.parse_available(text) == "0.23.2"
    assert agent_updates.parse_available("→ Hermes Agent is up to date (v0.23.2).") is None


def test_the_state_of_a_program(monkeypatch):
    states = agent_updates.ProgramStates()
    monkeypatch.setattr(agent_updates, "program_path", lambda i: None)
    assert states.cached("hermes") is None  # Not installed: no update.
    assert states.cached("gemini") is None  # No update command.

    monkeypatch.setattr(agent_updates, "program_path", lambda i: "/bin/hermes")
    outputs = {"--version": "Hermes Agent v0.22.5", "--check": "Selected release available: stable v0.23.2"}
    monkeypatch.setattr(agent_updates, "_run", lambda argv, timeout: outputs[argv[-1]])
    before = states.cached("hermes")
    assert before["version"] is None and before["command"] == "hermes update" and before["label"] == "Hermes Agent"
    state = asyncio.run(states.check("hermes"))
    assert (state["version"], state["latest"], state["update"]) == ("0.22.5", "0.23.2", True)
    assert states.fresh("hermes") and states.cached("hermes") is state

    # Up to date: no "available" line.
    outputs["--check"] = "Hermes Agent is up to date."
    state = asyncio.run(states.check("hermes", force=True))
    assert (state["latest"], state["update"]) == ("0.22.5", False)


def test_the_newest_version_from_npm(monkeypatch):
    states = agent_updates.ProgramStates()
    monkeypatch.setattr(agent_updates, "program_path", lambda i: "/bin/opencode")
    monkeypatch.setattr(agent_updates, "_run", lambda argv, timeout: "1.4.2")

    async def latest(package):
        assert package == "opencode-ai"
        return "1.4.7"

    monkeypatch.setattr(agent_updates, "_npm_latest", latest)
    state = asyncio.run(states.check("opencode"))
    assert state["update"] is True and state["command"] == "opencode upgrade"
    assert agent_updates.update_argv("opencode") == ["/bin/opencode", "upgrade"]


def test_claude_agent_shows_no_claude_code_update():
    # Settings > Agents shows only the ACP adapter of Claude Agent: its download, update, and uninstall.
    assert "claude-acp" not in agent_updates.UPDATERS
    assert agent_updates.STATES.cached("claude-acp") is None


def test_a_failed_check_keeps_the_program(monkeypatch):
    states = agent_updates.ProgramStates()
    monkeypatch.setattr(agent_updates, "program_path", lambda i: "/bin/goose")

    def fail(argv, timeout):
        raise TimeoutError

    monkeypatch.setattr(agent_updates, "_run", fail)
    state = asyncio.run(states.check("goose"))
    assert state["update"] is False and "Could not check" in state["error"]


def test_the_update_requests(daemon):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "agents.update_program", "id": "gemini", "cols": 80, "rows": 24})
    assert "no update command" in c.until("error")[0]["message"]
    c.send({"type": "harnesses.update_all"})
    assert "No agent that Harness downloaded has an update" in c.until("error")[0]["message"]
    c.send({"type": "user_settings.set", "values": {"agents_auto_update": True}})
    settings = c.until("user_settings")[0]
    assert settings["values"]["agents_auto_update"] is True
    c.close()
