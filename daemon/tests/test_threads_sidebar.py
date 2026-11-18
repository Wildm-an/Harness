"""The Threads sidebar (docs/UI_RULES.md 3.7): the session fields position, snoozed_until, auto_archive, and
archived_at, the message session.retitle, and the rules of archive_inactive for "Never" and snoozed sessions."""

from __future__ import annotations

import asyncio
import json
import time

from harness_daemon import server
from harness_daemon.storage import Storage

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.

DAY = 86400


def test_new_columns_and_the_position_of_a_new_session(tmp_path, project):
    storage = Storage(tmp_path / "harness.db")
    first = storage.create_session(str(project), "fake", "m")
    rows = {r["id"]: r for r in storage.list_sessions()}
    # No session has a position: the new session has none either (it is the newest, so it is at the top).
    assert rows[first]["position"] is None and rows[first]["snoozed_until"] is None
    assert rows[first]["auto_archive"] is True and rows[first]["archived_at"] is None
    storage.update_session(first, touch=False, position=5.0)
    second = storage.create_session(str(project), "fake", "m")
    rows = {r["id"]: r for r in storage.list_sessions()}
    assert rows[second]["position"] == 4.0  # Above the current top.
    storage.close()


def test_an_old_database_gets_the_new_columns(tmp_path):
    import sqlite3

    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, provider TEXT NOT NULL, "
               "model TEXT NOT NULL, title TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL, "
               "context_start INTEGER NOT NULL DEFAULT 0)")
    db.execute("INSERT INTO sessions (id, cwd, provider, model, created_at, updated_at) VALUES ('a', '/x', 'p', 'm', 1, 1)")
    db.commit()
    db.close()
    storage = Storage(path)
    row = storage.list_sessions()[0]
    assert row["position"] is None and row["snoozed_until"] is None and row["auto_archive"] is True
    assert row["archived_at"] is None
    storage.close()


def test_session_update_sets_the_threads_fields(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    sid = c.new_session(project)["session_id"]
    wake = time.time() + 3600
    c.send({"type": "session.update", "session_id": sid, "position": -2.5, "snoozed_until": wake, "auto_archive": False})
    c.until("session.updated")
    c.send({"type": "session.list"})
    item = c.until("sessions")[0]["items"][0]
    assert item["position"] == -2.5 and item["snoozed_until"] == wake and item["auto_archive"] is False

    # Settle: the client sends archived and pinned together. archived_at is the time of the archive.
    c.send({"type": "session.update", "session_id": sid, "pinned": True})
    c.until("session.updated")
    before = time.time()
    c.send({"type": "session.update", "session_id": sid, "archived": True, "pinned": False, "snoozed_until": None})
    assert c.until("session.updated")[0]["archived"] is True
    c.send({"type": "session.list"})
    item = c.until("sessions")[0]["items"][0]
    assert item["archived"] and not item["pinned"] and item["snoozed_until"] is None
    assert item["archived_at"] >= before - 1

    # Un-settle clears archived_at. null clears the position.
    c.send({"type": "session.update", "session_id": sid, "archived": False, "position": None, "auto_archive": True})
    c.until("session.updated")
    c.send({"type": "session.list"})
    item = c.until("sessions")[0]["items"][0]
    assert not item["archived"] and item["archived_at"] is None and item["position"] is None and item["auto_archive"]

    for bad in ({"position": "top"}, {"position": True}, {"snoozed_until": "soon"}, {"auto_archive": 0}):
        c.send({"type": "session.update", "session_id": sid, **bad})
        error = c.until("error")[0]
        assert error["ref"] == "session.update"
    c.close()


def test_retitle_errors(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    sid = c.new_session(project)["session_id"]
    c.send({"type": "session.retitle", "session_id": "nope"})
    error = c.until("error")[0]
    assert error["ref"] == "session.retitle" and "Unknown session" in error["message"]
    c.send({"type": "session.retitle", "session_id": sid})
    error = c.until("error")[0]
    assert error["ref"] == "session.retitle" and "no messages" in error["message"]
    c.close()


def test_retitle_makes_a_title_from_the_conversation(daemon, project, fake_model):  # noqa: F811
    fake_model.script({"text": "Hello there."}, {"text": "Done."})
    c = Client(daemon)
    sid = c.new_session(project)["session_id"]
    c.send({"type": "prompt", "text": "Say hello"})
    c.until("turn.end")
    c.send({"type": "prompt", "text": "Now fix the parser bug"})
    c.until("turn.end")
    fake_model.title = "Parser bug fix"
    asked = len(fake_model.title_requests)
    c.send({"type": "session.retitle", "session_id": sid})
    title, seen = c.until("session.title")
    while title["title"] != "Parser bug fix":  # The first title can come late.
        title, more = c.until("session.title")
        seen += more
    assert title == {"type": "session.title", "id": sid, "title": "Parser bug fix"}
    text = fake_model.title_requests[asked]["messages"][-1]["content"]
    assert "Say hello" in text and "Now fix the parser bug" in text
    assert c.until("session.updated")[0]["title"] == "Parser bug fix"
    c.close()

    # The model gives no title: an error with the ref.
    fake_model.title_fail = 10
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "session.retitle", "session_id": sid})
    error = c.until("error", timeout=20)[0]
    assert error["ref"] == "session.retitle" and "did not make a title" in error["message"]
    c.close()


def test_archive_inactive_skips_never_and_snoozed_sessions(harness_home, tmp_path, project):
    storage = Storage(tmp_path / "harness.db")
    old = storage.create_session(str(project), "fake", "m")
    never = storage.create_session(str(project), "fake", "m")
    storage.update_session(never, touch=False, auto_archive=0)
    snoozed = storage.create_session(str(project), "fake", "m")
    woke = storage.create_session(str(project), "fake", "m")
    later = time.time() + 3 * DAY
    storage.update_session(snoozed, touch=False, snoozed_until=later + 3600)
    storage.update_session(woke, touch=False, snoozed_until=later - 3600)  # The wake time is past.
    (harness_home / "settings.json").write_text(json.dumps({"auto_archive_days": 2}))
    assert sorted(asyncio.run(server.archive_inactive(storage, now=later))) == sorted([old, woke])
    rows = {r["id"]: r for r in storage.list_sessions()}
    assert rows[old]["archived"] and rows[old]["archived_at"] == later
    assert not rows[never]["archived"] and not rows[snoozed]["archived"]
    storage.close()
