"""The name of the operating system, for the client and for the system prompt of the agent."""

from __future__ import annotations

import platform

# Windows 11 keeps the version number 10.0. Its builds start at 22000.
WINDOWS_11_BUILD = 22000


def os_name(system: str | None = None, release: str | None = None, version: str | None = None) -> str:
    """For example "Windows 11" or "Linux 6.8.0".

    Python 3.11 gives the release "10" on Windows 11 (Python 3.12 gives "11"). The build number
    in ``platform.version()`` (for example "10.0.26300") tells the two apart.
    """
    system = platform.system() if system is None else system
    release = platform.release() if release is None else release
    if system == "Windows" and release == "10":
        version = platform.version() if version is None else version
        parts = version.split(".")
        if len(parts) >= 3 and parts[2].isdigit() and int(parts[2]) >= WINDOWS_11_BUILD:
            release = "11"
    return f"{system} {release}"
