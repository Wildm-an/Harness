"""Background tasks of a session. They run while the agent does other work.

The kinds of task:

- ``shell``: a command that the agent starts with ``bash`` and ``run_in_background``, for example a
  build or a test run.
- ``monitor``: a command that the agent starts with the ``monitor`` tool. Each new output line goes
  to the agent as a note.
- ``agent``: a subagent that the agent starts with the ``agent`` tool and ``run_in_background``.
- ``wakeup``: a timer that the agent starts with ``schedule_wakeup``. At the end, its prompt goes to
  the agent.
- ``cron``: a scheduled prompt that the agent starts with ``cron_create``. At each time of its cron
  expression, its prompt goes to the agent. A recurring one ends after 7 days.

The agent reads the output with ``task_output`` and stops a task with ``task_stop``. The client shows
the tasks in the Background tasks pane and in the session rail. When a task ends (or a monitor writes
output), the host calls ``on_notify``. The session then gives the notes (``take_notes``) to the agent:
in the running turn, or in a new turn.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from .tools.shell import ShellInfo, _kill_tree

MAX_TASKS = 10  # Running tasks of one session.
MAX_KEPT_OUTPUT = 256 * 1024  # Characters. The start of a long output goes away.
MAX_ENDED_KEPT = 20  # Ended tasks that the list still shows.
STOP_WAIT = 5  # Seconds: after the kill, the time for the shell to end.
MAX_NOTE_CHARS = 4000  # The output of a monitor in one note. The start of a long output goes away.
MAX_REPORT_CHARS = 20_000  # The report of a background subagent in its note.

TASK_KINDS = ("shell", "monitor", "agent", "wakeup", "cron")

OnChange = Callable[[], None]
# The work of an "agent" or a "wakeup" task. It returns the exit code (0: done) and can add output.
Job = Callable[["BackgroundTask"], Awaitable[int]]


class TaskError(Exception):
    pass


@dataclass
class BackgroundTask:
    id: str
    command: str  # shell, monitor: the command. agent: the prompt. wakeup: the prompt for the agent.
    description: str
    started_at: float
    kind: str = "shell"
    proc: subprocess.Popen | None = None
    job: asyncio.Task | None = None  # agent, wakeup.
    ended_at: float | None = None
    returncode: int | None = None
    stopped: bool = False  # The user or the agent stopped it.
    timed_out: bool = False  # A monitor that ran for its full time.
    wake_at: float | None = None  # wakeup: the time of the end. cron: the next time. Epoch seconds.
    schedule: str = ""  # cron: the cron expression.
    recurring: bool = False  # cron: it fires more than one time.
    fires: list[str] = field(default_factory=list)  # cron: the times that fired, with no note yet.
    output: str = ""
    result: str = ""  # agent: the report.
    dropped: int = 0  # Characters of output that went away (the start of a long output).
    read_to: int = 0  # The agent read the output up to here (a position in all the output).
    notified_to: int = 0  # monitor: the notes gave the output up to here.
    noted: bool = False  # The agent knows that the task ended.
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def status(self) -> str:
        if self.ended_at is None:
            return "running"
        if self.stopped:
            return "stopped"
        return "done" if self.returncode == 0 or self.timed_out else "failed"

    @property
    def label(self) -> str:
        """The description, or the first line of the command."""
        if self.description:
            return self.description
        first = self.command.strip().splitlines()[0] if self.command.strip() else ""
        return first[:80] or self.id

    def append(self, text: str) -> None:
        with self._lock:
            self.output += text
            if len(self.output) > MAX_KEPT_OUTPUT:
                cut = len(self.output) - MAX_KEPT_OUTPUT
                self.output = self.output[cut:]
                self.dropped += cut

    def new_output(self) -> str:
        """The output that the agent did not read yet. It moves the read position to the end."""
        with self._lock:
            end = self.dropped + len(self.output)
            start = max(self.read_to, self.dropped)
            text = self.output[start - self.dropped:]
            skipped = start - self.read_to
            self.read_to = end
        return (f"[{skipped} earlier characters are not kept.]\n" if skipped else "") + text

    def take_new_lines(self) -> str:
        """monitor: the complete lines after the last note. It moves the note position after them.

        At the end of the task, the last line goes too, also with no line end.
        """
        with self._lock:
            start = max(self.notified_to, self.dropped)
            text = self.output[start - self.dropped:]
            if self.ended_at is None:
                cut = text.rfind("\n")
                text = text[:cut + 1] if cut >= 0 else ""
            self.notified_to = start + len(text)
        if len(text) > MAX_NOTE_CHARS:
            text = f"[{len(text) - MAX_NOTE_CHARS} earlier characters are not shown.]\n" + text[-MAX_NOTE_CHARS:]
        return text

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "command": self.command, "description": self.description,
                "status": self.status, "started_at": self.started_at, "ended_at": self.ended_at,
                "returncode": self.returncode, "wake_at": self.wake_at,
                "schedule": self.schedule or None, "recurring": self.recurring}


class TaskHost:
    """The background tasks of one session."""

    def __init__(self, cwd: Path, shell: ShellInfo, on_change: OnChange | None = None,
                 on_notify: OnChange | None = None):
        self.cwd = cwd
        self.shell = shell
        self.on_change = on_change  # A task started or ended: the client gets the list.
        self.on_notify = on_notify  # A note for the agent is ready (take_notes).
        self.tasks: dict[str, BackgroundTask] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._end_lock = threading.Lock()  # The output thread and stop() can both end a task.

    @property
    def running(self) -> list[BackgroundTask]:
        return [t for t in self.tasks.values() if t.ended_at is None]

    def _check_room(self) -> None:
        if len(self.running) >= MAX_TASKS:
            raise TaskError(f"At most {MAX_TASKS} background tasks can run. Stop one first with task_stop.")

    def _add(self, task: BackgroundTask) -> None:
        self.tasks[task.id] = task
        self._prune()

    def start(self, command: str, description: str = "", kind: str = "shell",
              timeout: float | None = None) -> BackgroundTask:
        """Start a command: a "shell" task, or a "monitor" task. A monitor stops after ``timeout`` seconds."""
        self._check_room()
        self._loop = asyncio.get_running_loop()
        env = dict(os.environ)
        env.setdefault("PAGER", "cat")
        env.setdefault("GIT_PAGER", "cat")
        kwargs: dict[str, Any] = {"cwd": str(self.cwd), "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
                                  "stderr": subprocess.STDOUT, "env": env}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            kwargs["start_new_session"] = True
        try:
            proc = subprocess.Popen([*self.shell.argv, command], **kwargs)
        except OSError as e:
            raise TaskError(f"The command did not start: {e}") from e
        task = BackgroundTask(id=f"task-{uuid.uuid4().hex[:6]}", command=command, description=description.strip(),
                              started_at=time.time(), kind=kind, proc=proc)
        self._add(task)
        threading.Thread(target=self._read, args=(task,), name=f"harness-{task.id}", daemon=True).start()
        if timeout:
            self._loop.call_later(timeout, lambda: asyncio.ensure_future(self._time_out(task)))
        self._changed()
        return task

    def start_job(self, kind: str, command: str, description: str, job: Job,
                  wake_at: float | None = None) -> BackgroundTask:
        """Start an "agent" or a "wakeup" task: an asyncio job in the loop of the daemon."""
        self._check_room()
        self._loop = asyncio.get_running_loop()
        task = BackgroundTask(id=f"task-{uuid.uuid4().hex[:6]}", command=command, description=description.strip(),
                              started_at=time.time(), kind=kind, wake_at=wake_at)
        self._add(task)
        task.job = asyncio.create_task(self._run_job(task, job))
        self._changed()
        return task

    async def _run_job(self, task: BackgroundTask, job: Job) -> None:
        code: int | None
        try:
            code = await job(task)
        except asyncio.CancelledError:
            code = None
            task.stopped = True
        except Exception as e:  # noqa: BLE001 - the error goes into the output of the task.
            task.append(f"\n[Error: {type(e).__name__}: {e}]\n")
            code = 1
        if self._mark_ended(task, code):
            self._ended()

    async def _time_out(self, task: BackgroundTask) -> None:
        if task.ended_at is None:
            task.timed_out = True
            await self.stop(task.id, stopped=False)

    def _read(self, task: BackgroundTask) -> None:
        """Read the output of a command until it ends. It runs in a thread."""
        proc = task.proc
        assert proc is not None and proc.stdout is not None
        for chunk in iter(lambda: proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096), b""):
            task.append(chunk.decode("utf-8", errors="replace").replace("\r\n", "\n"))
            if task.kind == "monitor" and b"\n" in chunk:
                self._in_loop(self._notify)
        proc.wait()
        if self._mark_ended(task, proc.returncode):
            self._in_loop(self._ended)

    def _in_loop(self, fn: Callable[[], None]) -> None:
        loop = self._loop
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(fn)
            except RuntimeError:  # The loop closed at this moment.
                pass

    def get(self, task_id: str) -> BackgroundTask:
        task = self.tasks.get(task_id)
        if task is None:
            names = ", ".join(self.tasks) or "none"
            raise TaskError(f"Unknown background task: {task_id}. The tasks are: {names}.")
        return task

    def _mark_ended(self, task: BackgroundTask, returncode: int | None) -> bool:
        """Set the end of a task one time. Return True if this call set it."""
        with self._end_lock:
            if task.ended_at is not None:
                return False
            task.returncode = returncode
            task.ended_at = time.time()
            return True

    async def stop(self, task_id: str, stopped: bool = True) -> BackgroundTask:
        task = self.get(task_id)
        if task.ended_at is not None:
            return task
        task.stopped = stopped
        if task.job is not None:
            task.job.cancel()
            try:
                await task.job
            except asyncio.CancelledError:
                pass
            # A job that stopped before it started did not set its end.
            if self._mark_ended(task, None):
                self._ended()
            return task
        if task.proc is not None:
            await asyncio.to_thread(_kill_tree, task.proc)
            # The task ends when its shell ends. A child that started at the moment of the kill is not
            # in the process tree of the shell: it can keep the output pipe open, and the output thread
            # then waits for it. On Windows, the Git Bash launcher starts bash, which starts the command.
            try:
                await asyncio.to_thread(task.proc.wait, STOP_WAIT)
            except subprocess.TimeoutExpired:
                return task
            if self._mark_ended(task, task.proc.returncode):
                self._ended()
        return task

    async def wait(self, task: BackgroundTask, seconds: float) -> None:
        """Wait until the task ends, or at most ``seconds``."""
        deadline = time.monotonic() + seconds
        while task.ended_at is None and time.monotonic() < deadline:
            await asyncio.sleep(0.2)

    def take_notes(self) -> list[tuple[str, str]]:
        """The notes for the agent since the last call: (text for the model, short text for the user).

        A note tells about a task that ended, the new output of a monitor, the report of a background
        subagent, or the prompt of a wakeup. A task that the agent stopped or read gives no end note.
        """
        notes: list[tuple[str, str]] = []
        for task in list(self.tasks.values()):
            if task.kind == "cron" and task.fires:
                when, task.fires = task.fires[-1], []
                notes.append((f"The scheduled task {task.id} ({task.label}) is due ({when}, cron "
                              f"'{task.schedule}'). Its prompt:\n{task.command}", f"Scheduled task: {task.label}"))
            if task.kind == "monitor":
                lines = task.take_new_lines().rstrip("\n")
                if lines.strip():
                    notes.append((f"New output of the monitor {task.id} ({task.label}):\n{lines}",
                                  f"Monitor output: {task.label}"))
            if task.ended_at is None or task.noted:
                continue
            task.noted = True
            note = self._end_note(task)
            if note is not None:
                notes.append(note)
        return notes

    def _end_note(self, task: BackgroundTask) -> tuple[str, str] | None:
        how = ("was stopped" if task.stopped else "ran for its full time and was stopped" if task.timed_out
               else f"ended with exit code {task.returncode}")
        if task.kind == "cron":
            # A one-time task gave its prompt when it fired. A recurring task that ran 7 days ends.
            if task.stopped or not task.recurring or task.returncode != 0:
                return None
            return (f"The recurring task {task.id} ({task.label}) ended after 7 days. Make it again with "
                    "cron_create if the user still wants it.", f"Scheduled task ended: {task.label}")
        if task.kind == "wakeup":
            if task.stopped:
                return None
            return (f"The scheduled wakeup {task.id} ({task.label}) is due. Its prompt:\n{task.command}",
                    f"Scheduled wakeup: {task.label}")
        if task.kind == "agent":
            if task.stopped:
                return (f"The background agent {task.id} ({task.label}) was stopped.",
                        f"Background agent stopped: {task.label}")
            report = task.result or task.output.strip() or "(no report)"
            if len(report) > MAX_REPORT_CHARS:
                report = report[:MAX_REPORT_CHARS] + "\n[The report is longer. Read all of it with task_output.]"
            state = "finished" if task.returncode == 0 else "failed"
            task.read_to = task.dropped + len(task.output)  # The note holds the report.
            return (f"The background agent {task.id} ({task.label}) {state}. Its report:\n\n{report}",
                    f"Background agent {state}: {task.label}")
        if task.kind == "monitor":
            return (f"The monitor {task.id} ({task.label}) {how}.", f"Monitor ended: {task.label}")
        return (f"The background task {task.id} ({task.label}) {how}. Read its output with task_output.",
                f"Background task {'stopped' if task.stopped else 'ended'}: {task.label}")

    def take_ended_notes(self) -> list[str]:
        """The texts of ``take_notes``, for the model only."""
        return [text for text, _ in self.take_notes()]

    def _prune(self) -> None:
        ended = [t for t in self.tasks.values() if t.ended_at is not None]
        for task in ended[:max(0, len(ended) - MAX_ENDED_KEPT)]:
            del self.tasks[task.id]

    def _changed(self) -> None:
        if self.on_change is not None:
            self.on_change()

    def _notify(self) -> None:
        if self.on_notify is not None:
            self.on_notify()

    def fire(self, task: BackgroundTask, when: str) -> None:
        """A cron task is due: its prompt goes to the agent as a note."""
        task.fires.append(when)
        self._notify()
        self._changed()

    def _ended(self) -> None:
        self._notify()  # First: the session stays open for the note.
        self._changed()

    def close(self) -> None:
        """Stop all tasks: the session closes."""
        for task in self.running:
            task.stopped = True
            if task.job is not None:
                task.job.cancel()
            elif task.proc is not None:
                _kill_tree(task.proc)
