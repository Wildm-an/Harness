"""The effort level of the model menu: the "effort" user setting gives reasoning_effort to the model."""

from __future__ import annotations

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.


def test_the_effort_setting_goes_to_the_model(daemon, harness_home, project, fake_model):  # noqa: F811
    fake_model.script({"text": "Default effort."}, {"text": "High effort."}, {"text": "Max effort."})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "one"})
    c.until("turn.end")
    assert fake_model.requests[-1]["reasoning_effort"] == "high"  # No setting: High, as in the Claude app.

    c.send({"type": "user_settings.set", "values": {"effort": "high"}})
    assert c.until("user_settings")[0]["values"]["effort"] == "high"
    c.send({"type": "prompt", "text": "two"})
    c.until("turn.end")
    assert fake_model.requests[-1]["reasoning_effort"] == "high"

    c.send({"type": "user_settings.set", "values": {"effort": "max"}})
    c.until("user_settings")
    c.send({"type": "prompt", "text": "three"})
    c.until("turn.end")
    assert fake_model.requests[-1]["reasoning_effort"] == "xhigh"  # The API has no level above xhigh.

    c.send({"type": "user_settings.set", "values": {"effort": "turbo"}})
    assert "must be null or one of" in c.until("error")[0]["message"]
    c.send({"type": "user_settings.set", "values": {"effort": None}})
    assert c.until("user_settings")[0]["values"]["effort"] is None
    c.close()
