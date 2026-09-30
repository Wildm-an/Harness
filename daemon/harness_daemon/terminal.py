"""The terminal pane: an interactive shell in the project folder, in a pseudo terminal.

Windows uses ConPTY (pywinpty). Other systems use the pty module. Each session has one shell.
The shell stays open when the client goes to another session. The daemon keeps the last output,
so a client that returns to the session shows it again.
"""

from __future__ import annotations

import asyncio
import codecs
import logging
import os
import secrets
import shutil
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Awaitable, Callable

log = logging.getLogger("harness.terminal")

Emit = Callable[[dict[str, Any]], Awaitable[None]]

MAX_REPLAY = 256 * 1024  # The characters of output that the daemon keeps for a client that returns.
READ_SIZE = 4096
WATCH_INTERVAL = 0.5  # Seconds. On Windows the output pipe can stay open after the shell stops.


class TerminalError(Exception):
    pass


def shell_command(preferred: str | None = None) -> list[str]:
    """The interactive shell: the "terminal_shell" setting, PowerShell on Windows, or $SHELL."""
    if preferred:
        return [preferred]
    if os.name == "nt":
        found = shutil.which("pwsh.exe") or shutil.which("powershell.exe") or "powershell.exe"
        return [found, "-NoLogo"]
    return [os.environ.get("SHELL") or ("/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"), "-i"]


class _Pty:
    """A process in a pseudo terminal. The read calls block: they run in a thread."""

    def __init__(self, argv: list[str], cwd: Path, cols: int, rows: int):
        env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"}
        if os.name == "nt":
            from winpty import PtyProcess  # type: ignore[import-not-found]

            self._proc = PtyProcess.spawn(argv, cwd=str(cwd), env=env, dimensions=(rows, cols))
            self.pid = self._proc.pid
        else:
            import fcntl
            import pty
            import subprocess
            import termios

            master, slave = pty.openpty()
            self._set_size(master, cols, rows)

            def controlling_tty() -> None:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)

            self._popen = subprocess.Popen(
                argv, cwd=str(cwd), env=env, stdin=slave, stdout=slave, stderr=slave,
                start_new_session=True, preexec_fn=controlling_tty, close_fds=True,
            )
            os.close(slave)
            self._fd = master
            self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            self.pid = self._popen.pid

    @staticmethod
    def _set_size(fd: int, cols: int, rows: int) -> None:
        import fcntl
        import struct
        import termios

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def read(self) -> str:
        """The next output. An empty string: the process stopped."""
        if os.name == "nt":
            try:
                return self._proc.read(READ_SIZE) or ""
            except EOFError:
                return ""
        try:
            data = os.read(self._fd, READ_SIZE)
        except OSError:
            return ""
        return self._decoder.decode(data) if data else ""

    def write(self, data: str) -> None:
        if os.name == "nt":
            self._proc.write(data)
        else:
            os.write(self._fd, data.encode("utf-8"))

    def resize(self, cols: int, rows: int) -> None:
        if os.name == "nt":
            self._proc.setwinsize(rows, cols)
        else:
            self._set_size(self._fd, cols, rows)

    def is_alive(self) -> bool:
        if os.name == "nt":
            return bool(self._proc.isalive())
        return self._popen.poll() is None

    def exit_code(self) -> int | None:
        """The exit code. It waits up to 2 seconds: call it from the reader thread."""
        if os.name == "nt":
            return self._proc.exitstatus
        try:
            return self._popen.wait(timeout=2)
        except Exception:  # noqa: BLE001 - subprocess.TimeoutExpired: the code is not known.
            return None

    def kill(self) -> None:
        if os.name == "nt":
            if self._proc.isalive():
                self._proc.terminate(force=True)
            return
        if self._popen.poll() is None:
            self._popen.kill()
        try:
            os.close(self._fd)
        except OSError:
            pass


