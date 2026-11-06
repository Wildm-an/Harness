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
    # The nested session sends its own requests at the same time: find the last request of the parent.
    parent_requests = [r for r in fake_model.requests
                       if any(m["role"] == "user" and m.get("content") == "Start a session for the docs" for m in r["messages"])]
    result = [m["content"] for m in parent_requests[-1]["messages"] if m["role"] == "tool"][-1]
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


# -- the context of the other sessions, and offer_session ----------------------------------------


def _first_session(c: Client, project, fake_model) -> str:
    """A session with one turn. The client then starts a second session."""
    fake_model.script({"when": "Fix the typo in README", "text": "Fixed the typo."})
    first = c.new_session(project)["session_id"]
    c.send({"type": "prompt", "text": "Fix the typo in README"})
    _, seen = c.until("turn.end")
    # The fake model is local: the title comes after the turn. Wait for it, so the notes of the next
    # session show the title, not the first prompt (a "when" reply matches the prompt text).
    if not any(m["type"] == "session.title" for m in seen):
        c.until("session.title")
    return first


def _tool_result(fake_model, prompt: str) -> str:
    # The session whose first prompt is ``prompt``. The request joins the harness notes to the user
    # message: compare the start of the text.
    def first_user(r: dict) -> str:
        return str(next((m.get("content") for m in r["messages"] if m["role"] == "user"), ""))
    requests = [r for r in fake_model.requests if first_user(r).startswith(prompt)]
    return [m["content"] for m in requests[-1]["messages"] if m["role"] == "tool"][-1]


def test_the_agent_sees_and_reads_the_other_sessions(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    first = _first_session(c, project, fake_model)
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    c.until("session.ready")
    fake_model.script(
        {"when": "What did the other session do", "tool_calls": [{"name": "session_read", "arguments": {"session_id": first[:8]}}]},
        {"when": "What did the other session do", "text": "It fixed a typo."},
    )
    c.send({"type": "prompt", "text": "What did the other session do"})
    c.until("turn.end")
    request = next(r for r in fake_model.requests
                   if any(str(m.get("content")).startswith("What did the other session do") for m in r["messages"]))
    notes = [m["content"] for m in request["messages"] if m["role"] == "user" and "[Harness: The other sessions" in str(m.get("content"))]
    assert notes and f"- {first[:8]}: " in notes[0]
    result = _tool_result(fake_model, "What did the other session do")
    assert "User: Fix the typo in README" in result and "Agent: Fixed the typo." in result
    c.close()


def test_offer_session_sends_the_prompt_to_a_better_session(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    first = _first_session(c, project, fake_model)
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    c.until("session.ready")
    fake_model.script(
        {"when": "Also fix the typo in CHANGELOG", "tool_calls": [{"name": "offer_session", "arguments": {
            "title": "Typo fixes", "prompt": "Also fix the typo in CHANGELOG", "session_id": first[:8]}}]},
        {"when": "Fix the typo in README", "text": "Fixed the CHANGELOG too."},  # The turn of the first session.
        {"when": "Also fix the typo in CHANGELOG", "text": "Sent it to the typo session."},
    )
    c.send({"type": "prompt", "text": "Also fix the typo in CHANGELOG"})
    request = c.until("permission.request")[0]
    question = request["questions"][0]
    assert question["question"].startswith("Send this to the session ")
    assert [o["label"] for o in question["options"]] == ["Send to that session", "New session", "Do it here"]
    c.send({"type": "question.reply", "request_id": request["request_id"],
            "answers": {question["question"]: "Send to that session"}})
    c.until("turn.end")
    assert "Sent the prompt to the session" in _tool_result(fake_model, "Also fix the typo in CHANGELOG")
    for _ in range(80):  # The first session works on the prompt with no window.
        c.send({"type": "session.list"})
        _msg, seen = c.until("sessions")
        if any(m["type"] == "sessions.background" and not m["items"] for m in seen):
            break
        time.sleep(0.1)
    c.send({"type": "session.resume", "session_id": first})
    ready = c.until("session.ready")[0]
    for _ in range(80):
        if not ready["running"]:
            break
        time.sleep(0.1)
        c.send({"type": "session.resume", "session_id": first})
        ready = c.until("session.ready")[0]
    users = [m.get("content") for m in ready["history"] if m["role"] == "user" and m.get("origin") != "harness"]
    assert users[-1] == "Also fix the typo in CHANGELOG"
    assert "Fixed the CHANGELOG too." in [m.get("content") for m in ready["history"] if m["role"] == "assistant"]
    c.close()


def test_the_setting_keeps_the_task_here(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "user_settings.set", "values": {"new_task_prompt": "here"}})
    assert c.until("user_settings")[0]["values"]["new_task_prompt"] == "here"
    fake_model.script(
        {"tool_calls": [{"name": "offer_session", "arguments": {"title": "Docs", "prompt": "Write the docs."}}]},
        {"text": "I do it here."},
    )
    c.send({"type": "prompt", "text": "Write the docs"})
    _msg, seen = c.until("turn.end")
    assert not any(m["type"] == "permission.request" for m in seen)  # No card.
    assert "Always do it here" in _tool_result(fake_model, "Write the docs")
    c.send({"type": "user_settings.set", "values": {"new_task_prompt": "sometimes"}})
    assert "must be one of" in c.until("error")[0]["message"]
    c.close()
