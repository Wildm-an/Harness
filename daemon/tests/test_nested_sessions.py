"""Nested sessions: the parent link of a fork and of the start_session tool (tools/sessions.py)."""

from __future__ import annotations

import time

from harness_daemon.storage import Storage

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.


def test_storage_keeps_the_parent(tmp_path, project):
    storage = Storage(tmp_path / "harness.db")
    parent = storage.create_session(str(project), "fake", "test-model")
    child = storage.create_session(str(project), "fake", "test-model", parent_id=parent)
    grandchild = storage.create_session(str(project), "fake", "test-model", parent_id=child)
    rows = {r["id"]: r for r in storage.list_sessions()}
    assert rows[parent]["parent_id"] is None and rows[child]["parent_id"] == parent
    assert [storage.session_depth(s) for s in (parent, child, grandchild)] == [0, 1, 2]

    # A deleted parent: its nested sessions stay, with no parent.
    storage.delete_session(parent)
    rows = {r["id"]: r for r in storage.list_sessions()}
    assert parent not in rows and rows[child]["parent_id"] is None and rows[grandchild]["parent_id"] == child
    storage.close()


def test_an_old_database_gets_the_parent_column(tmp_path, project):
    import sqlite3

    path = tmp_path / "old.db"
    db = sqlite3.connect(str(path))
    db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, provider TEXT NOT NULL, "
               "model TEXT NOT NULL, title TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL, "
               "context_start INTEGER NOT NULL DEFAULT 0)")
    db.execute("INSERT INTO sessions VALUES ('old', ?, 'fake', 'test-model', 'Old', 1, 1, 0)", (str(project),))
    db.commit()
    db.close()
    storage = Storage(path)
    assert storage.list_sessions()[0]["parent_id"] is None
    storage.close()


def test_a_fork_is_nested_under_its_source(daemon, project, fake_model):  # noqa: F811
    fake_model.script({"text": "First reply."})
    c = Client(daemon)
    source = c.new_session(project)["session_id"]
    c.send({"type": "prompt", "text": "hello", "id": "p1"})
    c.until("turn.end")
    c.send({"type": "session.fork", "id": "p1"})
    fork = c.until("session.ready")[0]["session_id"]
    c.send({"type": "session.list"})
    rows = {s["id"]: s for s in c.until("sessions")[0]["items"]}
    assert rows[fork]["parent_id"] == source and rows[source]["parent_id"] is None
    c.close()


def _rows(c: Client) -> dict[str, dict]:
    c.send({"type": "session.list"})
    return {s["id"]: s for s in c.until("sessions")[0]["items"]}


def test_the_agent_starts_a_nested_session(daemon, project, fake_model):  # noqa: F811
    a, b = Client(daemon), Client(daemon)
    parent = a.new_session(project)["session_id"]
    b.until("auth.ok")
    fake_model.script(
        {"tool_calls": [{"name": "start_session", "arguments": {
            "title": "Write the docs", "prompt": "Write docs/notes.md with one line."}}]},
        # The nested session gets this reply: its first user message is the prompt.
        {"when": "Write docs/notes.md", "text": "The nested session is done."},
        {"text": "Started it."},
    )
    a.send({"type": "prompt", "text": "Start a session for the docs"})
    request = a.until("permission.request")[0]
    assert request["tool"] == "start_session"
    assert request["input"]["title"] == "Write the docs" and request["input"]["permission_mode"] == "Manual"
    assert request["input"]["folder"] == str(project) and request["input"]["worktree"] is False
    a.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    a.until("turn.end")
    result = [m["content"] for m in fake_model.requests[-1]["messages"] if m["role"] == "tool"][-1]
    assert "Started the session 'Write the docs'" in result

    child = None
    for _ in range(80):  # The nested session runs in the background.
        child = next((s for s in _rows(b).values() if s["parent_id"] == parent), None)
        if child:
            break
        time.sleep(0.1)
    assert child is not None and child["title"] == "Write the docs" and child["cwd"] == str(project)

    # The other window sees the nested session in the background list. Wait for the end of its turn.
    for _ in range(80):
        b.send({"type": "session.list"})  # Any reply: the background messages come between.
        _msg, seen = b.until("sessions")
        background = [m for m in seen if m["type"] == "sessions.background"]
        if background and not any(i["session_id"] == child["id"] for i in background[-1]["items"]):
            break
        time.sleep(0.1)
    b.send({"type": "session.resume", "session_id": child["id"]})
    ready = b.until("session.ready")[0]
    texts = [m.get("content") for m in ready["history"] if m["role"] == "assistant"]
    assert "The nested session is done." in texts
    a.close()
    b.close()


def test_a_nested_session_of_a_nested_session_cannot_start_more(tmp_path, project):
    import asyncio

    import pytest

    from harness_daemon import server
    from harness_daemon.tools.base import ToolError

    storage = Storage(tmp_path / "harness.db")
    top = storage.create_session(str(project), "fake", "test-model")
    mid = storage.create_session(str(project), "fake", "test-model", parent_id=top)
    low = storage.create_session(str(project), "fake", "test-model", parent_id=mid)

    class Parent:
        id = low

    old = server.HEADLESS
    server.HEADLESS = server.HeadlessConnection(storage)
    try:
        with pytest.raises(ToolError, match="cannot start more sessions"):
            asyncio.run(server.start_child_session(Parent(), "x", "y", False, "default"))  # type: ignore[arg-type]
    finally:
        server.HEADLESS = old
        storage.close()
