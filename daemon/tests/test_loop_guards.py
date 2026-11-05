from __future__ import annotations

import asyncio

from harness_daemon.loop_guards import STALL_NUDGE, is_stall, repair_tool_name, repeat_note

from test_agent import make_agent

TOOLS = {"read", "write", "edit", "bash", "glob", "grep", "update_plan", "web_fetch", "mcp__github__list_prs"}


def test_repair_tool_name():
    assert repair_tool_name("read", TOOLS) == "read"
    assert repair_tool_name("Bash", TOOLS) == "bash"
    assert repair_tool_name("read_file", TOOLS) == "read"
    assert repair_tool_name("ReadFile", TOOLS) == "read"
    assert repair_tool_name("functions.edit", TOOLS) == "edit"
    assert repair_tool_name("grep_tool", TOOLS) == "grep"
    assert repair_tool_name("TodoWrite", TOOLS) == "update_plan"
    assert repair_tool_name("web-fetch", TOOLS) == "web_fetch"
    assert repair_tool_name("MCP__GitHub__list_prs", TOOLS) == "mcp__github__list_prs"
    assert repair_tool_name(" 'write' ", TOOLS) == "write"
    # No guesses: an unknown name stays unknown, and an alias needs its tool.
    assert repair_tool_name("fly_to_the_moon", TOOLS) is None
    assert repair_tool_name("task", TOOLS) is None


def test_is_stall():
    assert is_stall("I found the bug. I will now fix the parser.")
    assert is_stall("Next, I'll run the tests.")
    assert is_stall("Let me check the config file:")
    assert is_stall("The import is wrong. Let’s now change it.")
    # Final answers, questions, and long reports are not stalls.
    assert not is_stall("I will remember.")
    assert not is_stall("I will use another type.")
    assert not is_stall("Now I see the problem. The path was wrong, and I fixed it.")
    assert not is_stall("Shall I now run the tests?")
    assert not is_stall("Done. Let me know if you want more changes.")
    assert not is_stall("A long report. " * 40 + "Next, I will add tests.")
    assert not is_stall("")
    assert not is_stall(None)


def test_repeat_note_counts():
    assert repeat_note("read", 2) is None
    assert "3 times" in repeat_note("read", 3)
    assert repeat_note("read", 4) is None
    assert "Do not call this tool with these arguments again" in repeat_note("read", 5)
    assert "6 times" in repeat_note("read", 6)


def test_repaired_name_runs_the_tool(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "ReadFile", "arguments": {"path": "hello.py"}}]},
        {"text": "It defines greet()."},
    )
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("read hello.py")) == "end"
    start = next(e for e in events if e["type"] == "tool.start")
    result = next(e for e in events if e["type"] == "tool.result")
    assert start["name"] == "read"
    assert not result["is_error"] and "def greet" in result["output"]
    assert 'There is no tool "ReadFile". This call ran as "read".' in result["output"]
    # The history holds the real name, for servers that check the names.
    sent = fake_model.requests[1]["messages"]
    assert sent[-2]["tool_calls"][0]["function"]["name"] == "read"


def test_repeated_call_gets_a_reminder(harness_home, project, fake_model):
    call = {"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]}
    fake_model.script(*([call] * 5), {"text": "Done."})
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("read hello.py")) == "end"
    outputs = [e["output"] for e in events if e["type"] == "tool.result"]
    assert len(outputs) == 5
    assert "exact arguments" not in outputs[0] and "exact arguments" not in outputs[1]
    assert "3 times" in outputs[2]
    assert "exact arguments" not in outputs[3]
    assert "Do not call this tool with these arguments again" in outputs[4]


def test_repeat_count_needs_the_same_result(harness_home, project, fake_model):
    # The same command with a different result each time (for example a test run after a fix) makes progress.
    calls = [{"tool_calls": [{"name": "bash", "arguments": {"command": "echo hi", "description": f"Step {i}"}}]}
             for i in range(3)]
    fake_model.script(*calls, {"text": "Done."})
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("go")) == "end"
    outputs = [e["output"] for e in events if e["type"] == "tool.result"]
    assert "3 times" in outputs[2]  # The description is only for the user: the calls are the same.
    (project / "notes.txt").write_text("one")
    fake_model.script(
        {"tool_calls": [{"name": "read", "arguments": {"path": "notes.txt"}}]},
        {"tool_calls": [{"name": "read", "arguments": {"path": "notes.txt"}}]},
        {"tool_calls": [{"name": "read", "arguments": {"path": "notes.txt"}}]},
        {"text": "Done."},
    )
    agent, events, _ = make_agent(project)

    original = agent._execute

    async def changing(name, args, parse_error, call_id=""):
        result = await original(name, args, parse_error, call_id)
        (project / "notes.txt").write_text((project / "notes.txt").read_text() + " more")
        return result

    agent._execute = changing
    assert asyncio.run(agent.run_turn("read notes")) == "end"
    outputs = [e["output"] for e in events if e["type"] == "tool.result"]
    assert not any("exact arguments" in o for o in outputs)


def test_stall_reply_gets_a_nudge(harness_home, project, fake_model):
    fake_model.script(
        {"text": "I found the file. I will now read it."},
        {"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]},
        {"text": "It defines greet()."},
    )
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("what is in hello.py?")) == "end"
    assert len(fake_model.requests) == 3
    nudge = fake_model.requests[1]["messages"][-1]
    assert nudge == {"role": "user", "content": STALL_NUDGE}  # The origin field stays in the Harness.
    assert any(e["type"] == "notice" and "made no tool call" in e["text"] for e in events)
    assert any(e["type"] == "tool.result" and "def greet" in e["output"] for e in events)
    assert agent.history[2]["origin"] == "harness"


def test_stall_nudges_stop_after_two(harness_home, project, fake_model):
    fake_model.script(*([{"text": "I will now read it."}] * 3))
    agent, events, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("go")) == "end"
    assert len(fake_model.requests) == 3  # The first reply and two nudges.
