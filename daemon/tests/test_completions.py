from __future__ import annotations

from harness_daemon.completions import CURSOR, clean_completion, completion_request

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_clean_completion_keeps_only_the_new_text():
    prefix = "def add(a, b):\n    return a"
    assert clean_completion(" + b", prefix, "\n") == " + b"
    # A model can repeat the start of the line, or wrap the code in a fence.
    assert clean_completion("    return a + b", prefix, "") == " + b"
    assert clean_completion("```python\n + b\n```", prefix, "") == " + b"
    assert clean_completion("<think>easy</think> + b", prefix, "") == " + b"


def test_clean_completion_stops_at_the_text_after_the_cursor():
    prefix = "items = [\n    1,\n"
    suffix = "]\nprint(items)\n"
    assert clean_completion("    2,\n    3,\n]\nprint(items)", prefix, suffix) == "    2,\n    3,"


def test_clean_completion_gives_none_for_nothing_useful():
    assert clean_completion("NONE", "x = ", "") is None
    assert clean_completion("   \n", "x = ", "") is None


def test_clean_completion_limits_the_length():
    text = "\n".join(f"line{i}" for i in range(40))
    assert len(clean_completion(text, "", "").split("\n")) == 12


def test_the_request_marks_the_cursor_and_cuts_long_text():
    request = completion_request("src/app.py", "a" * 9000 + "BEFORE", "AFTER" + "b" * 9000)
    content = request[0]["content"]
    assert f"BEFORE{CURSOR}AFTER" in content and "src/app.py" in content
    assert len(content) < 7000


def test_the_daemon_completes_code_at_the_cursor(daemon, project, fake_model):  # noqa: F811
    fake_model.script({"text": "    return a + b"})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "editor.complete", "id": "c1", "path": "app.py", "prefix": "def add(a, b):\n", "suffix": ""})
    got = c.until("editor.completion")[0]
    assert (got["id"], got["text"]) == ("c1", "    return a + b")
    c.send({"type": "editor.complete", "id": 5, "path": "app.py", "prefix": "x", "suffix": ""})
    assert "'id' must be a string" in c.until("error")[0]["message"]
    c.close()


def test_editor_complete_needs_a_session(daemon):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "editor.complete", "id": "c1", "path": "app.py", "prefix": "x", "suffix": ""})
    assert "No session" in c.until("error")[0]["message"]
    c.close()
