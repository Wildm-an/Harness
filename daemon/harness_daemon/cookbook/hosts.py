"""Cookbook hosts: the daemon computer ("local"), and remote computers through SSH (SPEC.md section 7.6).

Remote hosts are in ``~/.harness/hosts.json``::

    { "gpu-box": { "ssh": "drew@gpu-box", "python": "python3", "llama_server": "~/llama.cpp/build/bin/llama-server" } }

The "local" entry can set "llama_server" for the daemon computer.

The daemon runs hostscript.py on the host: ``python -`` locally, or ``ssh <host> python3 -``.
SSH uses the key in ``~/.harness/ssh/id_ed25519``. The Cookbook shows its public key: the user
adds it to ``~/.ssh/authorized_keys`` on the remote host.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..config import ConfigError, harness_home, read_json, write_json
from ..tunnels import SshTarget, parse_ssh
from .. import tunnels

LOCAL = "local"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$")
SCRIPT = Path(__file__).with_name("hostscript.py")
SCRIPT_TIMEOUT = 60


class HostError(Exception):
    pass


def hosts_path() -> Path:
    return harness_home() / "hosts.json"


def key_path() -> Path:
    return harness_home() / "ssh" / "id_ed25519"


def public_key(create: bool = False) -> str | None:
    """The public key of the harness. With ``create``, make the key pair first if it does not exist."""
    key = key_path()
    if not key.exists():
        if not create:
            return None
        key.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "harness", "-f", str(key), "-q"],
                           check=True, capture_output=True, timeout=30,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.SubprocessError) as e:
            raise HostError(f"ssh-keygen failed. Is the OpenSSH client installed? {e}") from e
    return key.with_suffix(".pub").read_text(encoding="utf-8").strip()


@dataclass
class Host:
    name: str
    ssh: SshTarget | None = None
    python: str = ""
    llama_server: str | None = None

    @property
    def remote(self) -> bool:
        return self.ssh is not None

    @property
    def label(self) -> str:
        return f"{self.name} ({self.ssh.label})" if self.ssh else "This computer (the daemon host)"

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "ssh": self.ssh.label if self.ssh else None, "remote": self.remote,
                "python": self.python, "llama_server": self.llama_server, "label": self.label}

    def argv(self) -> list[str]:
        """The command that runs a Python script from stdin on the host."""
        if self.ssh is None:
            return [self.python or sys.executable, "-"]
        args = [*tunnels.SSH_COMMAND, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                "-o", "StrictHostKeyChecking=accept-new"]
        if self.ssh.port:
            args += ["-p", str(self.ssh.port)]
        identity = self.ssh.identity_file or (str(key_path()) if key_path().exists() else None)
        if identity:
            args += ["-i", os.path.expanduser(identity)]
        target = f"{self.ssh.user}@{self.ssh.host}" if self.ssh.user else self.ssh.host
        return [*args, "--", target, self.python or "python3", "-"]


def load_hosts() -> dict[str, Host]:
    data = read_json(hosts_path(), {})
    if not isinstance(data, dict):
        raise ConfigError("hosts.json must be an object that maps host names to settings.")
    local = data.get(LOCAL) if isinstance(data.get(LOCAL), dict) else {}
    hosts = {LOCAL: Host(LOCAL, None, str(local.get("python") or ""), local.get("llama_server"))}
    for name, entry in data.items():
        if name == LOCAL or not isinstance(entry, dict):
            continue
        try:
            target = parse_ssh(entry.get("ssh"))
        except ValueError as e:
            raise ConfigError(f"hosts.json: host {name}: {e}") from e
        if target is None:
            continue
        hosts[name] = Host(name, target, str(entry.get("python") or "python3"), entry.get("llama_server"))
    return hosts


def get_host(name: str | None) -> Host:
    hosts = load_hosts()
    host = hosts.get(name or LOCAL)
    if host is None:
        raise HostError(f"Unknown host: {name}. The hosts are: {', '.join(hosts)}.")
    return host


def save_host(name: str, ssh: str | None, python: str | None, llama_server: str | None,
              previous: str | None = None) -> None:
    if not NAME_RE.match(name):
        raise HostError("The host name must have only letters, digits, '.', '_', or '-'.")
    data = read_json(hosts_path(), {})
    if not isinstance(data, dict):
        data = {}
    if previous and previous != name:
        data.pop(previous, None)
    if name in data and name != previous and previous is not None:
        raise HostError(f"A host with the name {name} exists.")
    entry: dict[str, Any] = {}
    if name != LOCAL:
        try:
            if parse_ssh(ssh) is None:
                raise HostError("Give the SSH address of the host, for example drew@gpu-box.")
        except ValueError as e:
            raise HostError(str(e)) from None
        entry["ssh"] = str(ssh).strip()
        if python and python.strip():
            entry["python"] = python.strip()
    if llama_server and llama_server.strip():
        entry["llama_server"] = llama_server.strip()
    data[name] = entry
    write_json(hosts_path(), data)


def delete_host(name: str) -> None:
    if name == LOCAL:
        raise HostError("The local host cannot be deleted.")
    data = read_json(hosts_path(), {})
    if isinstance(data, dict) and data.pop(name, None) is not None:
        write_json(hosts_path(), data)


# -- the host script -----------------------------------------------------------------------------------


@dataclass
class ScriptRun:
    """One run of the host script. ``kill`` stops it (for a download pause or cancel)."""

    proc: subprocess.Popen
    done: asyncio.Future
    killed: bool = False
    stderr: list[str] = field(default_factory=list)

    def kill(self) -> None:
        self.killed = True
        if self.proc.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"], capture_output=True,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            else:
                self.proc.kill()


def script_text(command: str, args: dict[str, Any]) -> str:
    header = f"COMMAND = {json.dumps(command)}\nARGS = json.loads({json.dumps(json.dumps(args))})\n"
    return "import json\n" + header + SCRIPT.read_text(encoding="utf-8")


def start_script(host: Host, command: str, args: dict[str, Any],
                 on_event: Callable[[dict[str, Any]], None] | None = None) -> ScriptRun:
    """Start the host script. ``on_event`` gets each event line in the event loop."""
    loop = asyncio.get_running_loop()
    done: asyncio.Future = loop.create_future()
    kwargs: dict[str, Any] = {"stdin": subprocess.PIPE, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    kwargs["env"] = env
    try:
        proc = subprocess.Popen(host.argv(), **kwargs)
    except OSError as e:
        what = "ssh" if host.remote else "Python"
        raise HostError(f"Cannot start {what} for the host {host.name}: {e}") from e
    run = ScriptRun(proc, done)
    text = script_text(command, {**args, "llama_server": host.llama_server})

    def finish(result: Any, error: str | None) -> None:
        if done.done():
            return
        if error is not None:
            done.set_exception(HostError(error))
        else:
            done.set_result(result)

    def read() -> None:  # A thread: the event loop can be a selector loop with no subprocess support.
        try:
            proc.stdin.write(text.encode("utf-8"))
            proc.stdin.close()
        except OSError:
            pass
        result: Any = None
        error: str | None = None
        got_last = False
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if "event" in obj and on_event is not None:
                loop.call_soon_threadsafe(on_event, obj)
            elif "result" in obj:
                result, got_last = obj["result"], True
            elif "error" in obj:
                error, got_last = str(obj["error"]), True
        proc.wait()
        stderr = proc.stderr.read().decode("utf-8", errors="replace").strip() if proc.stderr else ""
        if not got_last and error is None:
            if run.killed:
                error = "stopped"
            else:
                detail = stderr.splitlines()[-1] if stderr else f"exit code {proc.returncode}"
                where = f"through SSH ({host.ssh.label})" if host.ssh else "on this computer"
                error = f"The host script failed {where}: {detail}"
        loop.call_soon_threadsafe(finish, result, error)

    threading.Thread(target=read, daemon=True).start()
    return run


async def run_script(host: Host, command: str, args: dict[str, Any] | None = None,
                     timeout: float = SCRIPT_TIMEOUT) -> Any:
    """Run a short host script command and return its result."""
    run = start_script(host, command, args or {})
    try:
        return await asyncio.wait_for(asyncio.shield(run.done), timeout)
    except asyncio.TimeoutError:
        run.kill()
        raise HostError(f"The host {host.name} did not answer in {timeout:g} seconds.") from None
