"""File helpers shared by the tools and the editor protocol."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path


class PathError(Exception):
    pass


def is_within(child: Path, root: Path) -> bool:
    c = os.path.normcase(str(child))
    r = os.path.normcase(str(root))
    try:
        return os.path.commonpath([c, r]) == r
    except ValueError:  # Different drives on Windows.
        return False


def resolve_in_cwd(cwd: Path, path: str, extra_roots: tuple[Path, ...] = ()) -> Path:
    """Resolve ``path`` against ``cwd``. Reject a path outside ``cwd`` and ``extra_roots``.

    ``resolve()`` follows symbolic links, so a link that points outside the
    project is also rejected.
    """
    if not isinstance(path, str) or not path.strip():
        raise PathError("The path is empty.")
    root = Path(cwd).resolve()
    p = Path(path.strip())
    if not p.is_absolute():
        p = root / p
    resolved = p.resolve()
    if not is_within(resolved, root) and not any(is_within(resolved, Path(r).resolve()) for r in extra_roots):
        raise PathError(f"The path is outside the project folder: {path}")
    return resolved


def relpath(cwd: Path, path: Path) -> str:
    try:
        return Path(path).resolve().relative_to(Path(cwd).resolve()).as_posix()
    except ValueError:
        return Path(path).as_posix()


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_hash(path: Path) -> str | None:
    try:
        return hash_bytes(Path(path).read_bytes())
    except FileNotFoundError:
        return None


def is_binary(data: bytes) -> bool:
    return b"\0" in data[:8192]
