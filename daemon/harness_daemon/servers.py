"""Local servers of a session (SPEC.md section 8.7): start, stop, logs, and the ready check.

States: ``stopped``, ``starting``, ``running``, ``crashed``.

- A server is ``running`` when a log line matches ``ready_pattern``, or when ``health_url``
  returns HTTP 200. With neither, it is ``running`` when its port accepts connections.
- If the port is in use, the server does not start.
- If a server stops with an error, the state is ``crashed`` and the status has its last 50 log lines.
- The session stops all its servers when it closes.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
import subprocess
import threading
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from .launch import ServerConfig, load_launch, server_dir
from .tools.shell import ShellInfo, _kill_tree

log = logging.getLogger("harness.servers")

Emit = Callable[[dict[str, Any]], Awaitable[None]]

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
URL_RE = re.compile(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+):(\d+)[^\s)'\",]*")
LOG_LINES = 1000
CRASH_LINES = 50
POLL_INTERVAL = 0.5
FLUSH_INTERVAL = 0.1


def port_in_use(port: int) -> bool:
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((host, port)) == 0:
                    return True
        except OSError:
            continue
    return False


@dataclass
class Server:
    config: ServerConfig
    state: str = "stopped"
    url: str | None = None
    port: int | None = None
    error: str | None = None
    proc: subprocess.Popen | None = None
    logs: deque = field(default_factory=lambda: deque(maxlen=LOG_LINES))
    stopping: bool = False
    tasks: list[asyncio.Task] = field(default_factory=list)
    pending: list[tuple[str, str]] = field(default_factory=list)  # Log lines to send.

    def status(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "type": "server.status",
            "name": self.config.name,
            "state": self.state,
            "port": self.port or self.config.port,
            "url": self.url,
        }
        if self.error:
            body["error"] = self.error
        if self.state == "crashed":
            body["last_lines"] = [{"stream": s, "text": t} for s, t in list(self.logs)[-CRASH_LINES:]]
        return body


class ServerManager:
    def __init__(self, project: Path, shell: ShellInfo, emit: Emit):
        self.project = Path(project)
        self.shell = shell
        self.emit = emit
        self.servers: dict[str, Server] = {}
        self.config_error: str | None = None
        self.reload()

    # -- configuration --------------------------------------------------------

    def reload(self) -> bool:
        """Read launch.json again. Return False if it does not exist. Running servers keep running."""
        try:
            configs = load_launch(self.project)
            self.config_error = None
        except Exception as e:  # noqa: BLE001 - show the problem, keep the old list.
            self.config_error = str(e)
            return True
        if configs is None:
            self.servers = {n: s for n, s in self.servers.items() if s.proc and s.proc.poll() is None}
            return False
        known = self.servers
        self.servers = {}
        for config in configs:
            server = known.pop(config.name, None) or Server(config)
            if server.state in ("stopped", "crashed"):
                server.config = config
            self.servers[config.name] = server
        # A running server that left launch.json stays in the list until it stops.
        for name, server in known.items():
            if server.proc and server.proc.poll() is None:
                self.servers[name] = server
        return True

    def get(self, name: str) -> Server:
        server = self.servers.get(name)
        if server is None:
            raise KeyError(name)
        return server

    def default(self) -> Server | None:
        for server in self.servers.values():
            if server.config.default:
                return server
        return next(iter(self.servers.values()), None)

    def items(self) -> list[dict[str, Any]]:
        out = []
        for server in self.servers.values():
            status = server.status()
            status.pop("type")
            c = server.config
            status.update({"command": c.command, "cwd": c.cwd, "default": c.default,
                           "ready_pattern": c.ready_pattern, "health_url": c.health_url})
            out.append(status)
        return out

    # -- start and stop ---------------------------------------------------------

    async def _set(self, server: Server, state: str, error: str | None = None) -> None:
        server.state = state
        server.error = error
        await self.emit(server.status())

    async def start(self, name: str) -> Server:
        server = self.get(name)
        if server.state in ("starting", "running"):
            return server
        config = server.config
        if config.port and await asyncio.to_thread(port_in_use, config.port):
            await self._set(server, "stopped", f"Port {config.port} is in use. Stop the other program, "
                                               "or change the port in launch.json.")
            return server

        env = dict(os.environ)
        env.update({"PYTHONUNBUFFERED": "1", "FORCE_COLOR": "0", "NO_COLOR": "1", "BROWSER": "none"})
        env.update(config.env)
        kwargs: dict[str, Any] = {
            "cwd": str(server_dir(self.project, config)),
            "stdin": subprocess.DEVNULL,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "env": env,
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            kwargs["start_new_session"] = True

        server.logs.clear()
        server.stopping = False
        server.url = f"http://localhost:{config.port}/" if config.port else None
        server.port = config.port
        try:
            server.proc = subprocess.Popen([*self.shell.argv, config.command], **kwargs)
        except OSError as e:
            await self._set(server, "crashed", f"The command did not start: {e}")
            return server
        await self._set(server, "starting")

        loop = asyncio.get_running_loop()
        ready = asyncio.Event()
        pattern = re.compile(config.ready_pattern) if config.ready_pattern else None

        def on_line(stream: str, text: str) -> None:  # Runs in the event loop.
            server.logs.append((stream, text))
            server.pending.append((stream, text))
            if server.state == "starting" and pattern and pattern.search(text):
                match = URL_RE.search(text)
                if match:  # The server printed its address. It can differ from the configured port.
                    # "0.0.0.0" and "[::]" mean "all addresses". A browser cannot open them.
                    server.url = match.group(0).replace("0.0.0.0", "localhost").replace("[::]", "localhost")
                    server.port = int(match.group(1))
                ready.set()

        def read(pipe, stream: str) -> None:  # Runs in a thread.
            for raw in iter(pipe.readline, b""):
                text = ANSI_RE.sub("", raw.decode("utf-8", errors="replace")).rstrip("\r\n")
                loop.call_soon_threadsafe(on_line, stream, text)
            pipe.close()

        proc = server.proc
        for pipe, stream in ((proc.stdout, "stdout"), (proc.stderr, "stderr")):
            threading.Thread(target=read, args=(pipe, stream), daemon=True).start()

        server.tasks = [
            asyncio.create_task(self._flush_logs(server)),
            asyncio.create_task(self._watch_exit(server, proc)),
            asyncio.create_task(self._watch_ready(server, ready, pattern is not None)),
        ]
        return server

    async def _watch_ready(self, server: Server, ready: asyncio.Event, has_pattern: bool) -> None:
        config = server.config
        if has_pattern:
            await ready.wait()
        elif config.health_url:
            async with httpx.AsyncClient(timeout=2) as client:
                while True:
                    try:
                        if (await client.get(config.health_url)).status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(POLL_INTERVAL)
        elif config.port:
            while not await asyncio.to_thread(port_in_use, config.port):
                await asyncio.sleep(POLL_INTERVAL)
        if server.state == "starting":
            await self._set(server, "running")

    async def _flush_logs(self, server: Server) -> None:
        """Send the new log lines about 10 times a second, one message for each stream."""
        try:
            while True:
                await asyncio.sleep(FLUSH_INTERVAL)
                await self._send_pending(server)
        except asyncio.CancelledError:
            await self._send_pending(server)
            raise

    async def _send_pending(self, server: Server) -> None:
        if not server.pending:
            return
        lines, server.pending = server.pending, []
        for stream in ("stdout", "stderr"):
            text = "\n".join(t for s, t in lines if s == stream)
            if text:
                await self.emit({"type": "server.log", "name": server.config.name, "stream": stream, "text": text})

    async def _watch_exit(self, server: Server, proc: subprocess.Popen) -> None:
        code = await asyncio.to_thread(proc.wait)
        await asyncio.sleep(FLUSH_INTERVAL * 2)  # Let the readers deliver the last lines.
        for task in server.tasks:
            if task is not asyncio.current_task():
                task.cancel()
        if server.proc is not proc:
            return
        server.proc = None
        if server.stopping:
            await self._set(server, "stopped")
        elif code == 0 and server.state == "running":
            await self._set(server, "stopped", "The server stopped.")
        else:
            await self._set(server, "crashed", f"The server stopped with exit code {code}.")

    async def stop(self, name: str) -> None:
        server = self.get(name)
        proc = server.proc
        if proc is None or proc.poll() is not None:
            if server.state != "stopped":
                await self._set(server, "stopped")
            return
        server.stopping = True
        await asyncio.to_thread(_kill_tree, proc)

    async def restart(self, name: str) -> None:
        server = self.get(name)
        if server.proc is not None:
            proc = server.proc
            await self.stop(name)
            await asyncio.to_thread(proc.wait)
            # Wait for the exit task: it sets the state to "stopped".
            for _ in range(50):
                if server.proc is None:
                    break
                await asyncio.sleep(0.05)
        await self.start(name)

    async def stop_all(self) -> None:
        for name in list(self.servers):
            try:
                await self.stop(name)
            except KeyError:
                continue

    def kill_all_now(self) -> None:
        """Stop the processes at once, with no events. For a daemon that stops."""
        for server in self.servers.values():
            if server.proc and server.proc.poll() is None:
                server.stopping = True
                _kill_tree(server.proc)
