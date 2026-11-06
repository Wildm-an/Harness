"""Servers that the agent starts: no question in auto mode, preview_servers, and the stop on a window close."""

from __future__ import annotations

import json

from harness_daemon.auto_mode import fast_path

from test_server import Client, daemon  # noqa: F401 - the daemon fixture
from test_servers import command, free_port


def test_auto_mode_starts_a_project_server_with_no_question():
    assert fast_path("server", "npm run dev") is True


def test_the_agent_lists_starts_and_the_window_stops_its_servers(daemon, project, fake_model):  # noqa: F811
    port = free_port()
    (project / ".harness").mkdir(exist_ok=True)
    (project / ".harness" / "settings.json").write_text(json.dumps({"permission_mode": "auto"}))
    (project / ".harness" / "launch.json").write_text(json.dumps({"version": "0.0.1", "servers": [
        {"name": "web", "command": command(port), "port": port, "ready_pattern": "Local:.*http", "default": True}]}))
    fake_model.script(
        {"tool_calls": [{"name": "preview_servers", "arguments": {}}]},
        {"tool_calls": [{"name": "preview_start", "arguments": {"name": "web"}}]},
        {"text": "The server runs."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Start the web server"})
    _msg, seen = c.until("turn.end", 60)
    assert not any(m["type"] == "permission.request" for m in seen)  # Auto mode: no question.
    results = [m["content"] for m in fake_model.requests[-1]["messages"] if m["role"] == "tool"]
    assert "- web: stopped" in results[0] and command(port) in results[0]
    assert "is running at" in results[1]
    agent = [m for m in seen if m["type"] == "servers.agent"]
    assert agent and agent[-1]["items"][0]["name"] == "web"

    c.send({"type": "server.stop_agent"})
    while True:
        msg = c.until("servers.agent", 30)[0]
        if not msg["items"]:
            break
    c.close()
