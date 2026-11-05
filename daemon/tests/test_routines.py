"""Routines (routines.py, routine_files.py): the files, the scheduler, and runs with no window."""

from __future__ import annotations

import asyncio
import datetime as dt
import sqlite3
import time

import pytest

from harness_daemon import trash
from harness_daemon.routines import RoutineScheduler, next_fire
from harness_daemon.storage import Storage

from tests.test_server import Client, daemon  # noqa: F401 - the daemon fixture.


@pytest.fixture(autouse=True)
def no_recycle_bin(monkeypatch):
    """A test delete removes the file. It does not go to the Recycle Bin of the user."""
    monkeypatch.setattr(trash, "delete", lambda path: path.unlink() or False)


def _routine(storage: Storage, project, schedule: str = "*/5 * * * *", **extra) -> str:
    fields = {"name": "Daily check", "prompt": "Check the project", "cwd": str(project),
              "permission_mode": "default", "schedule": schedule, "enabled": True, **extra}
    return storage.save_routine(fields)


# -- the files ----------------------------------------------------------------------------------


def test_routine_storage(tmp_path, project):
    storage = Storage(tmp_path / "h.db")
    assert storage.routines_dir == tmp_path / "routines"
    rid = _routine(storage, project)
    assert rid == "daily-check"
    path = tmp_path / "routines" / "daily-check.md"
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\nname: Daily check\nschedule: '*/5 * * * *'\n")
    assert "enabled: true\n---\nCheck the project\n" in text
    routine = storage.get_routine(rid)
    assert routine["name"] == "Daily check" and routine["enabled"] is True and routine["last_fire_at"]
    assert routine["error"] is None

    assert _routine(storage, project) == "daily-check-2"  # The same name gets a new file.

    storage.save_routine({"name": "New name", "enabled": False}, rid)
    changed = storage.get_routine(rid)
    assert changed["name"] == "New name" and changed["enabled"] is False and changed["prompt"] == "Check the project"
    assert path.exists()  # The id (the file name) does not change with the name.

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
    assert not path.exists()
    assert storage.get_routine(rid) is None and storage.list_runs(rid) == []
    assert storage.get_session(session_id) is not None  # The session of the run stays.
    assert storage.get_routine("../h") is None  # An id cannot point outside the folder.
    storage.close()


def test_a_file_that_the_user_writes_is_a_routine(tmp_path, project):
    storage = Storage(tmp_path / "h.db")
    folder = tmp_path / "routines"
    folder.mkdir()
    (folder / "by-hand.md").write_text(
        f"---\nname: By hand\nschedule: 0 8 * * 1-5\ncwd: {project}\nmodel: fake/test-model\n---\nSay hi\n",
        encoding="utf-8")
    (folder / "broken.md").write_text("---\nname: Broken\nschedule: every day\ncwd: C:/x\n---\nHi\n", encoding="utf-8")
    (folder / "notes.txt").write_text("not a routine", encoding="utf-8")
    items = {r["id"]: r for r in storage.list_routines()}
    assert set(items) == {"by-hand", "broken"}
    hand = items["by-hand"]
    assert hand["enabled"] is True and hand["permission_mode"] == "default" and hand["model"] == "fake/test-model"
    assert hand["prompt"] == "Say hi" and hand["error"] is None
    broken = items["broken"]
    assert broken["enabled"] is False and broken["error"].startswith("schedule: A cron expression has 5 fields")

    async def main() -> None:
        async def run_fn(routine, report):
            pass

        async def broadcast(message):
            pass

        scheduler = RoutineScheduler(storage, run_fn, broadcast, clock=lambda: time.time() + 10 * 86400)
        assert scheduler.tick() == ["by-hand"]  # A file with a problem does not run.

    asyncio.run(main())
    storage.close()


def test_save_refuses_a_routine_with_a_problem(tmp_path, project):
    storage = Storage(tmp_path / "h.db")
    with pytest.raises(ValueError, match="no prompt"):
        _routine(storage, project, prompt="")
    with pytest.raises(ValueError, match="Unknown routine"):
        storage.save_routine({"enabled": False}, "missing")
    assert storage.list_routines() == []
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


