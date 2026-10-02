"""The update of a remote daemon from the desktop app ("Update daemon").

The app has a wheel of the daemon of its own version. It sends the wheel over the connection.
The daemon installs it with pip into its own Python, then starts a new daemon process with the
same arguments and stops. The new process waits until the port is free. The token stays the same,
so the app connects again by itself.

Only a daemon that the user started with Python can update this way. The daemon of the desktop app
(the PyInstaller sidecar) updates with the app.
"""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from . import frozen
from .config import harness_home

WHEEL_NAME = re.compile(r"^harness_daemon-[0-9][\w.+]*-py3-none-any\.whl$")
PIP_TIMEOUT = 600  # Seconds. pip can download new dependencies.
WAIT_PID_ENV = "HARNESS_WAIT_PID"  # The new process waits for the port of this old process.
PLUGIN_HOST_FILE = "plugin-host-path"  # The plugin host folder of a source install, for after the update.

# The arguments of the daemon. None: this daemon cannot update itself.
_argv: list[str] | None = None


def enable(argv: list[str], sidecar: bool) -> None:
    """Called by main. The sidecar of the desktop app and a frozen daemon cannot update."""
    global _argv
    _argv = None if sidecar or frozen.is_frozen() else [a for a in argv if a != "--new-token"]


def refusal() -> str | None:
    """Why this daemon cannot update itself, or None."""
    if frozen.is_frozen():
        return "This daemon is part of the desktop app. It updates with the app."
    if _argv is None:
        return "This daemon cannot update itself. Start it with Python (python -m harness_daemon) to use the update."
    return None


def plugin_host_hint() -> Path:
    return harness_home() / PLUGIN_HOST_FILE


async def install(filename: str, data: bytes) -> None:
    """Install the wheel with pip. Raises RuntimeError with the end of the pip output on an error."""
    if not WHEEL_NAME.match(filename):
        raise RuntimeError(f"Not a wheel of the daemon: {filename}")
    # A source install finds the DeepSeek plugin host in the repository. After a wheel install the
    # daemon is in site-packages, so keep the folder for dsh.host_dir.
    from .plugins.dsh import host_dir

    found = host_dir()
    if found is not None:
        plugin_host_hint().parent.mkdir(parents=True, exist_ok=True)
        plugin_host_hint().write_text(str(found), encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="harness-update-") as folder:
        wheel = Path(folder) / filename
        wheel.write_bytes(data)
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check", str(wheel),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            **kwargs,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), PIP_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError("pip did not finish in 10 minutes.") from None
    if proc.returncode != 0:
        tail = "\n".join(out.decode("utf-8", "replace").strip().splitlines()[-8:])
        raise RuntimeError(f"pip could not install the update:\n{tail}")


def restart() -> None:
    """Start a new daemon with the same arguments, then stop this process."""
    assert _argv is not None
    env = {**os.environ, WAIT_PID_ENV: str(os.getpid())}
    kwargs: dict = {"env": env, "stdin": subprocess.DEVNULL}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([sys.executable, "-m", "harness_daemon", *_argv], **kwargs)  # noqa: S603 - our own command.
    from .__main__ import _hard_exit

    _hard_exit()
