"""Routines (routines.py): the storage, the scheduler, and runs with no window."""

from __future__ import annotations

import asyncio
import datetime as dt
import sqlite3
import time

from harness_daemon.routines import RoutineScheduler, next_fire
from harness_daemon.storage import Storage

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.


def _routine(storage: Storage, project, schedule: str = "*/5 * * * *", **extra) -> str:
    fields = {"name": "Daily check", "prompt": "Check the project", "cwd": str(project),
              "permission_mode": "default", "schedule": schedule, "enabled": True, **extra}
    return storage.save_routine(fields)


# -- storage ------------------------------------------------------------------------------------


def test_routine_storage(tmp_path, project):
    storage = Storage(tmp_path / "h.db")
    rid = _routine(storage, project)
    routine = storage.get_routine(rid)
    assert routine["name"] == "Daily check" and routine["enabled"] is True and routine["last_fire_at"]

    storage.save_routine({"name": "New name", "enabled": False}, rid)
    assert storage.get_routine(rid)["name"] == "New name" and storage.get_routine(rid)["enabled"] is False

    session_id = storage.create_session(str(project), "fake", "test-model")
    run_id = storage.add_run(rid, 100.0, "running", session_id=session_id)
    storage.update_run(run_id, status="done")
    run = storage.list_runs(rid)[0]
    assert run["status"] == "done" and run["ended_at"] and run["session_id"] == session_id

    storage.update_session(session_id, routine_id=rid)
    assert storage.list_sessions()[0]["routine_id"] == rid

    open_run = storage.add_run(rid, 200.0, "waiting")
    storage.end_open_runs()  # A new daemon starts.
    assert storage.get_run(open_run)["status"] == "failed"

    storage.delete_routine(rid)
    assert storage.get_routine(rid) is None and storage.list_runs(rid) == []
    assert storage.get_session(session_id) is not None  # The session of the run stays.
    storage.close()


def test_an_old_database_gets_the_routine_column(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, provider TEXT NOT NULL, "
               "model TEXT NOT NULL, title TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL, "
               "context_start INTEGER NOT NULL DEFAULT 0)")
    db.execute("INSERT INTO sessions VALUES ('s1', 'C:/p', 'fake', 'm', NULL, 1, 1, 0)")
    db.commit()
    db.close()
    storage = Storage(path)
    assert storage.list_sessions()[0]["routine_id"] is None
    storage.close()


# -- the scheduler ------------------------------------------------------------------------------


class Clock:
    def __init__(self, start: float):
        self.now = start

    def __call__(self) -> float:
        return self.now


def _at(hour: int, minute: int) -> float:
    return dt.datetime(2026, 11, 4, hour, minute).timestamp()


def test_next_fire():
    assert next_fire("30 9 * * *", _at(9, 0)) == _at(9, 30)
    assert next_fire("30 9 * * *", _at(9, 30)) == dt.datetime(2026, 11, 5, 9, 30).timestamp()
    assert next_fire("not cron", _at(9, 0)) is None


def test_scheduler_fires_due_routines_once(tmp_path, project):
    async def main() -> None:
        storage = Storage(tmp_path / "h.db")
        clock = Clock(_at(9, 0))
        rid = _routine(storage, project, schedule="0 * * * *")
        storage.set_routine_fired(rid, _at(9, 0))
        runs: list[str] = []
        events: list[dict] = []

        async def run_fn(routine, report):
            runs.append(routine["id"])
            report("running", session_id="s-" + str(len(runs)))

        async def broadcast(message):
            events.append(message)

        scheduler = RoutineScheduler(storage, run_fn, broadcast, clock=clock)
        assert scheduler.tick() == []  # 10:00 is not due yet.
        clock.now = _at(10, 0) + 5
        assert scheduler.tick() == [rid]
        await asyncio.sleep(0.05)
        assert runs == [rid]
        assert storage.list_runs(rid)[0]["status"] == "done"
        assert [e["status"] for e in events if e["type"] == "routine.run"] == ["running", "running", "done"]
        assert scheduler.tick() == []  # The same due time does not fire again.

        # The computer was off from 10:00 to 15:30: one run, not five.
        clock.now = _at(15, 30)
        assert scheduler.tick() == [rid]
        await asyncio.sleep(0.05)
        assert len(runs) == 2
        assert scheduler.item(storage.get_routine(rid))["next_fire_at"] == _at(16, 0)

        storage.save_routine({"enabled": False}, rid)
        clock.now = _at(17, 0)
        assert scheduler.tick() == []  # A routine that is off does not run.
        storage.close()

    asyncio.run(main())


def test_scheduler_skips_and_limits(tmp_path, project):
    async def main() -> None:
        storage = Storage(tmp_path / "h.db")
        release = asyncio.Event()
        started: list[str] = []

        async def run_fn(routine, report):
            started.append(routine["id"])
            await release.wait()

        async def broadcast(message):
            pass

        scheduler = RoutineScheduler(storage, run_fn, broadcast, max_parallel=2)
        ids = [_routine(storage, project, name=f"R{i}") for i in range(3)]
        for rid in ids:
            assert scheduler.fire(rid) is None
        await asyncio.sleep(0.05)
        assert started == ids[:2]  # The third waits in the queue.
        assert scheduler.item(storage.get_routine(ids[2]))["queued"] is True

        skipped = scheduler.fire(ids[0])  # It runs now.
        assert skipped is not None and storage.get_run(skipped)["status"] == "skipped"

        release.set()
        await asyncio.sleep(0.1)
        assert started == ids
        assert all(storage.list_runs(rid)[0]["status"] == "done" for rid in ids[1:])
        await scheduler.stop()
        storage.close()

    asyncio.run(main())


