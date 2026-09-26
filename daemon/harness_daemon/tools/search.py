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
from functools import lru_cache
from pathlib import Path
from typing import Iterator

# Folders that the Python search never enters.
SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".tox", "dist", "build", "target", ".next", ".cache", ".idea",
}

RG_TIMEOUT = 30


def find_ripgrep(configured: str | None = None) -> str | None:
    if configured:
        return configured if Path(configured).is_file() else shutil.which(configured)
    return shutil.which("rg")


def run_ripgrep(rg: str, args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [rg, *args],
        cwd=str(cwd),
        capture_output=True,
        timeout=RG_TIMEOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def walk_files(root: Path) -> Iterator[Path]:
    """Yield the files under ``root``. Skip the folders in SKIP_DIRS."""
    if root.is_file():
        yield root
        return
    for folder, dirs, files in os.walk(root):
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
