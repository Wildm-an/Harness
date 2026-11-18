"""The updates of the agent programs that the user installed (not a download of Harness, acp_install.py).

Settings > Agents shows the version of the program, the newest version when Harness can know it, and an
"Update" button that runs the own update command of the program in a terminal on the page (the user asked for
ways to update the agents). Harness does not guess a command: only the programs of ``UPDATERS`` get one.

The newest version comes from the npm registry (the package of the program), or from a check command of the
program that installs nothing (``hermes update --check``). The states stay in memory for ``TTL`` seconds.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("harness.agent_updates")

TTL = 6 * 3600  # Seconds: the version check runs again after this time, or with "Check again".
VERSION_TIMEOUT = 15
CHECK_TIMEOUT = 90


@dataclass(frozen=True)
class Updater:
    program: str  # The program on the PATH.
    label: str  # The name of the program: "Hermes Agent".
    update: tuple[str, ...]  # The arguments of the update command.
    version: tuple[str, ...] = ("--version",)
    npm: str | None = None  # The npm package: its "latest" version is the newest version.
    check: tuple[str, ...] | None = None  # A command that prints "... available ... v1.2.3" and installs nothing.


# The agents whose program has its own update command. Claude Agent is not here: Harness downloads, updates, and
# uninstalls its ACP adapter (acp_install.py). Settings > Agents does not show Claude Code (the user asked for this).
UPDATERS: dict[str, Updater] = {
    "hermes": Updater("hermes", "Hermes Agent", ("update",), check=("update", "--check")),
    "opencode": Updater("opencode", "OpenCode", ("upgrade",), npm="opencode-ai"),
    "cursor": Updater("cursor-agent", "Cursor CLI", ("update",)),
    "goose": Updater("goose", "goose", ("update",)),
}

_VERSION = re.compile(r"\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)")
_AVAILABLE = re.compile(r"available\b[^\n]*?\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)", re.IGNORECASE)


def parse_version(text: str) -> str | None:
    """The first version number of the output of ``--version``: "2.1.325 (Claude Code)" -> "2.1.325"."""
    m = _VERSION.search(text or "")
    return m.group(1) if m else None


def parse_available(text: str) -> str | None:
    """The version that a check command says is available, or None: "Selected release available: stable v0.23.2"."""
    m = _AVAILABLE.search(text or "")
    return m.group(1) if m else None


def program_path(harness_id: str) -> str | None:
    """The program of the updater of an agent on this computer, or None."""
    spec = UPDATERS.get(harness_id)
    if spec is None:
        return None
    return shutil.which(spec.program)


def command_text(harness_id: str) -> str:
    spec = UPDATERS[harness_id]
    return " ".join([spec.program, *spec.update])


def update_argv(harness_id: str) -> list[str]:
    """The update command, with the full path of the program. Raises LookupError when it is not installed."""
    spec = UPDATERS.get(harness_id)
    path = program_path(harness_id)
    if spec is None or path is None:
        raise LookupError(f"Harness has no update command for {harness_id}.")
    return [path, *spec.update]


def _run(argv: list[str], timeout: float) -> str:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    done = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, stdin=subprocess.DEVNULL, creationflags=flags)
    return (done.stdout or "") + "\n" + (done.stderr or "")


async def _npm_latest(package: str) -> str | None:
    from .nethttp import async_client

    url = "https://registry.npmjs.org/" + package.replace("/", "%2F") + "/latest"
    async with async_client(timeout=20, follow_redirects=True) as client:
        response = await client.get(url, headers={"Accept": "application/json"})
        if response.status_code >= 400:
            return None
        version = response.json().get("version")
    return version if isinstance(version, str) and version else None


def _is_newer(latest: str | None, current: str | None) -> bool:
    from .acp_install import is_newer

    return is_newer(latest, current)


class ProgramStates:
    """The version state of the programs: {"label", "path", "version", "latest", "update", "command", "checked",
    "error"}. ``cached`` gives the last state (or None), ``check`` reads it again when it is old."""

    def __init__(self) -> None:
        self._states: dict[str, dict[str, Any]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def cached(self, harness_id: str) -> dict[str, Any] | None:
        if harness_id not in UPDATERS:
            return None
        state = self._states.get(harness_id)
        path = program_path(harness_id)
        if path is None:
            return None  # Not installed: no update.
        if state is None or state.get("path") != path:
            spec = UPDATERS[harness_id]
            return {"label": spec.label, "path": path, "version": None, "latest": None, "update": False,
                    "command": command_text(harness_id), "checked": None, "error": None}
        return state

    def fresh(self, harness_id: str) -> bool:
        state = self._states.get(harness_id)
        return bool(state) and state.get("path") == program_path(harness_id) \
            and time.time() - (state.get("checked") or 0) < TTL

    def invalidate(self, harness_id: str) -> None:
        self._states.pop(harness_id, None)

    async def check(self, harness_id: str, force: bool = False) -> dict[str, Any] | None:
        spec = UPDATERS.get(harness_id)
        if spec is None:
            return None
        lock = self._locks.setdefault(harness_id, asyncio.Lock())
        async with lock:
            if not force and self.fresh(harness_id):
                return self._states[harness_id]
            path = await asyncio.to_thread(program_path, harness_id)
            if path is None:
                self._states.pop(harness_id, None)
                return None
            state: dict[str, Any] = {"label": spec.label, "path": path, "version": None, "latest": None,
                                     "update": False, "command": command_text(harness_id),
                                     "checked": int(time.time()), "error": None}
            try:
                out = await asyncio.to_thread(_run, [path, *spec.version], VERSION_TIMEOUT)
                state["version"] = parse_version(out)
                if spec.npm:
                    state["latest"] = await _npm_latest(spec.npm)
                elif spec.check:
                    out = await asyncio.to_thread(_run, [path, *spec.check], CHECK_TIMEOUT)
                    # No "available" line: the program has the newest version.
                    state["latest"] = parse_available(out) or state["version"]
            except Exception as e:  # noqa: BLE001 - no network, a timeout, or a program that failed.
                log.info("The version check of %s failed: %s", harness_id, e)
                state["error"] = f"Could not check the version: {type(e).__name__}"
            state["update"] = _is_newer(state["latest"], state["version"])
            self._states[harness_id] = state
            return state


STATES = ProgramStates()
