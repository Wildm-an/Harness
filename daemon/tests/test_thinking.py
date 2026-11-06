"""The "thinking" event: the window shows "Thinking…" while the reasoning of the model streams."""

from __future__ import annotations

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.


def test_the_window_gets_one_thinking_event_before_the_text(daemon, project, fake_model):  # noqa: F811
    fake_model.script({"reasoning": "Let me think about the answer first.", "text": "The answer."})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Think, then answer"})
    _msg, seen = c.until("turn.end")
    kinds = [m["type"] for m in seen if m["type"] in ("thinking", "token")]
    assert kinds[0] == "thinking" and kinds.count("thinking") == 1 and "token" in kinds
    c.close()
