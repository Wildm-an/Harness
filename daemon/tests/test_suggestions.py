import json

from harness_daemon.suggestions import clean_suggestion, conversation_text

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_clean_suggestion_keeps_one_plain_line():
    assert clean_suggestion('"Run the tests"') == "Run the tests"
    assert clean_suggestion("<think>The user wants tests.</think>\nUser: **Add a test**") == "Add a test"
    assert clean_suggestion("Next message: fix the bug\nmore text") == "fix the bug"


def test_clean_suggestion_gives_none_for_no_step():
    assert clean_suggestion("NONE") is None
    assert clean_suggestion("none.") is None
    assert clean_suggestion("  ") is None


def test_clean_suggestion_cuts_a_long_line_at_a_word():
    text = clean_suggestion("word " * 60)
    assert text is not None and len(text) <= 160 and text.endswith("word")


def test_conversation_text_uses_the_last_text_messages():
    history = [
        {"role": "system", "content": "The system prompt."},
        {"role": "user", "content": "expanded text", "display": "Fix @app.py"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "1"}]},
        {"role": "tool", "content": "file text"},
        {"role": "assistant", "content": "I fixed it."},
    ]
    assert conversation_text(history) == "User: Fix @app.py\n\nAgent: I fixed it."


def test_a_turn_sends_a_prompt_suggestion(daemon, project, fake_model):
    fake_model.script({"text": "I added the function."})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Add a function"})
    c.until("turn.end")
    suggestion = c.until("prompt.suggestion")[0]
    assert suggestion["text"] == "Run the tests"
    conversation = fake_model.suggestion_requests[0]["messages"][0]["content"]
    assert "User: Add a function" in conversation and "Agent: I added the function." in conversation
    c.close()


def test_the_setting_switches_the_suggestions_off(daemon, project, fake_model):
    (project / ".harness").mkdir(exist_ok=True)
    (project / ".harness" / "settings.json").write_text(json.dumps({"prompt_suggestions": False}))
    fake_model.script({"text": "Done."}, {"text": "Done again."})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Do a thing"})
    c.until("turn.end")
    # A second turn: a suggestion of the first turn would come before its turn.end.
    c.send({"type": "prompt", "text": "Do one more thing"})
    _, seen = c.until("turn.end")
    assert all(m["type"] != "prompt.suggestion" for m in seen)
    assert fake_model.suggestion_requests == []
    c.close()