def test_the_routines_of_version_0_1_45_move_to_files(tmp_path, project):
    """Version 0.1.45 kept the routines in a table. The runs and the sessions keep their routine."""
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.executescript(f"""
        CREATE TABLE routines (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, cwd TEXT NOT NULL,
            provider TEXT, model TEXT, permission_mode TEXT NOT NULL DEFAULT 'default', schedule TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL, updated_at REAL NOT NULL, last_fire_at REAL);
        CREATE TABLE routine_runs (id TEXT PRIMARY KEY,
            routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE, session_id TEXT,
            fire_at REAL NOT NULL, started_at REAL NOT NULL, ended_at REAL, status TEXT NOT NULL, error TEXT);
        INSERT INTO routines VALUES ('abc123', 'Morning summary', 'Sum it up', '{project}', NULL, 'fake/m',
            'auto', '0 9 * * 1-5', 0, 5, 6, 7);
        INSERT INTO routine_runs VALUES ('r1', 'abc123', 's1', 1, 2, 3, 'done', NULL);
    """)
    db.commit()
    db.close()
    storage = Storage(path)
    routine = storage.get_routine("morning-summary")
    assert routine["prompt"] == "Sum it up" and routine["permission_mode"] == "auto" and routine["enabled"] is False
    assert routine["created_at"] == 5 and routine["last_fire_at"] == 7 and routine["model"] == "fake/m"
    assert [r["id"] for r in storage.list_runs("morning-summary")] == ["r1"]
    tables = {r[0] for r in storage.db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "routines" not in tables and "routine_runs_old" not in tables
    storage.add_run("morning-summary", 10.0, "running")  # No foreign key to the old table.
    storage.close()
    Storage(path).close()  # A second start does not move anything again.


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


# -- the routine tools (tools/routines.py) -----------------------------------------------------


def test_the_mode_of_a_routine_from_a_session():
    from harness_daemon.tools.base import ToolError
    from harness_daemon.tools.routines import routine_mode

    assert routine_mode(None, "auto") == "auto"
    assert routine_mode(None, "plan") == "default"  # A routine in Plan mode cannot change anything.
    assert routine_mode("plan", "default") == "plan"
    assert routine_mode("acceptEdits", "auto") == "acceptEdits"
    with pytest.raises(ToolError, match="less limited"):
        routine_mode("bypassPermissions", "default")
    with pytest.raises(ToolError, match="less limited"):
        routine_mode("auto", "plan")
    with pytest.raises(ToolError, match="must be one of"):
        routine_mode("yolo", "auto")


def test_the_agent_saves_a_routine(daemon, project, fake_model, tmp_path):  # noqa: F811
    a, b = Client(daemon), Client(daemon)
    a.new_session(project)
    b.until("auth.ok")
    fake_model.script(
        # A mode above the session mode is refused before the user sees a request.
        {"tool_calls": [{"name": "routine_create", "arguments": {
            "name": "Morning summary", "prompt": "Summarize the new commits.", "schedule": "0 9 * * 1-5",
            "permission_mode": "bypassPermissions"}}]},
        {"tool_calls": [{"name": "routine_create", "arguments": {
            "name": "Morning summary", "prompt": "Summarize the new commits.", "schedule": "0 9 * * 1-5"}}]},
        {"tool_calls": [{"name": "routine_list", "arguments": {}}]},
        {"text": "The routine runs at 09:00 on weekdays."},
    )
    a.send({"type": "prompt", "text": "Summarize the new commits each weekday morning"})
    request = a.until("permission.request")[0]
    assert request["tool"] == "routine_create"
    assert request["input"]["permission_mode"] == "Manual" and request["input"]["model"] == "fake/test-model"
    assert request["input"]["folder"] == str(project)
    a.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    a.until("turn.end")

    refused = next(m for m in fake_model.requests[1]["messages"] if m["role"] == "tool")["content"]
    assert "less limited permission mode" in refused
    tool_results = [m["content"] for m in fake_model.requests[-1]["messages"] if m["role"] == "tool"]
    assert "Saved the routine 'Morning summary' (Active)" in tool_results[-2]
    assert "morning-summary: Morning summary (Active), schedule '0 9 * * 1-5'" in tool_results[-1]

    text = (tmp_path / "routines" / "morning-summary.md").read_text(encoding="utf-8")
    assert "model: fake/test-model\npermission_mode: default\n" in text and "Summarize the new commits." in text
    listing = b.until("routines")[0]  # The other window gets the new list.
    assert [r["id"] for r in listing["items"]] == ["morning-summary"]
    a.close()
    b.close()

