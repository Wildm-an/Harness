"""Background tasks: commands that the agent starts with ``bash`` and ``run_in_background``.

A task runs while the agent does other work, for example a build or a test run. The agent reads
its output with the ``task_output`` tool and stops it with ``task_stop``. The client shows the
tasks of the session in the Background tasks pane. When a task ends, the next prompt of the user
tells the agent (``take_ended_notes``).
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
from typing import Any, Callable

from .tools.shell import ShellInfo, _kill_tree

MAX_TASKS = 10  # Running tasks of one session.
MAX_KEPT_OUTPUT = 256 * 1024  # Characters. The start of a long output goes away.
MAX_ENDED_KEPT = 20  # Ended tasks that the list still shows.
STOP_WAIT = 5  # Seconds: after the kill, the time for the shell to end.

OnChange = Callable[[], None]


class TaskError(Exception):
    pass


@dataclass
class BackgroundTask:
    id: str
    command: str
    description: str
    started_at: float
    proc: subprocess.Popen | None = None
    ended_at: float | None = None
    returncode: int | None = None
    stopped: bool = False  # The user or the agent stopped it.
    output: str = ""
    dropped: int = 0  # Characters of output that went away (the start of a long output).
    read_to: int = 0  # The agent read the output up to here (a position in all the output).
    noted: bool = False  # The agent knows that the task ended.
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    @property
    def status(self) -> str:
        if self.ended_at is None:
            return "running"
        if self.stopped:
            return "stopped"
        return "done" if self.returncode == 0 else "failed"

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

    def summary(self) -> dict[str, Any]:
        return {"id": self.id, "command": self.command, "description": self.description, "status": self.status,
                "started_at": self.started_at, "ended_at": self.ended_at, "returncode": self.returncode}


class TaskHost:
    """The background tasks of one session."""

    def __init__(self, cwd: Path, shell: ShellInfo, on_change: OnChange | None = None):
        self.cwd = cwd
        self.shell = shell
        self.on_change = on_change
        self.tasks: dict[str, BackgroundTask] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._end_lock = threading.Lock()  # The output thread and stop() can both end a task.

    @property
    def running(self) -> list[BackgroundTask]:
        return [t for t in self.tasks.values() if t.ended_at is None]

    def start(self, command: str, description: str = "") -> BackgroundTask:
        if len(self.running) >= MAX_TASKS:
            raise TaskError(f"At most {MAX_TASKS} background tasks can run. Stop one first with task_stop.")
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
                              started_at=time.time(), proc=proc)
        self.tasks[task.id] = task
        self._prune()
        threading.Thread(target=self._read, args=(task,), name=f"harness-{task.id}", daemon=True).start()
        self._changed()
        return task

    def _read(self, task: BackgroundTask) -> None:
        """Read the output of a task until it ends. It runs in a thread."""
        proc = task.proc
        assert proc is not None and proc.stdout is not None
        for chunk in iter(lambda: proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096), b""):
            task.append(chunk.decode("utf-8", errors="replace").replace("\r\n", "\n"))
        proc.wait()
        if not self._mark_ended(task):
            return  # stop() ended the task first.
        loop = self._loop
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(self._changed)
            except RuntimeError:  # The loop closed at this moment.
                pass

    def get(self, task_id: str) -> BackgroundTask:
        task = self.tasks.get(task_id)
        if task is None:
            names = ", ".join(self.tasks) or "none"
            raise TaskError(f"Unknown background task: {task_id}. The tasks are: {names}.")
        return task

    def _mark_ended(self, task: BackgroundTask) -> bool:
        """Set the end of a task one time. Return True if this call set it."""
        with self._end_lock:
            if task.ended_at is not None:
                return False
            task.returncode = task.proc.returncode if task.proc is not None else None
            task.ended_at = time.time()
            return True

    async def stop(self, task_id: str) -> BackgroundTask:
        task = self.get(task_id)
        if task.ended_at is None and task.proc is not None:
            task.stopped = True
            await asyncio.to_thread(_kill_tree, task.proc)
            # The task ends when its shell ends. A child that started at the moment of the kill is not
            # in the process tree of the shell: it can keep the output pipe open, and the output thread
            # then waits for it. On Windows, the Git Bash launcher starts bash, which starts the command.
            try:
                await asyncio.to_thread(task.proc.wait, STOP_WAIT)
            except subprocess.TimeoutExpired:
                return task
            if self._mark_ended(task):
                self._changed()
        return task

    async def wait(self, task: BackgroundTask, seconds: float) -> None:
        """Wait until the task ends, or at most ``seconds``."""
        deadline = time.monotonic() + seconds
        while task.ended_at is None and time.monotonic() < deadline:
            await asyncio.sleep(0.2)

    def take_ended_notes(self) -> list[str]:
        """Notes for the agent about the tasks that ended since the last prompt."""
        notes = []
        for task in self.tasks.values():
            if task.ended_at is not None and not task.noted:
                task.noted = True
                how = "was stopped" if task.stopped else f"ended with exit code {task.returncode}"
                notes.append(f"The background task {task.id} ({task.description or task.command}) {how}. "
                             f"Read its output with task_output.")
        return notes

    def _prune(self) -> None:
        ended = [t for t in self.tasks.values() if t.ended_at is not None]
        for task in ended[:max(0, len(ended) - MAX_ENDED_KEPT)]:
            del self.tasks[task.id]

    def _changed(self) -> None:
        if self.on_change is not None:
            self.on_change()

    def close(self) -> None:
        """Stop all tasks: the session closes."""
        for task in self.running:
            if task.proc is not None:
                task.stopped = True
                _kill_tree(task.proc)
