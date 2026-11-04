"""Auto memory (memory.py, tools/memory.py)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from harness_daemon.memory import MemoryError, MemoryStore, memory_dir, project_root

from test_agent import make_agent
from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_save_update_and_delete_keep_the_index(harness_home, project):
    store = MemoryStore(project)
    assert store.dir.is_relative_to(harness_home / "projects") and store.dir.name == "memory"
    assert store.save("user-role", "The user is a data scientist.", "user", "Knows Python well.") == "Saved the memory user-role."
    store.save("release-steps", "How to release.", "project", "Push one tag at a time.\nWhy: CI.")
    assert store.index() == ("- [user-role](user-role.md) — The user is a data scientist.\n"
                             "- [release-steps](release-steps.md) — How to release.\n")
    assert store.save("user-role", "The user is an engineer.", "user", "Go and Rust.") == "Updated the memory user-role."
    assert store.index().splitlines()[0] == "- [user-role](user-role.md) — The user is an engineer."
    text = store.read("user-role")
    assert text.startswith("---\nname: user-role\ndescription: The user is an engineer.\ntype: user\n---") and "Go and Rust." in text
    assert [i["name"] for i in store.items()] == ["user-role", "release-steps"]
    store.delete("user-role")
    assert store.index() == "- [release-steps](release-steps.md) — How to release.\n"
    assert not (store.dir / "user-role.md").exists()


def test_bad_memories_are_errors(harness_home, project):
    store = MemoryStore(project)
    for args in (("Bad Name", "d", "user", "c"), ("ok", "", "user", "c"), ("ok", "d", "secret", "c"),
                 ("ok", "d", "user", ""), ("ok", "d", "user", "x" * 6000), ("../up", "d", "user", "c")):
        with pytest.raises(MemoryError):
            store.save(*args)
    with pytest.raises(MemoryError):
        store.read("nothing-here")


def test_a_worktree_uses_the_memory_of_its_project(harness_home, project):
    worktree = project / ".harness" / "worktrees" / "fix-bug"
    assert project_root(worktree) == project
    assert memory_dir(worktree) == memory_dir(project)


def test_the_agent_gets_the_index_and_the_tool(harness_home, project, fake_model):
    MemoryStore(project).save("test-command", "The tests run with make check.", "project", "make check")
    agent, _, _ = make_agent(project)
    assert "memory" in agent.tools
    assert "# Memory" in agent.system_prompt and "- [test-command](test-command.md)" in agent.system_prompt
    agent.reload_settings({**agent.settings, "auto_memory": False})
    assert "memory" not in agent.tools and "# Memory" not in agent.system_prompt


def test_the_agent_saves_a_memory_with_the_tool(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "memory", "arguments": {"action": "save", "name": "no-commits",
                                                         "description": "The user makes the commits.", "type": "feedback",
                                                         "content": "Do not commit.\nWhy: the user reviews first."}}]},
        {"text": "I will remember."},
    )
    agent, events, requests = make_agent(project)
    asyncio.run(agent.run_turn("Remember: do not commit."))
    assert requests == []  # The memory needs no approval.
    assert "Do not commit." in MemoryStore(project).read("no-commits")


def test_the_memory_command_lists_the_memories(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "command", "name": "memory", "args": ""})
    got = c.until("command.result")[0]
    assert got["items"] == [] and "No memories yet." in got["text"] and got["path"].endswith("memory")
    c.close()
