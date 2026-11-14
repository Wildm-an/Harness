"""Shell detection and command execution with a timeout."""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ShellInfo:
    name: str
    argv: tuple[str, ...]  # The command goes after these arguments.


def _shell_for(path: str) -> ShellInfo:
    stem = Path(path).stem.lower()
    if stem in ("powershell", "pwsh"):
        return ShellInfo(stem, (path, "-NoProfile", "-NonInteractive", "-Command"))
    if stem == "cmd":
        return ShellInfo("cmd", (path, "/d", "/s", "/c"))
    return ShellInfo(stem, (path, "-c"))


def detect_shell(preferred: str | None = None) -> ShellInfo:
    if preferred:
        return _shell_for(preferred)
    if os.name == "nt":
        candidates = []
        for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramW6432"), r"C:\Program Files"):
            if base:
                candidates.append(os.path.join(base, "Git", "bin", "bash.exe"))
        found = shutil.which("bash")
        # C:\Windows\System32\bash.exe starts WSL, not Git Bash. Do not use it.
        if found and "system32" not in found.lower():
            candidates.append(found)
        for c in candidates:
            if os.path.isfile(c):
                return ShellInfo("bash", (c, "-c"))
        return _shell_for("powershell.exe")
    if os.path.exists("/bin/bash"):
        return ShellInfo("bash", ("/bin/bash", "-c"))
    return ShellInfo("sh", ("/bin/sh", "-c"))


def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    try:
        proc.kill()
    except OSError:
        pass


def shell_argv(shell: ShellInfo, command: str) -> list[str]:
    """The process arguments that run ``command`` in ``shell``.

    All places that start a shell command use it (bash, tasks, servers, hooks, ACP terminals). A sandbox
    can later wrap the command at this one point.
    """
    return [*shell.argv, command]


def command_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """The environment of a command that the agent chooses (bash, background tasks, ACP terminals).

    A copy of the daemon environment, with no pager: a pager waits for input that never comes. ``extra``
    comes last. The secret scrub of the plan (change 9) goes here.
    """
    env = dict(os.environ)
    env.setdefault("PAGER", "cat")
    env.setdefault("GIT_PAGER", "cat")
    # Python writes UTF-8, as the output is read: else Windows Python writes the code page, and
    # a script that prints a character outside it (for example "→") fails.
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if extra:
        env.update(extra)
    return env


@dataclass
class CommandResult:
    output: str
    returncode: int | None
    timed_out: bool


async def run_command(command: str, cwd: Path, shell: ShellInfo, timeout: float,
                      env: dict[str, str] | None = None) -> CommandResult:
    """Run ``command`` in ``shell``. Stdout and stderr go to one stream.

    ``env``: the environment of the process. Default: command_env().
    On a timeout or a cancel, the process and all its children stop.
    """
    env = env if env is not None else command_env()
    kwargs: dict = {
        "cwd": str(cwd),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "env": env,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    else:
        kwargs["start_new_session"] = True

    proc = subprocess.Popen(shell_argv(shell, command), **kwargs)
    reader = asyncio.ensure_future(asyncio.to_thread(proc.communicate))
    try:
        out, _ = await asyncio.wait_for(asyncio.shield(reader), timeout)
        return CommandResult(_decode(out), proc.returncode, False)
    except asyncio.TimeoutError:
        await asyncio.to_thread(_kill_tree, proc)
        out, _ = await reader
        return CommandResult(_decode(out), proc.returncode, True)
    except asyncio.CancelledError:
        # taskkill can take a moment. Do not block the event loop while it runs.
        await asyncio.to_thread(_kill_tree, proc)
        raise


def _decode(data: bytes | None) -> str:
    if not data:
        return ""
    return data.decode("utf-8", errors="replace").replace("\r\n", "\n")
