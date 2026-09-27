"""Tests for the editor support: line references, the project search, and the file watcher."""

from __future__ import annotations

import time

from harness_daemon.references import expand_references

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_expand_references(project):
    (project / "src").mkdir()
    (project / "src" / "app.py").write_bytes(b"one\ntwo\nthree\nfour\n")
    out = expand_references("Explain @src/app.py:2-3 and @src/app.py:4 please", project)
    assert out.startswith("Explain @src/app.py:2-3 and @src/app.py:4 please\n\nThe user referenced these lines:")
    assert "src/app.py lines 2-3:\n```\n     2\ttwo\n     3\tthree\n```" in out
    assert "src/app.py lines 4-4:" in out


def test_references_that_are_not_valid_stay_as_text(project):
    text = "Mail me at a@b.com:12, see @missing.py:3 and @../outside.txt:1 and @hello.py:99"
    assert expand_references(text, project) == text


def test_prompt_with_a_reference(daemon, project, fake_model):  # noqa: F811
    fake_model.script({"text": "It greets."})
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "prompt", "text": "What does @hello.py:1-2 do?"})
    c.until("turn.end")
    sent = fake_model.requests[-1]["messages"][-1]["content"]
    assert "hello.py lines 1-2:" in sent and "return 'hello'" in sent
    c.send({"type": "session.resume", "session_id": ready["session_id"]})
    history = c.until("session.ready")[0]["history"]
    assert history[0]["display"] == "What does @hello.py:1-2 do?"
    c.close()


def test_project_search(daemon, project, fake_model):  # noqa: F811
    (project / "notes.txt").write_bytes(b"say Hello (twice)\nhello again\n")
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "fs.search", "query": "hello"})
    items = c.until("fs.results")[0]["items"]
    assert {(i["path"], i["line"]) for i in items} >= {("hello.py", 2), ("notes.txt", 1), ("notes.txt", 2)}

    c.send({"type": "fs.search", "query": "Hello (twice)", "case": True})  # Plain text: "(" is not regex.
    result = c.until("fs.results")[0]
    assert [(i["path"], i["line"], i["text"]) for i in result["items"]] == [("notes.txt", 1, "say Hello (twice)")]

    c.send({"type": "fs.search", "query": "hel+o", "regex": True, "glob": "*.txt"})
    assert {i["path"] for i in c.until("fs.results")[0]["items"]} == {"notes.txt"}
    c.close()


def test_watcher_reports_external_changes_to_open_files(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "fs.read", "path": "hello.py"})
    content = c.until("fs.content")[0]

    # The editor saves: that is not a change report.
    c.send({"type": "fs.write", "path": "hello.py", "content": "x = 1\n", "base_hash": content["hash"]})
    saved = c.until("fs.saved")[0]
    time.sleep(2)
    # Another program changes the file.
    (project / "hello.py").write_bytes(b"x = 2\n")
    changed = c.until("fs.changed", timeout=10)[0]
    assert changed["path"] == "hello.py" and changed["by"] == "external" and changed["hash"] != saved["hash"]

    c.send({"type": "fs.unwatch", "path": "hello.py"})
    time.sleep(0.2)
    (project / "hello.py").write_bytes(b"x = 3\n")
    c.send({"type": "fs.list", "path": "."})
    # The next messages are fs.tree and no fs.changed for the closed file.
    time.sleep(2)
    seen = [c.recv(timeout=2)["type"]]
    assert seen == ["fs.tree"]
    c.close()
