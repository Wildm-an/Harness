"""The side chat: quick questions that see the session, but that are not added to it."""

from __future__ import annotations

from harness_daemon.sidechat import SIDE_NOTE, clean_side_history, complete_history, side_messages

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_tool_calls_with_no_result_are_left_out():
    messages = [
        {"role": "system", "content": "The system prompt."},
        {"role": "user", "content": "Fix it"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "a"}]},
        {"role": "tool", "tool_call_id": "a", "content": "done"},
        {"role": "assistant", "content": "Now I test it.", "tool_calls": [{"id": "b"}, {"id": "c"}]},
        {"role": "tool", "tool_call_id": "b", "content": "ok"},  # "c" still runs.
    ]
    out = complete_history(messages)
    assert [m["role"] for m in out] == ["system", "user", "assistant", "tool", "assistant"]
    assert out[-1] == {"role": "assistant", "content": "Now I test it."}


def test_the_side_history_is_text_only():
    raw = [{"role": "user", "content": "Q1"}, {"role": "system", "content": "no"}, {"role": "assistant", "content": 5},
           {"role": "assistant", "content": "A1"}]
    assert clean_side_history(raw) == [{"role": "user", "content": "Q1"}, {"role": "assistant", "content": "A1"}]
    assert clean_side_history("nonsense") == []


def test_the_note_comes_before_the_first_side_question():
    base = [{"role": "system", "content": "S"}]
    first = side_messages(base, [], "Why?")
    assert first[-1] == {"role": "user", "content": f"{SIDE_NOTE}\n\nWhy?"}
    later = side_messages(base, [{"role": "user", "content": "Why?"}, {"role": "assistant", "content": "Because."}], "And?")
    assert later[1]["content"].startswith(SIDE_NOTE) and later[-1] == {"role": "user", "content": "And?"}


def test_a_side_question_sees_the_session_and_is_not_added(daemon, project, fake_model):  # noqa: F811
    fake_model.script({"text": "I added the function."})
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "prompt", "text": "Add a function"})
    c.until("turn.end")

    fake_model.script({"text": "It adds two numbers."})
    c.send({"type": "side.ask", "id": "q1", "question": "What does the function do?"})
    done = c.until("side.done")[0]
    assert done["id"] == "q1" and done["text"] == "It adds two numbers."
    sent = fake_model.requests[-1]["messages"]
    assert sent[0]["role"] == "system" and any(m.get("content") == "Add a function" for m in sent)
    assert sent[-1]["content"].endswith("What does the function do?")
    assert fake_model.requests[-1].get("tools")  # The same tools as the main thread.

    # The tools cannot run in the side chat.
    fake_model.script({"tool_calls": [{"name": "bash", "arguments": {"command": "ls"}}]})
    c.send({"type": "side.ask", "id": "q2", "question": "List the files", "history": [
        {"role": "user", "content": "What does the function do?"}, {"role": "assistant", "content": "It adds two numbers."}]})
    assert "cannot run tools" in c.until("side.done")[0]["text"]

    # Nothing of the side chat is in the session.
    c.send({"type": "session.resume", "session_id": ready["session_id"]})
    history = c.until("session.ready")[0]["history"]
    texts = [str(m.get("display") or m.get("content")) for m in history]
    assert not any("function do" in t or "two numbers" in t for t in texts)
    c.close()


def test_a_side_question_needs_text(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "side.ask", "id": "q1", "question": "  "})
    assert "must not be empty" in c.until("error")[0]["message"]
    c.close()
