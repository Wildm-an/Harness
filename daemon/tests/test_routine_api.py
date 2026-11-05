"""The API trigger of a routine: POST /routines/{id}/fire with a Bearer token (server.py)."""

from __future__ import annotations

import httpx

from tests.test_routines import _save, _until_run
from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.


def test_an_api_call_runs_the_routine_with_its_text(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    item = _save(c, project)
    assert item["api"] == {"active": False, "hint": None}
    url = daemon.replace("ws://", "http://").replace("/ws", f"/routines/{item['id']}/fire")

    # No token yet: the call is refused.
    assert httpx.post(url, headers={"Authorization": "Bearer x"}).status_code == 401

    c.send({"type": "routines.token", "id": item["id"], "action": "generate"})
    token = c.until("routine.token")[0]["token"]
    listing = c.until("routines")[0]
    assert next(i for i in listing["items"] if i["id"] == item["id"])["api"] == {"active": True, "hint": token[-4:]}

    assert httpx.post(url, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert httpx.post(url, headers={"Authorization": f"Bearer {token}"}, content=b"not json").status_code == 400

    fake_model.script({"when": "Say hello", "text": "Hello from the API."})
    reply = httpx.post(url, headers={"Authorization": f"Bearer {token}"}, json={"text": "The build 42 failed."})
    assert reply.status_code == 200 and reply.json()["ok"] is True
    done = _until_run(c, "done")
    c.send({"type": "session.resume", "session_id": done["session_id"]})
    ready = c.until("session.ready")[0]
    first = next(m for m in ready["history"] if m["role"] == "user")
    assert first["content"] == "Say hello\n\nThe build 42 failed."

    # A deleted token stops the API trigger.
    c.send({"type": "routines.token", "id": item["id"], "action": "delete"})
    assert c.until("routine.token")[0]["token"] is None
    assert httpx.post(url, headers={"Authorization": f"Bearer {token}"}).status_code == 401
    c.close()
