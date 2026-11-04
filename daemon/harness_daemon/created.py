"""The new files of a tool call that the Preview pane can show (PDF and Word files).

The client shows a card for each one in the chat, with an "Open" button (client ``FileCard.tsx``).
The daemon sends them as ``created`` in the ``tool.result`` event, and keeps them in the stored
tool message, so the card also shows when the user opens the session again.

- A tool that names a ``path`` (``write``, ``office_edit``): the file is new when it did not exist
  before the call and the tool changed it.
- ``bash``: a scan of the project folder before and after the command. The scan skips large
  folders such as ``node_modules`` and stops after a time and file limit: then it finds nothing.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .files import is_within, relpath
from .tools.document import PREVIEW_SUFFIXES

# Folders that hold no files for the user to look at, or too many files to scan.
SKIP_DIRS = {"node_modules", "__pycache__", "venv", "env", "target", "dist-electron", "site-packages"}
MAX_ENTRIES = 20_000  # The scan stops after this number of folder entries.
SCAN_SECONDS = 0.5  # The scan stops after this time.
MAX_CREATED = 10  # At most this number of cards for one tool call.


def _is_preview(name: str) -> bool:
    return name.lower().endswith(PREVIEW_SUFFIXES)


def scan_preview_files(root: Path, max_entries: int = MAX_ENTRIES, seconds: float = SCAN_SECONDS) -> set[str] | None:
    """The PDF and Word files under ``root``, as relative paths. None when the scan stops early.

    The scan skips hidden folders (``.git``, ``.venv``, ``.harness``) and the folders in SKIP_DIRS.
    """
    found: set[str] = set()
    deadline = time.monotonic() + seconds
    entries = 0
    stack = [Path(root)]
    while stack:
        folder = stack.pop()
        try:
            with os.scandir(folder) as it:
                for entry in it:
                    entries += 1
                    if entries > max_entries or time.monotonic() > deadline:
                        return None
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if not entry.name.startswith(".") and entry.name not in SKIP_DIRS:
                                stack.append(Path(entry.path))
                        elif _is_preview(entry.name) and entry.is_file():
                            found.add(Path(entry.path).relative_to(root).as_posix())
                    except OSError:
                        continue
        except OSError:
            continue
    return found


@dataclass
class Snapshot:
    """The state before a tool call: the named file existed or not, and the scan for bash."""

    named: Path | None = None
    named_existed: bool = True
    scan: set[str] | None = None


def _named_path(cwd: Path, args: dict[str, Any] | None) -> Path | None:
    raw = (args or {}).get("path")
    if not isinstance(raw, str) or not raw.strip() or not _is_preview(raw.strip()):
        return None
    path = Path(raw.strip())
    if not path.is_absolute():
        path = Path(cwd) / path
    try:
        path = path.resolve()
    except OSError:
        return None
    return path if is_within(path, Path(cwd).resolve()) else None


def before_call(cwd: Path, name: str, args: dict[str, Any] | None) -> Snapshot:
    """Take the snapshot before a tool call. It is cheap for all tools except bash."""
    snap = Snapshot()
    named = _named_path(cwd, args)
    if named is not None:
        snap.named = named
        snap.named_existed = named.exists()
    if name == "bash" and isinstance(args, dict) and args.get("run_in_background") is not True:
        snap.scan = scan_preview_files(Path(cwd).resolve())
    return snap


def created_files(cwd: Path, snap: Snapshot, changed_paths: list[Path]) -> list[str]:
    """The new PDF and Word files of the call, as paths relative to ``cwd``, in a stable order."""
    root = Path(cwd).resolve()
    created: list[str] = []
    if snap.named is not None and not snap.named_existed and snap.named.is_file():
        if any(Path(p).resolve() == snap.named for p in changed_paths):
            created.append(relpath(root, snap.named))
    if snap.scan is not None:
        after = scan_preview_files(root)
        if after is not None:
            created.extend(sorted(after - snap.scan))
    return list(dict.fromkeys(created))[:MAX_CREATED]
