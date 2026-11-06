from __future__ import annotations

import asyncio

from harness_daemon.tools.base import Tool, ToolResult
from harness_daemon.tools.tool_search import search_tools

from test_agent import make_agent


class FakeMcpTool(Tool):
    def __init__(self, name: str, description: str):
        self.name = name
        self.description = description
        self.parameters = {"type": "object", "properties": {"number": {"type": "integer"}}}

    async def run(self, args, ctx):
        return ToolResult(f"ran {self.name}")


def many_tools() -> list[Tool]:
    """MCP tools with long descriptions: more than 4,000 tokens together."""
    filler = "This tool works with the GitHub API of the repository and gives the result as JSON. " * 8
    names = ["create_issue", "get_issue", "list_pull_requests", "create_pull_request"] + [f"other_{i}" for i in range(26)]
    return [FakeMcpTool(f"mcp__github__{n}", f"{n.replace('_', ' ').capitalize()}. {filler}") for n in names]


def sent_names(request: dict) -> list[str]:
    return [t["function"]["name"] for t in request.get("tools") or []]


def test_large_mcp_tools_are_sent_by_name_until_loaded(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "tool_search", "arguments": {"query": "select:mcp__github__create_issue"}}]},
        {"tool_calls": [{"name": "mcp__github__create_issue", "arguments": {"number": 1}}]},
        {"text": "Done."},
    )
    agent, events, _ = make_agent(project)
    agent.set_mcp_tools(many_tools())
    assert asyncio.run(agent.run_turn("make an issue")) == "end"
    first, second, third = fake_model.requests
    assert "tool_search" in sent_names(first)
    assert not [n for n in sent_names(first) if n.startswith("mcp__")]
    search = next(t for t in first["tools"] if t["function"]["name"] == "tool_search")
    assert "mcp__github__create_issue" in search["function"]["description"]
    # After the load, the tool is in the list. The list before it does not change (the cache of the server).
    assert [n for n in sent_names(second) if n.startswith("mcp__")] == ["mcp__github__create_issue"]
    assert first["tools"] == second["tools"][: len(first["tools"])]
    result = next(e for e in events if e["type"] == "tool.result" and e["id"] and "Loaded 1 tool" in e["output"])
    assert '"name": "mcp__github__create_issue"' in result["output"]
    ran = [e for e in events if e["type"] == "tool.result" and e["output"] == "ran mcp__github__create_issue"]
    assert ran and sent_names(third) == sent_names(second)


def test_a_deferred_tool_also_runs_without_a_load(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "mcp__github__get_issue", "arguments": {"number": 2}}]},
        {"text": "Done."},
    )
    agent, events, _ = make_agent(project)
    agent.set_mcp_tools(many_tools())
    assert asyncio.run(agent.run_turn("read issue 2")) == "end"
    assert any(e["type"] == "tool.result" and e["output"] == "ran mcp__github__get_issue" for e in events)


def test_small_mcp_tools_and_the_off_setting_send_all_tools(harness_home, project, fake_model):
    agent, _, _ = make_agent(project)
    agent.set_mcp_tools([FakeMcpTool("mcp__notes__add", "Add a note."), FakeMcpTool("mcp__notes__list", "List the notes.")])
    names = [s["function"]["name"] for s in agent.tool_schemas()]
    assert "mcp__notes__add" in names and "tool_search" not in names

    agent, _, _ = make_agent(project, tool_search="off")
    agent.set_mcp_tools(many_tools())
    names = [s["function"]["name"] for s in agent.tool_schemas()]
    assert len([n for n in names if n.startswith("mcp__")]) == 30 and "tool_search" not in names

    agent, _, _ = make_agent(project, tool_search="on")
    agent.set_mcp_tools([FakeMcpTool("mcp__notes__add", "Add a note.")])
    names = [s["function"]["name"] for s in agent.tool_schemas()]
    assert "tool_search" in names and "mcp__notes__add" not in names


def test_keyword_search_ranks_name_matches_first(harness_home, project):
    agent, _, _ = make_agent(project)
    tools = {t.name: t for t in many_tools()}
    found = search_tools(tools, agent.ctx, "pull request", 3)
    assert found[:2] == ["mcp__github__create_pull_request", "mcp__github__list_pull_requests"]
    assert search_tools(tools, agent.ctx, "select:mcp__github__get_issue, nope", 5) == ["mcp__github__get_issue"]
    assert search_tools(tools, agent.ctx, "zzz", 5) == []
