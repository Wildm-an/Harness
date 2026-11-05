"""Routines: prompts that the daemon runs in a new session at the times of a cron schedule.

Each routine is a file in ~/.harness/routines (routine_files.py). The runs are in the database.
Both stay after a restart of the daemon. The scheduler runs in the daemon, not in a connection: a
routine runs also when no window is open (for example when Harness starts hidden at login).

Rules:
- A routine runs one time for each due time. If the daemon did not run at one or more due times
  (the computer was off or asleep), the routine runs one time at the start, not one time for each
  missed time.
- A routine that runs (or waits in the queue) does not start again. The scheduler records the due
  time as a "skipped" run.
- At most MAX_PARALLEL routines run at the same time. The others wait in a queue.

server.py gives the function that runs a routine in a new session (``run_fn``). The scheduler
records each run and tells the connected clients (``broadcast``).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .cron import CronError, parse_cron
from .storage import Storage

log = logging.getLogger(__name__)

MAX_PARALLEL = 3
MAX_SLEEP = 60.0  # Seconds. The loop checks at least each minute: a clock change or a sleep does not cause a miss.
RUN_STATUSES = ("running", "waiting", "done", "failed", "skipped")
HISTORY = 20  # The runs that routines.runs returns.

Report = Callable[..., None]  # report(status, session_id=None, error=None)
RunFn = Callable[[dict[str, Any], Report], Awaitable[None]]
Broadcast = Callable[[dict[str, Any]], Awaitable[None]]


def next_fire(schedule: str, after: float) -> float | None:
    """The first due time of a cron schedule after ``after`` (epoch seconds), or None."""
    try:
        cron = parse_cron(schedule)
    except CronError:
        return None
    found = cron.next_after(dt.datetime.fromtimestamp(after))
    return found.timestamp() if found is not None else None


@dataclass
class _Queued:
    routine_id: str
    fire_at: float
    text: str | None = None  # The "text" of an API call: one more paragraph after the prompt.


@dataclass
class RoutineHub:
    """The process-wide routine state: the connected clients and the scheduler."""

    listeners: set[Broadcast] = field(default_factory=set)
    scheduler: RoutineScheduler | None = None

    def listen(self, send: Broadcast) -> None:
        self.listeners.add(send)

    def unlisten(self, send: Broadcast) -> None:
        self.listeners.discard(send)

    async def broadcast(self, message: dict[str, Any]) -> None:
        for send in list(self.listeners):
            try:
                await send(message)
            except Exception:  # noqa: BLE001 - one closed client must not stop the others.
                log.exception("A routine event did not go to a client")


class RoutineScheduler:
    def __init__(self, storage: Storage, run_fn: RunFn, broadcast: Broadcast,
                 clock: Callable[[], float] = time.time, max_parallel: int = MAX_PARALLEL):
        self.storage = storage
        self.run_fn = run_fn
        self.broadcast = broadcast
        self.clock = clock
        self.max_parallel = max_parallel
        self.active: dict[str, asyncio.Task] = {}  # routine id -> the task of its run.
        self.queue: deque[_Queued] = deque()
        self._wake = asyncio.Event()
        self._loop_task: asyncio.Task | None = None

    # -- the state for the client ---------------------------------------------------------------

    def item(self, routine: dict[str, Any]) -> dict[str, Any]:
        runs = self.storage.list_runs(routine["id"], limit=1)
        item = dict(routine)
        item["next_fire_at"] = (next_fire(routine["schedule"], max(routine["last_fire_at"] or 0, self.clock()))
                                if routine["enabled"] else None)
        item["last_run"] = runs[0] if runs else None
        item["running"] = routine["id"] in self.active
        item["queued"] = any(q.routine_id == routine["id"] for q in self.queue)
        return item

    def items(self) -> list[dict[str, Any]]:
        return [self.item(r) for r in self.storage.list_routines()]

    async def send_items(self, saved: str | None = None) -> None:
        message: dict[str, Any] = {"type": "routines", "items": self.items(), "folder": str(self.storage.routines_dir)}
        if saved:
            message["saved"] = saved
        await self.broadcast(message)

    # -- the loop -------------------------------------------------------------------------------

    def start(self) -> None:
        self.storage.end_open_runs()  # Runs of an old daemon did not end.
        self._loop_task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        tasks = [t for t in (self._loop_task, *self.active.values()) if t is not None]
        self.queue.clear()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._loop_task = None

    def wake(self) -> None:
        """A routine changed: compute the next due time again."""
        self._wake.set()

    async def _loop(self) -> None:
        while True:
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - one bad row must not stop the scheduler.
                log.exception("The routine scheduler failed")
            delay = self._delay()
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), delay)
            except asyncio.TimeoutError:
                pass

    def _delay(self) -> float:
        now = self.clock()
        soonest = MAX_SLEEP
        for routine in self.storage.list_routines():
            if not routine["enabled"]:
                continue
            due = next_fire(routine["schedule"], routine["last_fire_at"] or routine["created_at"])
            if due is not None:
                soonest = min(soonest, max(due - now, 0.5))
        return soonest

    def tick(self) -> list[str]:
        """Fire the routines that are due now. Return their ids."""
        now = self.clock()
        fired = []
        for routine in self.storage.list_routines():
            if not routine["enabled"]:
                continue
            due = next_fire(routine["schedule"], routine["last_fire_at"] or routine["created_at"])
            if due is None or due > now:
                continue
            # One run for all the missed times: the next due time is after now.
            self.storage.set_routine_fired(routine["id"], now)
            self.fire(routine["id"], due)
            fired.append(routine["id"])
        return fired

    # -- runs -----------------------------------------------------------------------------------

    def fire(self, routine_id: str, fire_at: float | None = None, text: str | None = None) -> str | None:
        """Start a run of a routine, or put it in the queue. Return the id of a skipped run, else None.
        ``text``: the text of an API call. The run gets the prompt, then this text."""
        fire_at = self.clock() if fire_at is None else fire_at
        if routine_id in self.active or any(q.routine_id == routine_id for q in self.queue):
            run_id = self.storage.add_run(routine_id, fire_at, "skipped",
                                          error="The routine was still running at this time.")
            asyncio.ensure_future(self.send_items())
            return run_id
        self.queue.append(_Queued(routine_id, fire_at, text))
        self._drain()
        asyncio.ensure_future(self.send_items())
        return None

    def _drain(self) -> None:
        while self.queue and len(self.active) < self.max_parallel:
            item = self.queue.popleft()
            routine = self.storage.get_routine(item.routine_id)
            if routine is None:  # Deleted while it waited.
                continue
            if item.text:
                routine = {**routine, "prompt": f"{routine['prompt']}\n\n{item.text}"}
            self.active[routine["id"]] = asyncio.create_task(self._run(routine, item.fire_at))

    async def _run(self, routine: dict[str, Any], fire_at: float) -> None:
        run_id = self.storage.add_run(routine["id"], fire_at, "running")
        state: dict[str, Any] = {"session_id": None, "status": None}

        def report(status: str, session_id: str | None = None, error: str | None = None) -> None:
            if session_id:
                state["session_id"] = session_id
            if status == state["status"] and not session_id and not error:
                return
            state["status"] = status
            if self.storage.get_run(run_id) is None:  # The routine was deleted.
                return
            self.storage.update_run(run_id, status=status, session_id=state["session_id"], error=error)
            asyncio.ensure_future(self.broadcast({
                "type": "routine.run", "routine_id": routine["id"], "run_id": run_id, "name": routine["name"],
                "session_id": state["session_id"], "status": status, "error": error}))
            if status in ("done", "failed"):
                asyncio.ensure_future(self.send_items())

        report("running")
        try:
            await self.run_fn(routine, report)
        except asyncio.CancelledError:
            report("failed", error="Harness stopped during the run.")
            raise
        except Exception as e:  # noqa: BLE001 - the run fails, the scheduler continues.
            log.exception("The routine %s failed", routine["id"])
            report("failed", error=str(e) or type(e).__name__)
        else:
            if state["status"] not in ("done", "failed"):
                report("done")
        finally:
            self.active.pop(routine["id"], None)
            self._drain()


# The routine state of this daemon. server.py starts the scheduler, and the routine tools use it.
HUB = RoutineHub()
