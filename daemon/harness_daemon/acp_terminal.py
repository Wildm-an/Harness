"""The terminals of an ACP harness: Harness runs the commands of the harness (``terminal/*`` of ACP).

The harness asks with ``terminal/create`` and gets an id. It reads the output with ``terminal/output``,
waits with ``terminal/wait_for_exit``, and stops the command with ``terminal/kill``. ``terminal/release``
stops the command if it runs, and forgets it. A command with no arguments runs in the shell of
Harness (tools/shell.py), so a command line such as ``npm test && npm run build`` works.

The output is stdout and stderr in one stream. When it is longer than the byte limit of the harness,
Harness keeps the end, as ACP requires.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from .tools.shell import ShellInfo, _kill_tree

DEFAULT_LIMIT = 1_000_000  # Bytes of output to keep, when the harness gives no limit.
MAX_TERMINALS = 32


class TerminalError(Exception):
    pass


class Terminal:
    def __init__(self, terminal_id: str, argv: list[str], cwd: Path, env: dict[str, str], limit: int, label: str):
        self.id = terminal_id
        self.label = label  # The command line, for the tool rows.
        self.limit = limit
        self._chunks = bytearray()
        self.truncated = False
        self._lock = threading.Lock()
        kwargs: dict[str, Any] = {"cwd": str(cwd), "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE,
                                  "stderr": subprocess.STDOUT, "env": env}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            kwargs["start_new_session"] = True
        try:
            self.proc = subprocess.Popen(argv, **kwargs)
        except OSError as e:
            raise TerminalError(f"The command could not start: {e}") from None
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self) -> None:
        stream = self.proc.stdout
        assert stream is not None
        while True:
            data = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
            if not data:
                return
            with self._lock:
                self._chunks += data
                if len(self._chunks) > self.limit:
                    # Keep the end. Do not cut a UTF-8 character in two.
                    cut = len(self._chunks) - self.limit
                    while cut < len(self._chunks) and (self._chunks[cut] & 0xC0) == 0x80:
                        cut += 1
                    del self._chunks[:cut]
                    self.truncated = True

    def output(self) -> str:
        with self._lock:
            data = bytes(self._chunks)
        return data.decode("utf-8", errors="replace").replace("\r\n", "\n")

    def exit_status(self) -> dict[str, Any] | None:
        code = self.proc.poll()
        if code is None:
            return None
        return {"exitCode": code if code >= 0 else None, "signal": None if code >= 0 else f"signal {-code}"}

    async def wait(self) -> dict[str, Any]:
        await asyncio.to_thread(self.proc.wait)
        await asyncio.to_thread(self._reader.join, 5)
        status = self.exit_status()
        assert status is not None
        return status

    async def kill(self) -> None:
        if self.proc.poll() is None:
            await asyncio.to_thread(_kill_tree, self.proc)


class TerminalHost:
    """The terminals of one ACP session."""

    def __init__(self, cwd: Path, shell: ShellInfo):
        self.cwd = cwd
        self.shell = shell
        self.terminals: dict[str, Terminal] = {}

    def create(self, params: dict[str, Any]) -> Terminal:
        command = params.get("command")
        if not isinstance(command, str) or not command.strip():
            raise TerminalError("terminal/create needs a command.")
        if len(self.terminals) >= MAX_TERMINALS:
            raise TerminalError(f"At most {MAX_TERMINALS} terminals can be open. Release a terminal first.")
        args = [str(a) for a in params.get("args") or [] if isinstance(a, (str, int, float))]
        env = dict(os.environ)
        env.setdefault("PAGER", "cat")
        env.setdefault("GIT_PAGER", "cat")
        # Python writes UTF-8, as the output is read: else Windows Python writes the code page, and
        # a script that prints a character outside it (for example "→") fails.
        env.setdefault("PYTHONIOENCODING", "utf-8")
        for item in params.get("env") or []:
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                env[item["name"]] = str(item.get("value") or "")
        cwd = Path(params["cwd"]) if isinstance(params.get("cwd"), str) and params["cwd"] else self.cwd
        if not cwd.is_dir():
            raise TerminalError(f"The folder does not exist: {cwd}")
        argv = [command, *args] if args else [*self.shell.argv, command]
        limit = params.get("outputByteLimit")
        limit = int(limit) if isinstance(limit, int) and limit > 0 else DEFAULT_LIMIT
        terminal = Terminal(f"term_{uuid.uuid4().hex[:12]}", argv, cwd, env, limit, " ".join([command, *args]))
        self.terminals[terminal.id] = terminal
        return terminal

    def get(self, params: dict[str, Any]) -> Terminal:
        terminal = self.terminals.get(str(params.get("terminalId")))
        if terminal is None:
            raise TerminalError(f"Unknown terminal: {params.get('terminalId')}")
        return terminal

    async def release(self, terminal_id: str) -> None:
        terminal = self.terminals.pop(terminal_id, None)
        if terminal is not None:
            await terminal.kill()

    async def close(self) -> None:
        for terminal_id in list(self.terminals):
            await self.release(terminal_id)
