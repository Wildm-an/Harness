"""The "@" references of a prompt: files, folders, sessions, and the file name search of the "@" menu."""

from __future__ import annotations

from harness_daemon.references import MAX_SESSION_CHARS, Reference, expand_references, parse_reference, session_ids
from harness_daemon.tools.search import find_paths

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

SID = "0123456789abcdef0123456789abcdef"


def test_parse_reference():
    assert parse_reference("src/app.py:10-25") == Reference("lines", "src/app.py", 10, 25)
    assert parse_reference("src/app.py:25-10") == Reference("lines", "src/app.py", 10, 25)
    assert parse_reference("src/app.py.") == Reference("path", "src/app.py")  # The period ends the sentence.
    assert parse_reference("src/") == Reference("path", "src/")
    assert parse_reference("src/app.py:10.") == Reference("lines", "src/app.py", 10, 10)
    assert parse_reference(f"session:{SID}?") == Reference("session", SID)
    assert parse_reference(f"session:{SID}") == Reference("session", SID)
    assert parse_reference("file:0") is None
    assert session_ids(f"Compare @session:{SID} with @src/app.py") == {SID}


def test_a_file_and_a_folder(project):
    (project / "src").mkdir()
    (project / "src" / "app.py").write_text("def add(a, b):\n    return a + b\n")
    (project / "src" / "util").mkdir()
    out = expand_references("Explain @src/app.py, then list @src/.", project)
    assert "src/app.py:\n```\n     1\tdef add(a, b):\n     2\t    return a + b\n```" in out
    assert "The folder src/ has these entries:\n```\napp.py\nutil/\n```" in out


def test_a_session(project):
    messages = [
        {"role": "user", "content": "Add a login page.", "display": "Add a login page."},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "1"}]},
        {"role": "tool", "content": "secret tool output"},
        {"role": "assistant", "content": "I added login.html."},
    ]
    rows = {SID: ({"title": "Login page", "cwd": "/work/site"}, messages)}
    out = expand_references(f"Continue @session:{SID}", project, rows.get)
    assert f'The session "Login page" (id {SID}, folder /work/site) has these messages:' in out
    assert "User: Add a login page.\n\nAgent: I added login.html." in out
    assert "secret tool output" not in out
    # An unknown session stays as text.
    other = "f" * 32
    assert expand_references(f"See @session:{other}", project, rows.get) == f"See @session:{other}"


def test_a_long_session_keeps_its_end(project):
    messages = [{"role": "user", "content": f"message {i} " + "x" * 1000} for i in range(60)]
    out = expand_references(f"@session:{SID}", project, {SID: ({"title": None, "cwd": "/w"}, messages)}.get)
    assert "message 59" in out and "message 0 " not in out
    assert "earlier messages are not here" in out and len(out) < MAX_SESSION_CHARS + 2000


def test_find_paths_ranks_the_names(project):
    for rel in ["src/app.py", "src/apple/pie.txt", "docs/app-notes.md", "tests/test_app.py", "node_modules/app/x.js"]:
        path = project / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x")
    found = find_paths(project, "app")
    assert found[:2] == ["src/app.py", "src/apple/"]  # The name starts with "app". A short path is first.
    assert "tests/test_app.py" in found and "docs/app-notes.md" in found
    assert not any(p.startswith("node_modules") for p in found)
    assert find_paths(project, "sapp")[0] == "src/app.py"  # The letters in order.
    assert find_paths(project, "zzz") == []


def test_fs_find_and_a_session_reference_through_the_daemon(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    first = c.new_session(project)
    fake_model.script({"text": "The app greets."})
    c.send({"type": "prompt", "text": "Remember: the password is not in the code."})
    c.until("turn.end")
    c.send({"type": "fs.find", "query": "hello"})
    assert c.until("fs.found")[0]["items"][0] == "hello.py"

    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    c.until("session.ready")
    fake_model.script({"text": "OK."})
    c.send({"type": "prompt", "text": f"What did I say in @session:{first['session_id']}?"})
    c.until("turn.end")
    sent = fake_model.requests[-1]["messages"][-1]["content"]
    assert "User: Remember: the password is not in the code." in sent and "Agent: The app greets." in sent
    c.close()


def test_a_prompt_with_display_text(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    ready = c.new_session(project)
    fake_model.script({"text": "OK."})
    c.send({"type": "prompt", "text": "Read @hello.py", "display": 'Read @"Hello file"'})
    c.until("turn.end")
    assert "hello.py:\n```" in fake_model.requests[-1]["messages"][-1]["content"]
    c.send({"type": "session.resume", "session_id": ready["session_id"]})
    resumed = c.until("session.ready")[0]
    assert resumed["history"][0]["display"] == 'Read @"Hello file"' and resumed["title"] == 'Read @"Hello file"'
    c.close()
