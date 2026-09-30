"""Keep the computer awake while the agent works, as the "Keep computer awake" switch of Claude.

The switch is for one session, and only while the daemon keeps that session open. The computer
stays awake while a session with the switch on has a running turn or a running background task.
The display can still turn off. This computer is the computer of the daemon, which runs the agent.

- Windows: SetThreadExecutionState. The daemon calls it on the thread of its event loop, which
  runs as long as the daemon.
- macOS: ``caffeinate -i``. Linux: ``systemd-inhibit``, if it is there.
"""

from __future__ import annotations

import atexit
import logging
import os
import shutil
import subprocess
import sys
from typing import Any

log = logging.getLogger("harness.keepawake")

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001


class KeepAwake:
    def __init__(self) -> None:
        self._holders: set[int] = set()  # The ids of the sessions that need the computer awake now.
        self._proc: subprocess.Popen | None = None
        self.active = False

    def hold(self, holder: Any, on: bool) -> None:
        """``holder`` (a live session) needs the computer awake, or does not need it any more."""
        if on:
            self._holders.add(id(holder))
        else:
            self._holders.discard(id(holder))
        self._apply(bool(self._holders))

    def _apply(self, on: bool) -> None:
        if on == self.active:
            return
        self.active = on
        try:
            if os.name == "nt":
                import ctypes

                flags = ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0)
                ctypes.windll.kernel32.SetThreadExecutionState(flags)  # type: ignore[attr-defined]
            elif on:
                argv = self._inhibit_command()
                if argv:
                    self._proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                                  stderr=subprocess.DEVNULL)
            elif self._proc is not None:
                self._proc.terminate()
                self._proc = None
        except Exception:  # noqa: BLE001 - the switch must not break a turn.
            log.warning("The computer cannot stay awake", exc_info=True)
        log.info("Keep the computer awake: %s", "on" if on else "off")

    @staticmethod
    def _inhibit_command() -> list[str] | None:
        pid = str(os.getpid())
        if sys.platform == "darwin" and shutil.which("caffeinate"):
            return ["caffeinate", "-i", "-w", pid]  # It ends with the daemon.
        if shutil.which("systemd-inhibit"):
            return ["systemd-inhibit", "--what=sleep:idle", "--who=Harness", "--why=The agent works",
                    "--mode=block", "sleep", "infinity"]
        return None


AWAKE = KeepAwake()
atexit.register(lambda: AWAKE._apply(False))  # Do not keep an inhibit process after the daemon.
