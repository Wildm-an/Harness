"""ACP sessions: another harness runs the agent loop (acp.py, acp_harnesses.py). The tests use fake_acp_agent.py."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from harness_daemon import acp_harnesses
from harness_daemon.acp import unified_diff
from test_server import Client, daemon  # noqa: F401 - the daemon fixture

FAKE = Path(__file__).resolve().parent / "fake_acp_agent.py"


@pytest.fixture
def fake_acp(harness_home, tmp_path, monkeypatch):
    """The fake agent as the operating harness. Returns the log of the messages that it got."""
    log = tmp_path / "acp.log"
    monkeypatch.setenv("FAKE_ACP_LOG", str(log))
    spec = acp_harnesses.save_custom("Fake ACP", f'"{sys.executable}" "{FAKE}"')
    settings = harness_home / "settings.json"
    data = json.loads(settings.read_text()) if settings.exists() else {}
    data["operating_harness"] = spec.id
    settings.write_text(json.dumps(data))
    return log


def methods(log: Path) -> list[str]:
    if not log.exists():
        return []
    return [json.loads(line).get("method") or "reply" for line in log.read_text().splitlines()]


def test_acp_session_streams_and_loads_its_session_again(daemon, project, fake_acp):
    c = Client(daemon)
    ready = c.new_session(project)
    assert {k: ready["harness"][k] for k in ("id", "name")} == {"id": "custom-fake-acp", "name": "Fake ACP"}
    assert ready["model"] == "acp/custom-fake-acp"
    c.send({"type": "prompt", "text": "hello"})
    end, seen = c.until("turn.end", timeout=30)
    assert end["stop_reason"] == "end"
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "Hello from fake."
    assert any(m["type"] == "thinking" for m in seen)
    assert methods(fake_acp)[:3] == ["initialize", "session/new", "session/prompt"]
    c.close()

    c2 = Client(daemon)
    c2.until("auth.ok")
    c2.send({"type": "session.resume", "session_id": ready["session_id"]})
    resumed = c2.until("session.ready")[0]
    assert [m["role"] for m in resumed["history"]] == ["user", "assistant"]
    assert resumed["history"][1]["content"] == "Hello from fake."
    c2.send({"type": "prompt", "text": "blocks"})
    end, seen = c2.until("turn.end", timeout=30)
    text = "".join(m["text"] for m in seen if m["type"] == "token")
    assert text == "blocks=1"  # session/load gave the context: no recap.
    assert "old reply" not in text
    assert methods(fake_acp).count("session/load") == 1
    c2.close()


def test_acp_permission_plan_and_diff(daemon, project, fake_acp):
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "edit"})
    request, seen = c.until("permission.request", timeout=30)
    plan = next(m for m in seen if m["type"] == "tool.start" and m["name"] == "update_plan")
    assert plan["input"]["items"][0] == {"content": "Edit hello.py", "status": "in_progress"}
    assert request["tool"] == "edit" and request["input"] == {"path": "hello.py"}
    assert "+    return 'hey'" in request["diff"] and request["remember"] == "Fake ACP"
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    end, seen = c.until("turn.end", timeout=30)
    result = next(m for m in seen if m["type"] == "tool.result" and m["id"] == "call_1")
    assert not result["is_error"] and "+    return 'hey'" in result["diff"]
    assert any(m["type"] == "fs.changed" and m["path"] == "hello.py" for m in seen)
    assert "'hey'" in (project / "hello.py").read_text()
    assert end["stop_reason"] == "end"
    c.close()


def test_acp_denied_permission(daemon, project, fake_acp):
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "edit"})
    request, _ = c.until("permission.request", timeout=30)
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "deny"})
    end, seen = c.until("turn.end", timeout=30)
    result = next(m for m in seen if m["type"] == "tool.result" and m["id"] == "call_1")
    assert result["is_error"] and result["output"] == "Rejected."
    assert "'hello'" in (project / "hello.py").read_text()
    c.close()


def test_acp_interrupt(daemon, project, fake_acp):
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "wait"})
    start = c.until("tool.start", timeout=30)[0]
    assert start["name"] == "bash" and start["input"] == {"command": "sleep 30"}
    c.send({"type": "interrupt"})
    end, seen = c.until("turn.end", timeout=20)
    assert end["stop_reason"] == "interrupted"
    assert any(m["type"] == "tool.result" and m["is_error"] for m in seen)
    assert "session/cancel" in methods(fake_acp)
    c.close()


def test_acp_plan_mode_and_model_switch(daemon, project, fake_acp):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"permission_mode": "plan"}))
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "hello"})
    c.until("turn.end", timeout=30)
    sent = [json.loads(line) for line in fake_acp.read_text().splitlines()]
    set_mode = next(m for m in sent if m.get("method") == "session/set_mode")
    assert set_mode["params"]["modeId"] == "plan"
    c.send({"type": "command", "name": "model", "args": "fake/test-model"})
    error = c.until("error")[0]
    assert "chooses its own model" in error["message"]
    c.close()


def test_acp_program_that_is_not_installed(daemon, project, harness_home):
    spec = acp_harnesses.save_custom("Missing", "no-such-harness-program --acp")
    (harness_home / "settings.json").write_text(json.dumps({"operating_harness": spec.id}))
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "hello"})
    end, seen = c.until("turn.end", timeout=30)
    assert end["stop_reason"] == "error"
    error = next(m for m in seen if m["type"] == "error")
    assert "no-such-harness-program" in error["message"]
    c.close()


def test_harness_list_custom_harnesses_and_the_setting(daemon, harness_home):
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "harnesses.list"})
    listing = c.until("harnesses")[0]
    ids = {i["id"] for i in listing["items"]}
    assert {"opencode", "omp", "codex-acp", "claude-acp", "gemini"} <= ids and listing["current"] == "harness"
    recommended = sorted((i for i in listing["items"] if i["recommended"] is not None), key=lambda i: i["recommended"])
    assert [i["id"] for i in recommended] == list(acp_harnesses.RECOMMENDED)
    assert recommended[0]["id"] == "opencode" and recommended[0]["local_models"] and recommended[0]["reason"]
    assert all(acp_harnesses.find(i) is not None for i in acp_harnesses.RECOMMENDED)
    omp = next(i for i in listing["items"] if i["id"] == "omp")
    assert omp["command"] == "omp --mode acp" and omp["status"] in ("installed", "missing")

    c.send({"type": "harnesses.save", "name": "My agent", "command": "my-agent --acp"})
    listing = c.until("harnesses")[0]
    custom = next(i for i in listing["items"] if i["custom"])
    assert custom == {**custom, "id": "custom-my-agent", "name": "My agent", "command": "my-agent --acp"}

    c.send({"type": "user_settings.set", "values": {"operating_harness": "custom-my-agent"}})
    settings = c.until("user_settings")[0]
    assert settings["values"]["operating_harness"] == "custom-my-agent"
    assert settings["harness"] == {"id": "custom-my-agent", "name": "My agent", "model": None}  # For the start screen.
    c.send({"type": "user_settings.set", "values": {"operating_harness": "no-such-harness"}})
    assert "Unknown harness" in c.until("error")[0]["message"]

    # A delete of the operating harness gives the built-in loop again.
    c.send({"type": "harnesses.delete", "id": "custom-my-agent"})
    settings = c.until("user_settings")[0]
    assert settings["values"]["operating_harness"] is None and settings["harness"] is None
    listing = c.until("harnesses")[0]
    assert not any(i["custom"] for i in listing["items"]) and listing["current"] == "harness"
    c.close()


def test_custom_harness_errors(harness_home):
    with pytest.raises(acp_harnesses.HarnessError):
        acp_harnesses.save_custom("", "x")
    with pytest.raises(acp_harnesses.HarnessError):
        acp_harnesses.save_custom("Name", "  ")
    quoted = acp_harnesses.save_custom("Quoted", '"C:/Program Files/x/agent.exe" --acp')
    # The list shows the command as the user typed it, so an edit keeps the quotes.
    assert acp_harnesses.public(quoted)["command"] == '"C:/Program Files/x/agent.exe" --acp'
    assert quoted.bin == ("C:/Program Files/x/agent.exe", ("--acp",))
    first = acp_harnesses.save_custom("Same", "a")
    second = acp_harnesses.save_custom("Same", "b")
    assert (first.id, second.id) == ("custom-same", "custom-same-2")
    with pytest.raises(acp_harnesses.HarnessError):
        acp_harnesses.delete_custom("custom-unknown")


def test_unified_diff_for_a_change_and_a_new_file():
    diff = unified_diff("a.py", "x = 1\ny = 2\n", "x = 1\ny = 3\n")
    assert diff.startswith("--- a/a.py\n+++ b/a.py\n@@") and "-y = 2\n+y = 3\n" in diff
    new = unified_diff("b.py", None, "z = 1")
    assert new.startswith("--- /dev/null\n+++ b/b.py\n") and new.endswith("+z = 1\n")
    assert unified_diff("c.py", "same\n", "same\n") == ""


def test_acp_models_commands_and_usage(daemon, project, fake_acp):
    c = Client(daemon)
    c.new_session(project)
    # The open starts the harness: the client gets its models and its commands before the first prompt.
    state = c.until("acp.state", timeout=30)[0]
    while not (state["harness"]["commands"] and state["harness"]["models"]):
        state = c.until("acp.state", timeout=30)[0]
    harness = state["harness"]
    assert [m["id"] for m in harness["models"]] == ["fast", "smart"] and harness["model"] == "fast"
    assert harness["commands"] == [{"name": "review", "description": "Review the code", "hint": "path"}]

    c.send({"type": "skills.list"})
    items = c.until("skills")[0]["items"]
    review = next(i for i in items if i["name"] == "review")
    assert review["source"] == "Fake ACP" and review["acp"] is True

    c.send({"type": "acp.model", "model": "smart"})
    assert c.until("acp.state")[0]["harness"]["model"] == "smart"
    assert "session/set_model" in methods(fake_acp)
    c.send({"type": "acp.model", "model": "nope"})
    assert "has no model" in c.until("error")[0]["message"]

    c.send({"type": "command", "name": "review", "args": "src"})
    end, seen = c.until("turn.end", timeout=30)
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "review: src"

    c.send({"type": "prompt", "text": "hello"})
    end, _ = c.until("turn.end", timeout=30)
    assert end["usage"]["context_tokens"] == 1234 and end["usage"]["context_length"] == 200000
    c.close()


def test_acp_files_through_harness(daemon, project, fake_acp):
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "fsread"})
    _, seen = c.until("turn.end", timeout=30)
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "read: return 'hello'"
    sent = [json.loads(line) for line in fake_acp.read_text().splitlines()]
    assert sent[0]["params"]["clientCapabilities"] == {"fs": {"readTextFile": True, "writeTextFile": True},
                                                      "terminal": True}

    c.send({"type": "prompt", "text": "fswrite"})
    _, seen = c.until("turn.end", timeout=30)
    assert (project / "hello.py").read_text() == "print('written')\n"
    assert any(m["type"] == "fs.changed" and m["path"] == "hello.py" for m in seen)
    c.close()


def test_acp_write_respects_deny_rules(daemon, project, fake_acp):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"deny": ["write(hello.py)"]}))
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "fswrite"})
    _, seen = c.until("turn.end", timeout=30)
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "write failed"
    assert "'hello'" in (project / "hello.py").read_text()
    c.close()


def test_acp_terminal_runs_in_harness(daemon, project, fake_acp):
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "term"})
    _, seen = c.until("turn.end", timeout=30)
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "exit=0 out=hi-from-term"
    start = next(m for m in seen if m["type"] == "tool.start" and m["id"] == "call_t")
    assert start["name"] == "bash" and start["input"] == {"command": "echo hi-from-term"}
    result = next(m for m in seen if m["type"] == "tool.result" and m["id"] == "call_t")
    assert result["output"].strip() == "hi-from-term"
    c.close()


def test_acp_harness_mcp_server(daemon, project, fake_acp):
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "mcp"})
    _, seen = c.until("turn.end", timeout=30)
    text = "".join(m["text"] for m in seen if m["type"] == "token")
    tools = text.split(" call=")[0].removeprefix("tools=").split(",")
    assert "cron_list" in tools and "show_document" in tools
    assert not {"bash", "read", "edit", "update_plan"} & set(tools)  # The harness has its own.
    assert text.endswith("call=No scheduled tasks.")
    sent = [json.loads(line) for line in fake_acp.read_text().splitlines()]
    server = next(m for m in sent if m.get("method") == "session/new")["params"]["mcpServers"][0]
    assert server["type"] == "http" and server["name"] == "harness" and "/acp-mcp/" in server["url"]

    # The stdio bridge gives the same server to a harness with no HTTP MCP support.
    import subprocess
    bridge = subprocess.run([sys.executable, "-m", "harness_daemon", "--mcp-bridge", server["url"]],
                            input=json.dumps({"jsonrpc": "2.0", "id": 7, "method": "ping"}) + "\n",
                            capture_output=True, text=True, timeout=60,
                            cwd=str(Path(__file__).resolve().parents[1]))
    assert json.loads(bridge.stdout) == {"jsonrpc": "2.0", "id": 7, "result": {}}
    c.close()


def test_acp_harness_mcp_cards(daemon, project, fake_acp):
    """A card of a Harness MCP tool (send_file) shows on the tool row of the harness, or on its own row."""
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "prompt", "text": "mcpcard"})
    _, seen = c.until("turn.end", timeout=30)
    results = [m for m in seen if m["type"] == "tool.result"]
    reported = next(m for m in results if m["id"] == "call_m")
    assert reported["card"]["type"] == "files" and reported["card"]["files"][0]["path"] == "hello.py"
    assert reported["card"]["caption"] == ""
    other = next(m for m in results if m.get("card", {}).get("caption") == "unreported")
    assert other["id"] != "call_m"
    start = next(m for m in seen if m["type"] == "tool.start" and m["id"] == other["id"])
    assert start["name"] == "send_file" and start["input"] == {"files": ["hello.py"], "caption": "unreported"}
    c.close()

    # The stored session keeps the cards.
    c2 = Client(daemon)
    c2.until("auth.ok")
    c2.send({"type": "session.resume", "session_id": ready["session_id"]})
    history = c2.until("session.ready")[0]["history"]
    cards = {m["tool_call_id"]: m["card"]["caption"] for m in history if m["role"] == "tool" and m.get("card")}
    assert cards == {"call_m": "", other["id"]: "unreported"}
    c2.close()


def test_mcp_server_entry_without_http_support():
    from harness_daemon.acp_mcp import server_entry
    entry = server_entry({"mcpCapabilities": {"http": False}}, "http://127.0.0.1:1/acp-mcp/x")
    assert entry["name"] == "harness" and entry["args"][-2:] == ["--mcp-bridge", "http://127.0.0.1:1/acp-mcp/x"]
    assert server_entry({"mcpCapabilities": {"http": True}}, "u") == {"type": "http", "name": "harness", "url": "u",
                                                                      "headers": []}
