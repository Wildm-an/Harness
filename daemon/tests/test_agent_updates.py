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


class _Window:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, message: dict) -> None:
        self.sent.append(message)


def test_the_automatic_updates_run_together_and_report_to_each_window(monkeypatch):
    from harness_daemon import acp_harnesses, acp_install, server

    specs = [acp_harnesses.find("claude-acp"), acp_harnesses.find("codex-acp")]
    assert all(specs)
    monkeypatch.setattr(server, "load_settings", lambda cwd: {"agents_auto_update": True})
    monkeypatch.setattr(server, "_enabled_downloads", lambda: True)
    monkeypatch.setattr(acp_install, "registry_stale", lambda: False)
    monkeypatch.setattr(server, "_download_updates", lambda enabled_only: specs)
    monkeypatch.setattr(acp_install, "summary", lambda spec: {"download": {"version": "1.0.0"}, "latest": "1.1.0"})
    lists: list[str] = []

    async def send_harnesses(conn):
        lists.append("list")

    monkeypatch.setattr(server, "_send_harnesses", send_harnesses)
    running: set[str] = set()
    together: list[int] = []

    async def install(spec, progress, refresh=True):
        assert refresh is False  # The check read the registry one time for all the agents.
        running.add(spec.id)
        await progress("Downloading", 5, 10)
        await asyncio.sleep(0.01)
        together.append(len(running))
        if spec.id == "codex-acp":
            raise acp_install.InstallError("No network.")
        return {}

    monkeypatch.setattr(acp_install, "install", install)
    window = _Window()
    monkeypatch.setattr(server, "WINDOWS", {window})
    server._UPDATING.clear()

    asyncio.run(server._auto_update_agents())

    states = [m for m in window.sent if m["type"] == "harnesses.updating"]
    assert [i["state"] for i in states[0]["items"]] == ["waiting", "waiting"]
    assert states[0]["items"][0]["from"] == "1.0.0" and states[0]["items"][0]["to"] == "1.1.0"
    assert 2 in together  # The two downloads ran at the same time.
    last = {i["id"]: i for i in states[-1]["items"]}
    assert last["claude-acp"]["state"] == "done"
    assert last["codex-acp"]["state"] == "failed" and last["codex-acp"]["error"] == "No network."
    assert any(m["type"] == "harnesses.progress" for m in window.sent)  # The rows of Settings > Agents.
    assert lists == ["list"]  # The new list after all the updates.
    assert not server._updating_active()


def test_no_automatic_update_when_the_switch_is_off(monkeypatch):
    from harness_daemon import server

    monkeypatch.setattr(server, "load_settings", lambda cwd: {})

    def fail(*a):
        raise AssertionError("The check must not run.")

    monkeypatch.setattr(server, "_enabled_downloads", fail)
    asyncio.run(server._auto_update_agents())
