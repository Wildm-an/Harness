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
    # The Harness permission gate asks: "Always allow" saves a Harness rule in the project settings.
    assert "+    return 'hey'" in request["diff"] and request["rule"] == "edit(hello.py)"
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


def test_acp_permission_requests_use_the_harness_rules(daemon, project, fake_acp):
    """The permission rules of Harness apply to the requests of another harness: an allow rule answers with no
    question, and a deny rule rejects the call."""
    from harness_daemon.permissions import PermissionRules
    rules = PermissionRules(project)
    rules.write(["edit(hello.py)"], [])
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "edit"})
    end, seen = c.until("turn.end", timeout=30)
    assert not any(m["type"] == "permission.request" for m in seen)
    assert "'hey'" in (project / "hello.py").read_text()
    c.close()

    (project / "hello.py").write_bytes(b"def greet():\n    return 'hello'\n\nprint(greet())\n")
    rules.write([], ["edit(hello.py)"])
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "edit"})
    end, seen = c.until("turn.end", timeout=30)
    assert not any(m["type"] == "permission.request" for m in seen)
    result = next(m for m in seen if m["type"] == "tool.result" and m["id"] == "call_1")
    assert result["is_error"] and "'hello'" in (project / "hello.py").read_text()
    c.close()


def test_auto_mode_of_another_harness_with_no_model_asks():
    """Auto mode needs a model to check the calls. The model of another harness is not in Harness: with no Harness
    provider model, the gate asks the user, as Manual mode does."""
    from harness_daemon.acp import AcpAgent
    agent = AcpAgent.__new__(AcpAgent)
    agent.settings = {"permission_mode": "auto"}
    agent.auto_client = None
    agent._chosen_mode = None

    class Gate:
        auto = type("A", (), {"available": lambda self: False})()
    agent.gate = Gate()
    assert agent._gate_mode() == "default"
    Gate.auto = type("A", (), {"available": lambda self: True})()
    assert agent._gate_mode() == "auto"
    agent.settings = {"permission_mode": "acceptEdits"}
    assert agent._gate_mode() == "acceptEdits"


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
    assert [i["id"] for i in recommended] == ["claude-acp", "codex-acp", "grok-build", "gemini", "cursor", "opencode", "hermes"]
    assert recommended[0]["reason"] and not recommended[0]["local_models"] and recommended[5]["local_models"]
    assert all(acp_harnesses.find(i) is not None for i in acp_harnesses.RECOMMENDED)
    hermes = next(i for i in listing["items"] if i["id"] == "hermes")  # Not in the ACP registry.
    assert hermes["name"] == "Hermes Agent" and hermes["command"] == "hermes acp" and hermes["license"] == "MIT"
    omp = next(i for i in listing["items"] if i["id"] == "omp")
    assert omp["command"] == "omp acp" and omp["status"] in ("installed", "downloaded", "missing")
    assert any(i["id"] == "antigravity-acp" and i["name"] == "Google Antigravity" for i in listing["items"])

    c.send({"type": "harnesses.save", "name": "My agent", "command": "my-agent --acp"})
    listing = c.until("harnesses")[0]
    custom = next(i for i in listing["items"] if i["custom"])
    assert custom == {**custom, "id": "custom-my-agent", "name": "My agent", "command": "my-agent --acp"}

    c.send({"type": "user_settings.set", "values": {"operating_harness": "custom-my-agent"}})
    settings = c.until("user_settings")[0]
    assert settings["values"]["operating_harness"] == "custom-my-agent"
    assert settings["harness"] == {"id": "custom-my-agent", "name": "My agent", "model": None,  # For the start screen.
                                   "native_model": None, "models": [], "native_effort": None, "efforts": []}
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


def test_acp_bypass_mode_asks_for_a_hard_rule_match(daemon, project, fake_acp):
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "settings.set", "permission_mode": "bypassPermissions"})
    c.send({"type": "prompt", "text": "sudo"})
    request, _ = c.until("permission.request", timeout=30)
    assert "[Privilege Escalation]" in request["reason"] and request["rule"] is None
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "deny"})
    end, seen = c.until("turn.end", timeout=30)
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "outcome=no"
    c.close()


def test_acp_first_prompt_has_the_harness_instructions(daemon, project, fake_acp):
    """As T3 Code does for its ACP agents, the first prompt of a new ACP session tells the model about the tools
    of the Harness interface. The next prompts do not repeat it, and the chat does not show it."""
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "blocks"})
    _, seen = c.until("turn.end", timeout=30)
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "blocks=2"
    c.send({"type": "prompt", "text": "blocks"})
    _, seen = c.until("turn.end", timeout=30)
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "blocks=1"
    prompts = [m for m in (json.loads(line) for line in fake_acp.read_text().splitlines()) if m.get("method") == "session/prompt"]
    first = prompts[0]["params"]["prompt"][0]["text"]
    assert first.startswith("<harness_instructions>") and "show_visual" in first and "preview_navigate" in first
    assert "<harness_instructions>" not in json.dumps(prompts[1]["params"]["prompt"])
    c.close()


