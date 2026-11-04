"""Agent types (agents.py): the built-in types, the agent files, and the subagents that use them."""

from __future__ import annotations

from harness_daemon.agents import BUILT_IN, discover_agents, map_tools, parse_agent

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def write_agent(folder, name, text):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.md").write_text(text, encoding="utf-8")


def test_the_built_in_types(project, harness_home):
    types = discover_agents(project)
    assert list(types)[:3] == ["general-purpose", "Explore", "Plan"]
    assert types["general-purpose"].tools is None
    explore = types["Explore"]
    assert explore.allows("read") and explore.allows("grep") and not explore.allows("edit") and not explore.allows("write")


def test_claude_code_tool_names_become_harness_tools():
    assert map_tools("Read, Grep, Glob, Bash") == ("read", "grep", "glob", "bash", "task_output", "task_stop", "monitor")
    assert map_tools(["WebFetch", "WebSearch", "mcp__github__*", "Bash(git log:*)"]) == (
        "web_fetch", "web_search", "mcp__github__*", "bash", "task_output", "task_stop", "monitor")
    assert map_tools(None) is None and map_tools("*") is None


def test_agent_files_and_their_priority(project, harness_home, tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    write_agent(tmp_path / "claude-home" / "agents", "reviewer", "---\nname: reviewer\ndescription: User reviewer.\n---\nUser.")
    write_agent(project / ".claude" / "agents", "reviewer",
                "---\nname: reviewer\ndescription: Reviews the diff.\ntools: Read, Grep\nmodel: inherit\n---\nReview it.")
    write_agent(project / ".claude" / "agents", "runner", "---\ndescription: Runs tests.\nmodel: sonnet\n---\nRun them.")
    write_agent(project / ".harness" / "agents", "runner",
                "---\nname: runner\ndescription: Harness runner.\nmodel: demo/fast\n---\nRun fast.")
    write_agent(project / ".claude" / "agents", "broken", "---\nname: broken\n---\nNo description.")
    types = discover_agents(project)
    assert types["reviewer"].description == "Reviews the diff." and types["reviewer"].source == "project"
    assert types["reviewer"].tools == ("read", "grep") and types["reviewer"].model is None
    assert types["reviewer"].prompt == "Review it."
    assert types["runner"].description == "Harness runner." and types["runner"].model == "demo/fast"
    assert "broken" not in types
    assert parse_agent(project / ".claude" / "agents" / "runner.md", "project").model is None  # "sonnet": inherit.
    assert len(BUILT_IN) == 3


def test_an_explore_subagent_has_only_read_tools_and_its_prompt(daemon, project, fake_model):  # noqa: F811
    fake_model.script(
        {"tool_calls": [{"name": "agent", "arguments": {"prompt": "Find the main file", "description": "Find main",
                                                        "subagent_type": "Explore"}}]},
        {"when": "Find the main file", "text": "hello.py:1 is the main file."},  # The subagent.
        {"text": "The main file is hello.py."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Where is the main file?"})
    c.until("turn.end")
    first = fake_model.requests[0]
    agent_tool = next(t for t in first["tools"] if t["function"]["name"] == "agent")["function"]
    assert agent_tool["parameters"]["properties"]["subagent_type"]["enum"][:3] == ["general-purpose", "Explore", "Plan"]
    assert "- Explore:" in agent_tool["description"]
    sub = next(r for r in fake_model.requests if "Find the main file" in str(r["messages"][1].get("content")))
    names = {t["function"]["name"] for t in sub["tools"]}
    assert {"read", "grep", "glob"} <= names and not names & {"edit", "write", "office_edit", "agent"}
    assert "You are an Explore agent" in sub["messages"][0]["content"]
    result = next(m for m in fake_model.requests[-1]["messages"] if m["role"] == "tool")["content"]
    assert "hello.py:1 is the main file." in result
    c.close()


def test_an_unknown_agent_type_is_an_error_for_the_model(daemon, project, fake_model):  # noqa: F811
    fake_model.script(
        {"tool_calls": [{"name": "agent", "arguments": {"prompt": "x", "description": "x", "subagent_type": "nobody"}}]},
        {"text": "I will use another type."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Use nobody"})
    c.until("turn.end")
    result = next(m for m in fake_model.requests[-1]["messages"] if m["role"] == "tool")["content"]
    assert "Unknown agent type: nobody" in result and "Explore" in result
    c.close()


def test_the_agents_command_lists_the_types(daemon, project, fake_model):  # noqa: F811
    write_agent(project / ".harness" / "agents", "docs-writer", "---\ndescription: Writes the docs.\n---\nWrite.")
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "command", "name": "agents", "args": ""})
    got = c.until("command.result")[0]
    assert [i["name"] for i in got["items"]][:3] == ["general-purpose", "Explore", "Plan"]
    assert "docs-writer (project) - Writes the docs." in got["text"]
    c.close()