class Terminal:
    def __init__(self, pty: _Pty, emit: Emit, loop: asyncio.AbstractEventLoop,
                 on_exit: Callable[[Terminal], None]):
        self.id = secrets.token_hex(6)
        self.alive = True
        self._pty = pty
        self._emit = emit
        self._loop = loop
        self._on_exit = on_exit
        self._chunks: deque[tuple[int, str]] = deque()  # The kept output: (number, text).
        self._kept = 0  # The characters in _chunks.
        self.seq = 0  # The number of the last output. A client drops output that its replay has.
        self._thread = threading.Thread(target=self._read_loop, name=f"terminal-{self.id}", daemon=True)
        self._thread.start()
        self._watcher = threading.Thread(target=self._watch, name=f"terminal-watch-{self.id}", daemon=True)
        self._watcher.start()

    def replay(self, since: int = 0) -> tuple[str, int, bool]:
        """The output after output number ``since``, the number of the last output, and a reset flag.

        A client that has the screen up to ``since`` writes only the missing output. If the daemon
        does not keep all of it, or ``since`` is 0, the flag is True: the client clears its screen
        and writes all the kept output.
        """
        first = self._chunks[0][0] if self._chunks else self.seq + 1
        reset = since <= 0 or since + 1 < first or since > self.seq
        text = "".join(t for n, t in self._chunks if reset or n > since)
        return text, self.seq, reset

    def _keep(self, seq: int, text: str) -> None:
        self._chunks.append((seq, text))
        self._kept += len(text)
        while self._kept > MAX_REPLAY and len(self._chunks) > 1:
            self._kept -= len(self._chunks.popleft()[1])

    def _watch(self) -> None:
        """Report the stop of the shell when the process ends, also if its output pipe stays open."""
        while self.alive:
            time.sleep(WATCH_INTERVAL)
            try:
                alive = self._pty.is_alive()
            except Exception:  # noqa: BLE001 - the read loop reports the stop.
                return
            if not alive:
                try:
                    code = self._pty.exit_code()
                except Exception:  # noqa: BLE001 - the code is for information only.
                    code = None
                self._post(self._stopped, code)
                return

    def _read_loop(self) -> None:
        while True:
            text = self._pty.read()
            if not text:
                break
            if not self._post(self._output, text):
                break
        try:
            code = self._pty.exit_code()
        except Exception:  # noqa: BLE001 - the code is for information only.
            code = None
        self._post(self._stopped, code)

    def _post(self, callback: Callable[..., None], *args: Any) -> bool:
        """Run ``callback`` on the event loop from a thread. Return False if the loop is closed.

        The loop of the connection can close before the shell stops. Then nothing receives the output.
        """
        if self._loop.is_closed():
            return False
        try:
            self._loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:  # The loop closed after the check.
            return False
        return True

    def _output(self, text: str) -> None:
        self.seq += 1
        self._keep(self.seq, text)
        asyncio.ensure_future(self._emit({"type": "term.output", "id": self.id, "data": text, "seq": self.seq}))

    def _stopped(self, code: int | None) -> None:
        if not self.alive:
            return
        self.alive = False
        asyncio.ensure_future(self._emit({"type": "term.exit", "id": self.id, "code": code}))
        self._on_exit(self)

    def write(self, data: str) -> None:
        if self.alive:
            self._pty.write(data)

    def resize(self, cols: int, rows: int) -> None:
        if self.alive:
            self._pty.resize(cols, rows)

    def kill(self) -> None:
        self.alive = False
        try:
            self._pty.kill()
        except Exception:  # noqa: BLE001 - the process can be gone already.
            log.debug("The terminal %s did not stop cleanly", self.id, exc_info=True)


class TerminalHost:
    """The shell of one session."""

    def __init__(self, cwd: Path, emit: Emit, on_exit: Callable[[], None] | None = None):
        self.cwd = cwd
        self._emit = emit
        self._on_exit = on_exit
        self.terminal: Terminal | None = None

    @property
    def alive(self) -> bool:
        return self.terminal is not None and self.terminal.alive

    def open(self, cols: int, rows: int, shell: str | None = None) -> tuple[Terminal, bool]:
        """Return the running shell, or start one. The flag is True for a new shell."""
        if self.terminal is not None and self.terminal.alive:
            self.terminal.resize(cols, rows)
            return self.terminal, False
        argv = shell_command(shell)
        try:
            pty = _Pty(argv, self.cwd, cols, rows)
        except Exception as e:  # noqa: BLE001 - report any start error to the client.
            raise TerminalError(f"The shell did not start ({argv[0]}): {e}") from e
        self.terminal = Terminal(pty, self._emit, asyncio.get_running_loop(), self._exited)
        return self.terminal, True

    def get(self, terminal_id: str) -> Terminal:
        if self.terminal is None or self.terminal.id != terminal_id:
            raise TerminalError(f"Unknown terminal: {terminal_id}")
        return self.terminal

    def _exited(self, terminal: Terminal) -> None:
        if self._on_exit is not None:
            self._on_exit()

    def close(self) -> None:
        if self.terminal is not None:
            self.terminal.kill()
            self.terminal = None
