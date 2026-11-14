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


# -- 11b: edits of one file, alternation, and the question after repeated strong reminders ------------------

from harness_daemon.loop_guards import (  # noqa: E402
    ALTERNATE_CYCLES, EDIT_NOTE_EVERY, LOOP_CONTINUE_NOTE, LOOP_QUESTION, alternate_due, alternation, edit_note,
)


def test_alternation():
    assert alternation([]) == 0 and alternation(["a"]) == 0 and alternation(["a", "a"]) == 0
    assert alternation(["a", "b"]) == 2
    assert alternation(["c", "a", "b", "a", "b"]) == 4
    assert alternation(["a", "b", "a", "b", "a", "b"]) == 6
    assert alternation(["a", "b", "a", "b", "b"]) == 0
    assert [alternate_due(n) for n in (4, 5, 6, 7, 8)] == [False, False, True, False, True]
    assert ALTERNATE_CYCLES == 3


def test_edit_note_counts():
    assert edit_note("a.py", 7) is None and edit_note("a.py", 0) is None
    assert "a.py 8 times" in edit_note("a.py", EDIT_NOTE_EVERY) and edit_note("a.py", 16)


def test_many_edits_of_one_file_get_a_note(harness_home, project, fake_model):
    calls = [{"tool_calls": [{"name": "write", "arguments": {"path": "hello.py", "content": f"print({i})\n"}}]}
             for i in range(8)]
    fake_model.script(*calls, {"text": "Done."}, {"text": "Done."})  # The second: a check after file changes.
    agent, events, _ = make_agent(project, permission_mode="acceptEdits")
    assert asyncio.run(agent.run_turn("go")) == "end"
    outputs = [e["output"] for e in events if e["type"] == "tool.result"]
    assert len(outputs) == 8
    assert "You changed hello.py 8 times in this turn" in outputs[7]
    assert not any("times in this turn" in o for o in outputs[:7])


def _changing_reads(project, agent):
    original = agent._execute

    async def changing(name, args, parse_error, call_id=""):
        result = await original(name, args, parse_error, call_id)
        for f in ("a.txt", "b.txt"):
            (project / f).write_text((project / f).read_text() + " more")
        return result

    agent._execute = changing


def test_alternating_calls_get_a_note(harness_home, project, fake_model):
    (project / "a.txt").write_text("a")
    (project / "b.txt").write_text("b")
    calls = [{"tool_calls": [{"name": "read", "arguments": {"path": f"{'ab'[i % 2]}.txt"}}]} for i in range(6)]
    fake_model.script(*calls, {"text": "Done."})
    agent, events, _ = make_agent(project)
    _changing_reads(project, agent)
    assert asyncio.run(agent.run_turn("go")) == "end"
    outputs = [e["output"] for e in events if e["type"] == "tool.result"]
    assert "You alternate between two tool calls, read and read" in outputs[5]
    assert "You made 6 such calls" in outputs[5]
    assert not any("You alternate" in o for o in outputs[:5])


def _loop_agent(project, fake_model, answer, *after, user_facing=True):
    call = {"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]}
    fake_model.script(*([call] * 7), *after)
    agent, events, _ = make_agent(project)
    agent.user_facing = user_facing
    asked = []

    async def approver(request):
        asked.append(request)
        return answer

    agent.gate.approver = approver
    return agent, events, asked


def test_the_user_is_asked_after_three_strong_reminders(harness_home, project, fake_model):
    agent, events, asked = _loop_agent(project, fake_model, {"answers": {LOOP_QUESTION: "Stop the turn"}})
    assert asyncio.run(agent.run_turn("go")) == "loop"
    assert len(asked) == 1 and asked[0]["kind"] == "question"
    assert asked[0]["questions"][0]["options"][0]["label"] == "Stop the turn"
    assert len(fake_model.requests) == 7  # No final report: the user is present.
    assert events[-1]["stop_reason"] == "loop"


def test_continue_resets_the_loop_count(harness_home, project, fake_model):
    agent, events, asked = _loop_agent(project, fake_model, {"answers": {LOOP_QUESTION: "Continue"}},
                                       {"text": "I will try another way."})
    assert asyncio.run(agent.run_turn("go")) == "end"
    assert len(asked) == 1
    last = fake_model.requests[-1]["messages"][-1]["content"]
    assert LOOP_CONTINUE_NOTE in str(last)


def test_a_typed_answer_goes_to_the_agent(harness_home, project, fake_model):
    agent, events, asked = _loop_agent(project, fake_model, {"answers": {LOOP_QUESTION: "Read config.py instead"}},
                                       {"text": "OK."})
    assert asyncio.run(agent.run_turn("go")) == "end"
    assert "The user answered: Read config.py instead" in str(fake_model.requests[-1]["messages"][-1]["content"])


def test_a_subagent_loop_ends_with_a_report(harness_home, project, fake_model):
    agent, events, asked = _loop_agent(project, fake_model, None, {"text": "The read gave the same text 7 times."},
                                       user_facing=False)
    assert asyncio.run(agent.run_turn("go")) == "loop"
    assert asked == []
    assert agent.history[-1] == {"role": "assistant", "content": "The read gave the same text 7 times."} or \
        agent.history[-1].get("content") == "The read gave the same text 7 times."
    assert "repeated the same tool calls with no progress, so it ends now" in str(
        fake_model.requests[-1]["messages"][-1]["content"])
