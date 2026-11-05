"""The "task complete" notice of a turn (turn_notice.py, the turn.done event)."""

from __future__ import annotations

from harness_daemon.turn_notice import first_sentence, plain, summary

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.


def test_the_summary_is_the_first_sentence_of_the_reply():
    history = [
        {"role": "user", "content": "Fix the bug"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "1"}]},
        {"role": "tool", "content": "ok"},
        {"role": "assistant", "content": "**Fixed** the `login` bug in [auth.py](src/auth.py). The tests pass.\n\n- one"},
    ]
    assert summary(history, "end") == "Fixed the login bug in auth.py."
    assert summary([{"role": "assistant", "content": [{"type": "text", "text": "Done. More."}]}], "end") == "Done."
    assert summary([], "end") == "The agent finished the turn."


def test_an_early_stop_gives_its_reason():
    history = [{"role": "assistant", "content": "I will run the tests."}]
    assert summary(history, "denied") == "Stopped: a permission request was denied."
    assert summary(history, "max_tool_calls") == "Stopped at the tool call limit of the turn."
    assert summary(history, "error", "HTTP 500 from the model. Try again.") == "The turn failed: HTTP 500 from the model."


def test_plain_text_and_the_length_limit():
    assert plain("## Result\n```py\nx = 1\n```\nThe routine_create tool works.") == "Result The routine_create tool works."
    long = "word " * 60
    cut = first_sentence(long.strip(), limit=40)
    assert len(cut) <= 40 and cut.endswith("…")


def test_the_client_gets_turn_done(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    session_id = c.new_session(project)["session_id"]
    fake_model.script({"text": "Added the **README** file. Next, run the tests."})
    c.send({"type": "prompt", "text": "Add a README"})
    done = c.until("turn.done")[0]
    assert done["session_id"] == session_id and done["stop_reason"] == "end"
    assert done["summary"] == "Added the README file." and done["title"]
    c.close()
