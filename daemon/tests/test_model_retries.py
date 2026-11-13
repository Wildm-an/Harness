"""The retries of a model call when the endpoint does not answer (agent.CONNECT_RETRY_DELAYS)."""

from __future__ import annotations

import asyncio

from test_context import make_agent


def test_the_agent_tries_again_when_the_endpoint_does_not_answer(harness_home, project, fake_model, monkeypatch):
    from harness_daemon import agent as agent_mod
    from harness_daemon.providers import ModelError
    monkeypatch.setattr(agent_mod, "CONNECT_RETRY_DELAYS", (0, 0, 0, 0, 0))
    agent, events, _ = make_agent(project, [])
    real = agent.client.stream
    calls = []

    async def flaky(*args, **kwargs):
        calls.append(1)
        if len(calls) <= 2:
            raise ModelError("Cannot connect to the model endpoint at http://box/v1.", reconnect=True)
        return await real(*args, **kwargs)
    monkeypatch.setattr(agent.client, "stream", flaky)
    fake_model.script({"text": "Hi."})
    assert asyncio.run(agent.run_turn("hi")) == "end"
    retries = [e for e in events if e["type"] == "turn.retry"]
    assert [(e["attempt"], e["max"]) for e in retries] == [(1, 5), (2, 5)] and len(calls) == 3


def test_the_agent_stops_after_the_last_retry(harness_home, project, fake_model, monkeypatch):
    from harness_daemon import agent as agent_mod
    from harness_daemon.providers import ModelError
    monkeypatch.setattr(agent_mod, "CONNECT_RETRY_DELAYS", (0, 0, 0, 0, 0))
    agent, events, _ = make_agent(project, [])
    calls = []

    async def down(*args, **kwargs):
        calls.append(1)
        raise ModelError("Cannot connect to the model endpoint at http://box/v1.", reconnect=True)
    monkeypatch.setattr(agent.client, "stream", down)
    failed = None
    try:
        asyncio.run(agent.run_turn("hi"))
    except ModelError as e:
        failed = str(e)
    text = failed or next(e["message"] for e in events if e["type"] == "error")
    assert "tried 6 times" in text and len(calls) == 6
    assert len([e for e in events if e["type"] == "turn.retry"]) == 5


def test_an_error_that_is_not_a_connection_error_has_no_retry(harness_home, project, fake_model, monkeypatch):
    from harness_daemon.providers import ModelError
    agent, events, _ = make_agent(project, [])
    calls = []

    async def bad(*args, **kwargs):
        calls.append(1)
        raise ModelError("The model endpoint returned HTTP 401: bad key")
    monkeypatch.setattr(agent.client, "stream", bad)
    try:
        asyncio.run(agent.run_turn("hi"))
    except ModelError:
        pass
    assert len(calls) == 1 and not any(e["type"] == "turn.retry" for e in events)
