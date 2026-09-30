"""File search helpers for the glob and grep tools.

The tools use ripgrep (``rg``) if it is available, because ripgrep applies the
``.gitignore`` files and is fast. Otherwise they use a Python search that skips
common generated folders.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from functools import lru_cache
from pathlib import Path
from typing import Iterator

from .base import ToolError

# Folders that the Python search never enters.
SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".tox", "dist", "build", "target", ".next", ".cache", ".idea",
}

# Seconds for one search. After this time, the tool gives an error result to the model.
SEARCH_TIMEOUT = 30
TIMEOUT_MESSAGE = (
    "The search stopped after {seconds} seconds. The folder has too many files. "
    "Use a narrower path or pattern."
)


def find_ripgrep(configured: str | None = None) -> str | None:
    if configured:
        return configured if Path(configured).is_file() else shutil.which(configured)
    return shutil.which("rg")


def run_ripgrep(rg: str, args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    """Run ripgrep. Raise ToolError if it does not complete in SEARCH_TIMEOUT seconds."""
    try:
        return subprocess.run(
            [rg, *args],
            cwd=str(cwd),
            capture_output=True,
            timeout=SEARCH_TIMEOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        raise ToolError(TIMEOUT_MESSAGE.format(seconds=SEARCH_TIMEOUT)) from None


def walk_files(root: Path, timeout: float = SEARCH_TIMEOUT) -> Iterator[Path]:
    """Yield the files under ``root``. Skip the folders in SKIP_DIRS.

    Raise ToolError if the walk takes more than ``timeout`` seconds.
    """
    if root.is_file():
        yield root
        return
    deadline = time.monotonic() + timeout
    for folder, dirs, files in os.walk(root):
        if time.monotonic() >= deadline:
            raise ToolError(TIMEOUT_MESSAGE.format(seconds=timeout))
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            yield Path(folder) / name


@lru_cache(maxsize=256)
def glob_regex(pattern: str) -> re.Pattern[str]:
    """Convert a glob to a regex. "*" and "?" do not match "/". "**/" matches zero or more folders."""
    out = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "[":
            end = pattern.find("]", i + 1)
            if end == -1:
                out.append(re.escape(c))
                i += 1
            else:
                body = pattern[i + 1:end]
                if body.startswith("!"):
                    body = "^" + body[1:]
                out.append(f"[{body}]")
                i = end + 1
        elif c == "{":
            end = pattern.find("}", i + 1)
            if end == -1:
                out.append(re.escape(c))
                i += 1
            else:
                options = pattern[i + 1:end].split(",")
                out.append("(?:" + "|".join(re.escape(o) for o in options) + ")")
                i = end + 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("".join(out) + r"\Z")


def glob_match(rel_path: str, pattern: str) -> bool:
    """Match a relative path with gitignore-style rules. A pattern with no "/" matches the name at any depth."""
    pattern = pattern.strip()
    if pattern.startswith("./"):
        pattern = pattern[2:]
    if "/" not in pattern:
        return glob_regex(pattern).match(rel_path.rsplit("/", 1)[-1]) is not None
    return glob_regex(pattern.lstrip("/")).match(rel_path) is not None


# The "@" menu of the prompt box looks at this many paths, at most.
MAX_FIND_SCAN = 20_000


def _subsequence(query: str, text: str) -> bool:
    it = iter(text)
    return all(c in it for c in query)


def find_paths(root: Path, query: str, limit: int = 40) -> list[str]:
    """Project paths for the "@" menu: files, and folders with a "/" at the end. Best match first.

    The order: the name starts with the query, the name has the query, the path has the query,
    then the letters of the query in order (for example "sapp" for "src/app.py"). No case.
    """
    q = query.strip().lower().replace("\\", "/")
    found: list[tuple[int, int, str]] = []
    scanned = 0
    for folder, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        rel_folder = os.path.relpath(folder, root).replace("\\", "/")
        prefix = "" if rel_folder == "." else rel_folder + "/"
        for name, is_dir in [(d, True) for d in dirs] + [(f, False) for f in sorted(files)]:
            scanned += 1
            if scanned > MAX_FIND_SCAN:
                break
            path = prefix + name + ("/" if is_dir else "")
            lower_name, lower_path = name.lower(), path.lower()
            if not q:
                rank = 0
            elif lower_name.startswith(q):
                rank = 0
            elif q in lower_name:
                rank = 1
            elif q in lower_path:
                rank = 2
            elif _subsequence(q, lower_path):
                rank = 3
            else:
                continue
            found.append((rank, path.count("/") - (1 if is_dir else 0), path))
        if scanned > MAX_FIND_SCAN:
            break
    found.sort(key=lambda f: (f[0], f[1], len(f[2]), f[2]))
    return [path for _rank, _depth, path in found[:limit]]
