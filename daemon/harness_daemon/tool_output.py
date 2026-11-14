"""The full output of a tool result that the output limit cut, in a file that the agent can read.

The cut note names the file. The agent then reads the part that it needs with read (offset and limit) or
grep, in place of a second run of the command. The files are in the folder of the project, next to its memory
(~/.harness/projects/<project>/<session>/tool-results/), outside the project folder: git and the file tree do
not see them. A session delete removes them. The hourly check removes old files.
"""

from __future__ import annotations

import logging
import os
import shutil
import time
import uuid
from pathlib import Path

from .config import harness_home
from .memory import memory_dir

log = logging.getLogger(__name__)

MAX_FILE_BYTES = 10_000_000  # A longer output keeps its first 10 MB in the file.
MAX_SESSION_BYTES = 200_000_000  # The oldest files of a session go first.
MAX_AGE_DAYS = 30
FOLDER = "tool-results"


def session_output_dir(cwd: Path, session_id: str) -> Path:
    return memory_dir(cwd).parent / session_id / FOLDER


def spill(folder: Path | None, text: str) -> Path | None:
    """Write the full text to a new file in ``folder``. None: no folder, or the write failed."""
    if folder is None:
        return None
    try:
        folder.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(folder, 0o700)  # The output can hold secrets that a command printed.
        path = folder / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.txt"
        data = text.encode("utf-8", errors="replace")[:MAX_FILE_BYTES]
        path.write_bytes(data)
        _limit_session(folder)
        return path
    except OSError:
        log.exception("The full tool output could not be saved")
        return None


def _limit_session(folder: Path) -> None:
    files = sorted(folder.glob("*.txt"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    for path in files[:-1]:  # Keep the newest file.
        if total <= MAX_SESSION_BYTES:
            break
        total -= path.stat().st_size
        path.unlink(missing_ok=True)


def remove_session_outputs(cwd: Path, session_id: str) -> None:
    shutil.rmtree(session_output_dir(cwd, session_id).parent, ignore_errors=True)


def prune_outputs(now: float | None = None) -> int:
    """Remove the output files older than MAX_AGE_DAYS, in all projects. Return the number of files."""
    cutoff = (time.time() if now is None else now) - MAX_AGE_DAYS * 86400
    removed = 0
    for path in (harness_home() / "projects").glob(f"*/*/{FOLDER}/*.txt"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed
