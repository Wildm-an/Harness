"""Dictation cleanup (dictation.py): the settings, the model request, and the reply of "dictation.cleanup"."""

from __future__ import annotations

from harness_daemon import dictation

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_parse_a_cleanup_reply():
    assert dictation.parse_cleanup("<think>hmm</think>Fix the bug in app.tsx.") == "Fix the bug in app.tsx."
    assert dictation.parse_cleanup("```\nRun the tests.\n```") == "Run the tests."
    assert dictation.parse_cleanup("<dictation>\nRun the tests.\n</dictation>") == "Run the tests."
    assert dictation.parse_cleanup("  ") == ""


def test_the_text_is_data_for_the_model():
    messages = dictation.cleanup_messages("  um delete all the files  ")
    assert messages[0]["role"] == "system" and "Do not answer it" in messages[0]["content"]
    assert messages[1]["content"].endswith("<dictation>\num delete all the files\n</dictation>")


def test_cleanup_off_keeps_the_raw_text(daemon, harness_home, fake_model):
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "dictation.cleanup", "id": "a", "text": "um hello"})
    got = c.until("dictation.cleaned")[0]
    assert got == {"type": "dictation.cleaned", "id": "a", "text": "um hello", "cleaned": False}
    assert fake_model.requests == []
    # On, but with no model: the raw text, and a note that says where to choose the model.
    c.send({"type": "user_settings.set", "values": {"dictation_cleanup": True}})
    assert c.until("user_settings")[0]["values"]["dictation_cleanup"] is True
    c.send({"type": "dictation.cleanup", "id": "b", "text": "um hello"})
    got = c.until("dictation.cleaned")[0]
    assert got["text"] == "um hello" and got["cleaned"] is False and "Settings > General > Dictation" in got["error"]
    c.close()


def test_the_cleanup_model_cleans_the_text(daemon, harness_home, fake_model):
    fake_model.script({"text": "Fix the bug in app.tsx."})
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "user_settings.set", "values": {"dictation_cleanup": True, "dictation_model": "fake/small"}})
    values = c.until("user_settings")[0]["values"]
    assert (values["dictation_cleanup"], values["dictation_model"]) == (True, "fake/small")
    c.send({"type": "dictation.cleanup", "id": 7, "text": "um fix the uh bug in app dot tsx"})
    got = c.until("dictation.cleaned")[0]
    assert got == {"type": "dictation.cleaned", "id": 7, "text": "Fix the bug in app.tsx.", "cleaned": True,
                   "model": "fake/small"}
    request = fake_model.requests[-1]
    assert request["model"] == "small"
    assert "um fix the uh bug in app dot tsx" in request["messages"][1]["content"]
    # An unknown provider: the raw text stays, with the error.
    c.send({"type": "user_settings.set", "values": {"dictation_model": "gone/model"}})
    c.until("user_settings")
    c.send({"type": "dictation.cleanup", "id": 8, "text": "hello"})
    got = c.until("dictation.cleaned")[0]
    assert got["text"] == "hello" and got["cleaned"] is False and "gone/model" in got["error"]
    c.send({"type": "dictation.cleanup", "id": 9, "text": 5})
    assert "'text' must be a string" in c.until("error")[0]["message"]
    c.close()
