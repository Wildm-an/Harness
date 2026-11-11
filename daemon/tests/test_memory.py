"""Auto memory (memory.py, tools/memory.py)."""

from __future__ import annotations

import asyncio
import base64
import io
import zipfile
from pathlib import Path

import pytest

from harness_daemon.memory import MemoryError, MemoryStore, memory_dir, parse_import, project_root

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


def test_sensitive_topics_follow_the_setting(harness_home, project, fake_model):
    agent, _, _ = make_agent(project)
    assert "Do not save sensitive topics" in agent.system_prompt
    agent.reload_settings({**agent.settings, "memory_sensitive": True})
    assert "Do not save sensitive topics" not in agent.system_prompt and "You can save sensitive topics" in agent.system_prompt


def test_parse_import_reads_typed_lines():
    text = "Here you go:\n- [user] I am a data engineer.\n2. feedback: Keep answers short.\n```\n[Project] Ship v2 on 2026-12-01.\n"
    assert parse_import(text) == [
        {"type": "user", "content": "Here you go:"},
        {"type": "user", "content": "I am a data engineer."},
        {"type": "feedback", "content": "Keep answers short."},
        {"type": "project", "content": "Ship v2 on 2026-12-01."},
    ]


def test_import_entries_and_export(harness_home, project):
    store = MemoryStore(project)
    assert store.import_facts([{"type": "user", "content": "I am a data engineer."},
                               {"type": "user", "content": "I am a data engineer."},
                               {"type": "bad", "content": "word " * 60}]) == 3
    entries = store.entries()
    assert [e["name"] for e in entries] == ["i-am-a-data-engineer", "i-am-a-data-engineer-2", "word-word-word-word-word-word"]
    assert entries[0] == {"name": "i-am-a-data-engineer", "description": "I am a data engineer.", "type": "user",
                          "content": "I am a data engineer."}
    assert len(entries[2]["description"]) == 200
    names = zipfile.ZipFile(io.BytesIO(base64.b64decode(store.export_zip()))).namelist()
    assert sorted(names) == ["memory/MEMORY.md", "memory/i-am-a-data-engineer-2.md", "memory/i-am-a-data-engineer.md",
                             "memory/word-word-word-word-word-word.md"]


def test_the_settings_page_manages_the_memory(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    cwd = str(project)
    c.send({"type": "memory.list", "cwd": cwd})
    got = c.until("memory")[0]
    assert got["items"] == [] and "[type] fact" in got["import_prompt"]
    c.send({"type": "memory.save", "cwd": cwd, "name": "role", "description": "The role.", "memory_type": "user",
            "content": "Engineer."})
    assert [i["name"] for i in c.until("memory")[0]["items"]] == ["role"]
    c.send({"type": "memory.save", "cwd": cwd, "old_name": "role", "name": "user-role", "description": "The role.",
            "memory_type": "feedback", "content": "Engineer."})
    items = c.until("memory")[0]["items"]
    assert [(i["name"], i["type"]) for i in items] == [("user-role", "feedback")]
    c.send({"type": "memory.save", "cwd": cwd, "name": "Bad Name", "description": "d", "memory_type": "user", "content": "c"})
    assert "kebab-case" in c.until("error")[0]["message"]
    c.send({"type": "memory.parse", "text": "[project] Ship it."})
    assert c.until("memory.parsed")[0]["items"] == [{"type": "project", "content": "Ship it."}]
    c.send({"type": "memory.import", "cwd": cwd, "items": [{"type": "project", "content": "Ship it."}]})
    got = c.until("memory")[0]
    assert got["imported"] == 1 and len(got["items"]) == 2
    c.send({"type": "memory.export", "cwd": cwd})
    got = c.until("memory.export")[0]
    assert got["count"] == 2 and got["name"].endswith("-memory.zip") and base64.b64decode(got["data"])[:2] == b"PK"
    c.send({"type": "memory.delete", "cwd": cwd, "name": "user-role"})
    assert [i["name"] for i in c.until("memory")[0]["items"]] == ["ship-it"]
    c.close()


def _harness_notes(fake_model):
    return [m["content"] for r in fake_model.requests for m in r["messages"]
            if m.get("role") == "user" and "saved nothing to the memory" in str(m.get("content"))]


def test_a_preference_with_no_save_gets_one_memory_check(harness_home, project, fake_model):
    fake_model.script(
        {"text": "OK."},
        {"tool_calls": [{"name": "memory", "arguments": {"action": "save", "name": "short-answers",
                                                         "description": "The user wants short answers.",
                                                         "type": "feedback", "content": "Keep answers short."}}]},
        {"text": ""},
    )
    agent, _, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("From now on, keep answers short.")) == "end"
    assert len(fake_model.requests) == 3 and fake_model.replies == []
    assert len(set(_harness_notes(fake_model))) == 1
    assert "Keep answers short." in MemoryStore(project).read("short-answers")


def test_the_memory_check_comes_one_time_in_a_turn(harness_home, project, fake_model):
    fake_model.script({"text": "OK."}, {"text": ""})
    agent, _, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("Always use tabs.")) == "end"
    assert len(fake_model.requests) == 2


def test_no_memory_check_for_a_short_turn_or_a_turn_that_saved(harness_home, project, fake_model):
    fake_model.script({"text": "Hello."})
    agent, _, _ = make_agent(project)
    asyncio.run(agent.run_turn("hi"))
    assert len(fake_model.requests) == 1
    fake_model.requests.clear()
    fake_model.script(
        {"tool_calls": [{"name": "memory", "arguments": {"action": "save", "name": "tabs", "description": "Tabs.",
                                                         "type": "feedback", "content": "Use tabs."}}]},
        {"text": "Saved."},
    )
    asyncio.run(agent.run_turn("Remember: always use tabs."))
    assert len(fake_model.requests) == 2 and _harness_notes(fake_model) == []


def test_no_memory_check_when_the_memory_is_off(harness_home, project, fake_model):
    fake_model.script({"text": "OK."})
    agent, _, _ = make_agent(project, auto_memory=False)
    asyncio.run(agent.run_turn("From now on, keep answers short."))
    assert len(fake_model.requests) == 1


def test_a_long_turn_gets_the_memory_check(harness_home, project, fake_model):
    from harness_daemon.agent import MEMORY_CHECK_CALLS
    (project / "a.txt").write_text("x", encoding="utf-8")
    fake_model.script(*[{"tool_calls": [{"name": "read", "arguments": {"path": "a.txt"}}]}] * MEMORY_CHECK_CALLS,
                      {"text": "Done."}, {"text": ""})
    agent, _, _ = make_agent(project)
    assert asyncio.run(agent.run_turn("Look at the file.")) == "end"
    assert len(_harness_notes(fake_model)) >= 1 and fake_model.replies == []
