"""SSH tunnels to model endpoints.

A provider with an ``ssh`` field reaches its model through an SSH tunnel. The
``base_url`` is the address of the model server as the SSH host sees it::

    "gpu-box": { "base_url": "http://127.0.0.1:11434/v1", "ssh": "drew@gpu-box" }

The daemon runs ``ssh -N -L 127.0.0.1:<free port>:127.0.0.1:11434 drew@gpu-box`` and
sends the model requests to ``http://127.0.0.1:<free port>/v1``.

- Key authentication only (``BatchMode=yes``). The daemon never waits for a password.
- A new host key is accepted and stored on the first connection. A changed key stops the tunnel.
- One tunnel for each SSH host and model address. The daemon keeps it open, opens a new one
  if ssh stops, and closes all tunnels when it stops.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
import subprocess
import threading
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse, urlunparse

log = logging.getLogger("harness.tunnels")

OPEN_TIMEOUT = 25
# The ssh command. Tests replace it with a fake ssh program.
SSH_COMMAND: list[str] = ["ssh"]

_SAFE = re.compile(r"^[^\s\x00-\x1f-][^\s\x00-\x1f]*$")


class TunnelError(Exception):
    pass


@dataclass(frozen=True)
class SshTarget:
    host: str
    user: str | None = None
    port: int | None = None
    identity_file: str | None = None

    @property
    def label(self) -> str:
        user = f"{self.user}@" if self.user else ""
        port = f":{self.port}" if self.port else ""
        return f"{user}{self.host}{port}"


def parse_ssh(value: Any) -> SshTarget | None:
    """Read the ``ssh`` field of a provider: "user@host", "user@host:port", or an object.

    A value that ssh could read as an option (it starts with "-") is not valid.
    """
    if value in (None, "", False):
        return None
    if isinstance(value, str):
        text = value.strip()
        user, _, rest = text.rpartition("@")
        host, port = rest, None
        match = re.fullmatch(r"(.+):(\d+)", rest)
        if match:
            host, port = match.group(1), int(match.group(2))
        target = SshTarget(host=host, user=user or None, port=port)
    elif isinstance(value, dict):
        port = value.get("port")
        target = SshTarget(
            host=str(value.get("host") or "").strip(),
            user=(str(value["user"]).strip() or None) if value.get("user") else None,
            port=int(port) if port not in (None, "") else None,
            identity_file=(str(value["identity_file"]).strip() or None) if value.get("identity_file") else None,
        )
    else:
        raise ValueError("'ssh' must be a string such as \"user@host\" or an object with 'host'.")
    for label, part in (("host", target.host), ("user", target.user)):
        if part is not None and not _SAFE.match(part):
            raise ValueError(f"The SSH {label} is not valid: {part!r}")
    if not target.host:
        raise ValueError("The SSH host is empty.")
    if target.port is not None and not 1 <= target.port <= 65535:
        raise ValueError(f"The SSH port is not valid: {target.port}")
    if target.identity_file and target.identity_file.startswith("-"):
        raise ValueError(f"The identity file is not valid: {target.identity_file!r}")
    return target


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _can_connect(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


def _default_port(scheme: str) -> int:
    return 443 if scheme == "https" else 80


@dataclass
class _Tunnel:
    proc: subprocess.Popen
    local_port: int


class TunnelManager:
    def __init__(self) -> None:
        self._tunnels: dict[tuple, _Tunnel] = {}
        self._locks: dict[tuple, asyncio.Lock] = {}

    async def local_url(self, base_url: str, ssh: SshTarget) -> str:
        """Return ``base_url`` with the host and the port of an open tunnel."""
        url = urlparse(base_url)
        remote_host = url.hostname or "127.0.0.1"
        remote_port = url.port or _default_port(url.scheme)
        key = (ssh, remote_host, remote_port)
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            tunnel = self._tunnels.get(key)
            if tunnel is None or tunnel.proc.poll() is not None:
                if tunnel is not None:
                    log.warning("The SSH tunnel to %s stopped. Opening a new one.", ssh.label)
                tunnel = await self._open(ssh, remote_host, remote_port)
                self._tunnels[key] = tunnel
        netloc = f"127.0.0.1:{tunnel.local_port}"
        if url.username:
            netloc = f"{url.username}{':' + url.password if url.password else ''}@{netloc}"
        return urlunparse(url._replace(netloc=netloc))

    async def _open(self, ssh: SshTarget, remote_host: str, remote_port: int) -> _Tunnel:
        local_port = _free_port()
        forward_host = f"[{remote_host}]" if ":" in remote_host else remote_host
        args = [
            *SSH_COMMAND, "-N",
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=accept-new",
            "-L", f"127.0.0.1:{local_port}:{forward_host}:{remote_port}",
        ]
        if ssh.port:
            args += ["-p", str(ssh.port)]
        if ssh.identity_file:
            args += ["-i", os.path.expanduser(ssh.identity_file)]
        # "--" ends the options: the target can never be an option.
        args += ["--", f"{ssh.user}@{ssh.host}" if ssh.user else ssh.host]

        kwargs: dict[str, Any] = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.PIPE}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            proc = subprocess.Popen(args, **kwargs)
        except OSError as e:
            raise TunnelError(f"Cannot start ssh. Is the OpenSSH client installed? {e}") from e

        loop = asyncio.get_running_loop()
        deadline = loop.time() + OPEN_TIMEOUT
        while True:
            if proc.poll() is not None:
                stderr = (proc.stderr.read() if proc.stderr else b"").decode("utf-8", errors="replace").strip()
                raise TunnelError(f"The SSH tunnel to {ssh.label} failed: {stderr or 'ssh stopped.'}")
            if await asyncio.to_thread(_can_connect, local_port):
                break
            if loop.time() > deadline:
                proc.kill()
                raise TunnelError(f"The SSH tunnel to {ssh.label} was not open after {OPEN_TIMEOUT} seconds.")
            await asyncio.sleep(0.2)
        # A full pipe would block ssh: read and drop its output. A daemon thread never blocks the exit.
        if proc.stderr:
            threading.Thread(target=proc.stderr.read, daemon=True).start()
        log.info("SSH tunnel to %s: 127.0.0.1:%s -> %s:%s", ssh.label, local_port, remote_host, remote_port)
        return _Tunnel(proc, local_port)

    def status(self) -> list[dict[str, Any]]:
        return [
            {"ssh": ssh.label, "remote": f"{host}:{port}", "local_port": t.local_port, "open": t.proc.poll() is None}
            for (ssh, host, port), t in self._tunnels.items()
        ]

    def close_all(self) -> None:
        for tunnel in self._tunnels.values():
            if tunnel.proc.poll() is None:
                tunnel.proc.kill()
                try:
                    tunnel.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        self._tunnels.clear()


TUNNELS = TunnelManager()
