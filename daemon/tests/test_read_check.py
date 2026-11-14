"""edit and write reject a change to a file that the agent did not read, or that changed after the read."""

from __future__ import annotations

import asyncio

import pytest

from harness_daemon import config
from harness_daemon.tools import EditTool, ReadState, ReadTool, ToolContext, ToolError, WriteTool, detect_shell

from test_agent import make_agent


def test_the_product_default_is_on(monkeypatch):
    monkeypatch.undo()  # conftest.py turns the check off for the other tests.
    assert config.DEFAULT_SETTINGS["read_before_edit"] is True


@pytest.fixture
def ctx(project):
    return ToolContext(cwd=project, settings=dict(config.DEFAULT_SETTINGS), shell=detect_shell(), reads=ReadState())


def run(coro):
    return asyncio.run(coro)


EDIT = {"path": "hello.py", "old_string": "'hello'", "new_string": "'hi'"}


def test_an_edit_with_no_read_fails_with_the_fix(ctx, project):
    with pytest.raises(ToolError, match="You did not read hello.py in this session. Read it with the read tool"):
        run(EditTool().prepare(EDIT, ctx))
    assert "'hello'" in (project / "hello.py").read_text()


def test_read_then_edit_then_edit_again(ctx, project):
    run(ReadTool().run({"path": "hello.py"}, ctx))
    run(EditTool().run(EDIT, ctx))
    # The agent knows the text that it wrote: a second edit needs no new read.
    run(EditTool().run({"path": "hello.py", "old_string": "'hi'", "new_string": "'hey'"}, ctx))
    assert "'hey'" in (project / "hello.py").read_text()


def test_a_partial_read_counts(ctx):
    run(ReadTool().run({"path": "hello.py", "offset": 2, "limit": 1}, ctx))
    run(EditTool().prepare(EDIT, ctx))


def test_a_change_on_disk_after_the_read_fails(ctx, project):
    run(ReadTool().run({"path": "hello.py"}, ctx))
    (project / "hello.py").write_text("def greet():\n    return 'hello'  # changed\n")
    with pytest.raises(ToolError, match="hello.py changed after you read it"):
        run(EditTool().prepare(EDIT, ctx))


def test_write_creates_a_new_file_with_no_read_then_edits_it(ctx, project):
    run(WriteTool().run({"path": "new.txt", "content": "one\n"}, ctx))
    run(EditTool().run({"path": "new.txt", "old_string": "one", "new_string": "two"}, ctx))
    assert (project / "new.txt").read_text() == "two\n"


def test_write_over_an_unread_file_fails(ctx):
    with pytest.raises(ToolError, match="hello.py exists, and you did not read it"):
        run(WriteTool().prepare({"path": "hello.py", "content": "x"}, ctx))


def test_no_read_state_means_no_check(project):
    bare = ToolContext(cwd=project, settings=dict(config.DEFAULT_SETTINGS), shell=detect_shell())
    run(EditTool().prepare(EDIT, bare))


def test_forget(ctx):
    run(ReadTool().run({"path": "hello.py"}, ctx))
    ctx.reads.forget()
    with pytest.raises(ToolError, match="did not read"):
        run(EditTool().prepare(EDIT, ctx))


def test_the_agent_rejects_an_edit_with_no_read_and_asks_no_permission(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "edit", "arguments": EDIT}]},
        {"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}]},
        {"tool_calls": [{"name": "edit", "arguments": EDIT}]},
        {"text": "Done."},
    )
    agent, events, requests = make_agent(project, read_before_edit=True)
    assert asyncio.run(agent.run_turn("change hello to hi")) == "end"
    results = [e for e in events if e["type"] == "tool.result"]
    assert results[0]["is_error"] and "did not read hello.py" in results[0]["output"]
    assert not results[2]["is_error"]
    assert len(requests) == 1  # The rejected edit showed no permission card.
    assert "'hi'" in (project / "hello.py").read_text()


def test_the_setting_turns_the_check_off_and_rewind_forgets(harness_home, project):
    agent, _, _ = make_agent(project, read_before_edit=True)
    assert agent.ctx.reads is not None
    agent.ctx.reads.note(project / "hello.py", (project / "hello.py").read_bytes())
    agent.rewind(0)
    assert agent.ctx.reads.files == {}
    agent.reload_settings({**agent.settings, "read_before_edit": False})
    assert agent.ctx.reads is None