def test_harness_tool_names_in_titles_and_the_instructions():
    from harness_daemon import acp_mcp
    tools = {"show_visual", "ask_user_question", "send_file", "preview_start", "preview_navigate", "preview_snapshot"}
    assert "show_visual" not in acp_mcp.HIDDEN_TOOLS and "ask_user_question" not in acp_mcp.HIDDEN_TOOLS
    assert acp_mcp.tool_of_title("mcp__harness__show_visual", tools) == "show_visual"
    assert acp_mcp.tool_of_title("harness.preview_start", tools) == "preview_start"
    assert acp_mcp.tool_of_title("mcp__editor_harness_aa5f56ca__preview_navigate", tools) == "preview_navigate"  # Hermes
    assert acp_mcp.tool_of_title("send_file (harness MCP Server)", tools) == "send_file"
    assert acp_mcp.tool_of_title("mcp__github__show_visual", tools) is None
    assert acp_mcp.tool_of_title("Run show_visual", tools) is None
    assert acp_mcp.tool_of_title("mcp__harness__bash", tools) is None  # Not a tool of the server.
    block = acp_mcp.instructions(tools)
    assert block.startswith("<harness_instructions>") and block.endswith("</harness_instructions>")
    assert "ask_user_question" in block and "artifact" not in block  # Only the lines of the tools it has.
    assert acp_mcp.instructions({"cron_list"}) == ""


def test_acp_mode_menu_shows_and_changes_the_mode_of_the_harness(daemon, project, fake_acp):
    """The mode menu of an ACP session has the modes of the harness. A choice changes the mode of the harness, and
    the permission gate of Harness follows it."""
    c = Client(daemon)
    c.new_session(project)
    state = c.until("acp.state", timeout=30)[0]["harness"]
    while not state.get("modes") or not state.get("mode"):
        state = c.until("acp.state", timeout=30)[0]["harness"]
    ids = [m["id"] for m in state["modes"]]
    assert "default" in ids and state["mode"] == "default"
    other = next(i for i in ids if i != "default")
    c.send({"type": "acp.mode", "mode": other})
    for _ in range(5):  # An older state can come first.
        state = c.until("acp.state", timeout=30)[0]["harness"]
        if state["mode"] == other:
            break
    assert state["mode"] == other
    sent = [json.loads(line) for line in fake_acp.read_text().splitlines()]
    assert any(m.get("method") == "session/set_mode" and m["params"]["modeId"] == other for m in sent)
    c.send({"type": "acp.mode", "mode": "nope"})
    assert "has no mode" in c.until("error")[0]["message"]
    c.close()


def test_the_harness_modes_map_to_harness_permission_modes():
    from harness_daemon.acp import HARNESS_AUTO, MODE_MAP, AcpAgent
    agent = AcpAgent.__new__(AcpAgent)
    agent.settings = {"permission_mode": "acceptEdits"}
    assert agent.gate_mode_of(None) == "acceptEdits"
    assert agent.gate_mode_of(HARNESS_AUTO) == "auto"
    assert [agent.gate_mode_of(m) for m in ("accept_edits", "dont_ask", "plan", "yolo", "strange")] == \
        ["acceptEdits", "acceptEdits", "plan", "bypassPermissions", "default"]
    assert MODE_MAP["bypassPermissions"] == "bypassPermissions"


def test_the_reasoning_levels_of_a_harness():
    """A config option of the category "thought_level" is the reasoning column of the picker."""
    from harness_daemon.acp import parse_efforts
    result = {"configOptions": [
        {"id": "model", "category": "model", "type": "select", "options": [{"value": "opus", "name": "Opus"}]},
        {"id": "effort", "category": "thought_level", "type": "select", "currentValue": "default", "options": [
            {"value": "default", "name": "Default", "description": "Medium"}, {"value": "low", "name": "Low"},
            {"value": "max", "name": "Max"}]},
    ]}
    assert [e["id"] for e in parse_efforts(result)] == ["default", "low", "max"]
    assert parse_efforts({"configOptions": []}) == [] and parse_efforts(None) == []


def test_the_reasoning_level_for_new_sessions(daemon, harness_home):  # noqa: F811
    from harness_daemon import acp_harnesses
    acp_harnesses.save_efforts("claude-acp", [{"id": "low", "name": "Low", "description": ""}])
    assert acp_harnesses.cached_models("__efforts__") == []  # The levels are not a model list.
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "harnesses.native_effort", "id": "claude-acp", "effort": "low"})
    claude = next(i for i in c.until("harnesses")[0]["items"] if i["id"] == "claude-acp")
    assert claude["native_effort"] == "low" and claude["efforts"][0]["id"] == "low"
    c.send({"type": "harnesses.native_effort", "id": "claude-acp", "effort": None})
    claude = next(i for i in c.until("harnesses")[0]["items"] if i["id"] == "claude-acp")
    assert claude["native_effort"] is None
    c.send({"type": "harnesses.native_effort", "id": "nope", "effort": "low"})
    assert "Unknown harness" in c.until("error")[0]["message"]
    c.close()
