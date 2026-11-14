"""Run records (records.py): one row for each model request and each turn, with no prompt text."""

from __future__ import annotations

import asyncio
import sqlite3

from harness_daemon.records import cached_tokens, text_hash, tools_hash, usage_counts
from harness_daemon.storage import Storage

from test_agent import make_agent
from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_hashes():
    assert text_hash("a") == text_hash("a") != text_hash("b") and len(text_hash("a")) == 16
    one = [{"type": "function", "function": {"name": "a", "description": "x"}}]
    two = [{"function": {"description": "x", "name": "a"}, "type": "function"}]
    assert tools_hash(one) == tools_hash(two)  # The key order does not count.
    a, b = {"function": {"name": "a"}}, {"function": {"name": "b"}}
    assert tools_hash([a, b]) != tools_hash([b, a])  # The tool order counts: the cache prefix changes.
    assert tools_hash([]) is None


def test_usage_counts_read_the_cached_tokens_of_each_provider_form():
    assert cached_tokens({"prompt_tokens_details": {"cached_tokens": 64}}) == 64
    assert cached_tokens({"prompt_cache_hit_tokens": 32}) == 32
    assert cached_tokens({"cache_read_input_tokens": 16}) == 16
    assert cached_tokens({"prompt_tokens": 100}) is None and cached_tokens(None) is None
    counts = usage_counts({"prompt_tokens": 100, "completion_tokens": 10,
                           "completion_tokens_details": {"reasoning_tokens": 4}})
    assert counts == {"prompt_tokens": 100, "completion_tokens": 10, "cached_tokens": None, "reasoning_tokens": 4}
    assert usage_counts(None)["prompt_tokens"] is None  # Not reported: never an estimate.


def test_an_old_database_gets_the_tables(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, provider TEXT NOT NULL, "
               "model TEXT NOT NULL, title TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL)")
    db.commit()
    db.close()
    storage = Storage(path)
    tables = {r[0] for r in storage.db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"turns", "model_requests", "tool_calls"} <= tables
    storage.close()


def recording_agent(project):
    agent, events, requests = make_agent(project)
    rows: list[tuple[str, dict]] = []
    agent.on_record = lambda kind, row: rows.append((kind, row))
    return agent, rows


def test_a_turn_gives_a_turn_record_and_a_request_record_for_each_model_call(harness_home, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "read", "arguments": {"path": "hello.py"}}], "cached_tokens": 64},
        {"text": "It greets.", "prompt_tokens": 150},
    )
    agent, rows = recording_agent(project)
    asyncio.run(agent.run_turn("what does hello.py do?"))
    kinds = [k for k, _ in rows]
    assert kinds == ["turn_start", "request", "request", "turn_end"]
    start, first, second, end = (r for _, r in rows)
    assert start["id"] == end["id"] == first["turn_id"] == second["turn_id"]
    assert end["stop_reason"] == "end" and end["steps"] == 2 and end["tool_calls"] == 1
    assert (first["step"], second["step"]) == (1, 2)
    assert first["purpose"] == "turn" and first["provider"] == "fake" and first["model"] == "test-model"
    assert first["finish_reason"] == "tool_calls" and second["finish_reason"] == "stop"
    assert first["cached_tokens"] == 64 and second["cached_tokens"] is None
    assert second["prompt_tokens"] == 150 and second["completion_tokens"] == 10
    # The same session prefix: the same hashes. A change here breaks the prompt cache.
    assert first["system_hash"] == second["system_hash"] and first["tools_hash"] == second["tools_hash"]
    assert first["duration_ms"] >= 0 and first["error"] is None
    assert "hello" not in str(rows)  # No prompt text, arguments, or output in the records.


def test_a_failed_request_and_a_reply_with_no_usage(harness_home, project, fake_model):
    fake_model.script({"error": "bad request", "status": 400})
    agent, rows = recording_agent(project)
    assert asyncio.run(agent.run_turn("go")) == "error"
    request = next(r for k, r in rows if k == "request")
    assert request["error"] and "prompt_tokens" not in request  # The request gave no reply: no counts.
    fake_model.script({"text": "ok", "no_usage": True})
    asyncio.run(agent.run_turn("again"))
    last = [r for k, r in rows if k == "request"][-1]
    assert last["error"] is None and last["prompt_tokens"] is None and last["usage"] is None


def test_a_record_error_does_not_stop_the_turn(harness_home, project, fake_model):
    fake_model.script({"text": "Hi."})
    agent, _, _ = make_agent(project)

    def broken(kind, row):
        raise RuntimeError("disk full")

    agent.on_record = broken
    assert asyncio.run(agent.run_turn("hi")) == "end"


def test_the_session_stores_the_records_and_a_delete_removes_them(daemon, harness_home, project, fake_model, tmp_path):  # noqa: F811
    fake_model.script({"text": "Hi."})
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "prompt", "text": "hi"})
    c.until("turn.end")
    db = sqlite3.connect(tmp_path / "daemon.db")
    sid = ready["session_id"]
    turns = db.execute("SELECT stop_reason, steps FROM turns WHERE session_id = ?", (sid,)).fetchall()
    requests = db.execute("SELECT purpose, provider, prompt_tokens FROM model_requests WHERE session_id = ?",
                          (sid,)).fetchall()
    assert turns == [("end", 1)] and requests == [("turn", "fake", 100)]
    db.close()


def test_storage_ends_open_turns_and_deletes_records(tmp_path):
    storage = Storage(tmp_path / "s.db")
    sid = storage.create_session(str(tmp_path), "fake", "m")
    storage.start_turn(sid, {"id": "t1", "started_at": 1.0})
    storage.add_model_request(sid, {"purpose": "turn", "provider": "fake", "model": "m", "started_at": 1.0})
    storage.end_open_turns()
    records = storage.session_records(sid)
    assert records["turns"][0]["stop_reason"] == "daemon_stopped" and len(records["model_requests"]) == 1
    storage.delete_session(sid)
    assert storage.session_records(sid) == {"turns": [], "model_requests": [], "tool_calls": []}
    storage.close()