def test_a_run_that_raises_fails(tmp_path, project):
    async def main() -> None:
        storage = Storage(tmp_path / "h.db")

        async def run_fn(routine, report):
            raise RuntimeError("The folder is gone.")

        async def broadcast(message):
            pass

        scheduler = RoutineScheduler(storage, run_fn, broadcast)
        rid = _routine(storage, project)
        scheduler.fire(rid)
        await asyncio.sleep(0.05)
        run = storage.list_runs(rid)[0]
        assert run["status"] == "failed" and run["error"] == "The folder is gone."
        storage.close()

    asyncio.run(main())


# -- runs in the daemon, with no window ---------------------------------------------------------


def _save(c: Client, project, **extra) -> dict:
    c.send({"type": "routines.save", "name": "Daily check", "prompt": "Say hello", "cwd": str(project),
            "model": "fake/test-model", "schedule": "0 9 * * *", "permission_mode": "default", **extra})
    msg = c.until("routines")[0]
    while "saved" not in msg:
        msg = c.until("routines")[0]
    return next(i for i in msg["items"] if i["id"] == msg["saved"])


def _until_run(c: Client, status: str, timeout: float = 20) -> dict:
    while True:
        msg = c.until("routine.run", timeout)[0]
        if msg["status"] == status:
            return msg


def test_run_now_starts_a_session_and_all_clients_see_it(daemon, project, fake_model):  # noqa: F811
    a, b = Client(daemon), Client(daemon)
    a.until("auth.ok")
    b.until("auth.ok")
    fake_model.script({"text": "Hello from the routine."})
    item = _save(a, project)
    assert item["next_fire_at"] and item["last_run"] is None

    a.send({"type": "routines.run", "id": item["id"]})
    done = _until_run(b, "done")  # The other client sees the run too.
    assert done["name"] == "Daily check" and done["session_id"]

    b.send({"type": "session.list"})
    sessions = b.until("sessions")[0]["items"]
    row = next(s for s in sessions if s["id"] == done["session_id"])
    assert row["routine_id"] == item["id"] and row["title"] == "Daily check"

    b.send({"type": "session.resume", "session_id": done["session_id"]})
    ready = b.until("session.ready")[0]
    texts = [m.get("content") for m in ready["history"] if m["role"] == "assistant"]
    assert "Hello from the routine." in texts

    b.send({"type": "routines.runs", "id": item["id"]})
    runs = b.until("routine.runs")[0]["items"]
    assert [r["status"] for r in runs] == ["done"]
    a.close()
    b.close()


def test_a_window_answers_a_permission_request_of_a_run(daemon, project, fake_model):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    fake_model.script(
        {"tool_calls": [{"name": "bash", "arguments": {"command": "echo routine-ok"}}]},
        {"text": "The command ran."},
    )
    item = _save(c, project)
    c.send({"type": "routines.run", "id": item["id"]})
    waiting = _until_run(c, "waiting")

    # No window showed the session: the request waits. The window opens the session and answers.
    c.send({"type": "session.resume", "session_id": waiting["session_id"]})
    ready = c.until("session.ready")[0]
    assert ready["running"] is True and len(ready["requests"]) == 1
    c.send({"type": "permission.reply", "request_id": ready["requests"][0]["request_id"], "decision": "allow_once"})
    _until_run(c, "running")
    _until_run(c, "done")
    c.close()


def test_a_run_continues_when_the_window_closes(daemon, project, fake_model):  # noqa: F811
    a = Client(daemon)
    a.until("auth.ok")
    fake_model.script(
        {"tool_calls": [{"name": "bash", "arguments": {"command": "echo late"}}]},
        {"text": "Done late."},
    )
    item = _save(a, project, permission_mode="bypassPermissions")
    a.send({"type": "routines.run", "id": item["id"]})
    a.until("routine.run")
    a.close()  # The window goes away during the run.

    b = Client(daemon)
    b.until("auth.ok")
    for _ in range(80):
        b.send({"type": "routines.runs", "id": item["id"]})
        runs = b.until("routine.runs")[0]["items"]
        if runs and runs[0]["status"] == "done":
            break
        time.sleep(0.25)
    assert runs[0]["status"] == "done"
    b.close()


def test_routine_save_checks_the_fields(daemon, project):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "routines.save", "name": "Bad", "prompt": "x", "cwd": str(project), "schedule": "every day"})
    error = c.until("error")[0]
    assert error["ref"] == "routines.save" and "5 fields" in error["message"]
    c.send({"type": "routines.save", "name": "", "prompt": "x", "cwd": str(project), "schedule": "0 9 * * *"})
    assert "name" in c.until("error")[0]["message"]
    c.close()
