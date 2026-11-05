"""Settings > General > Storage: the disk space that Harness uses on the daemon computer.

The client shows the categories as the Storage dialog of Claude does. The desktop app adds its own
folders (the app, the webview data, the Browser pane profile). Nothing here deletes a file.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

from .config import harness_home
from .frozen import playwright_cache
from .memory import project_root
from .storage import Storage, path_key

STALE_DAYS = 30
LARGEST = 5  # The Details of the sessions list this many of the largest sessions.
MODEL_SUFFIXES = (".gguf", ".safetensors")
DB_FILES = ("harness.db", "harness.db-wal", "harness.db-shm", "harness.db-journal")
LOGS = "logs"
BROWSER_PROFILE = "chrome-automation"  # The Chrome profile of the browser connector.


def folder_size(path: Path) -> int:
    """The size of the files in a folder and its subfolders. A link is not followed."""
    total = 0
    stack = [str(path)]
    while stack:
        try:
            entries = os.scandir(stack.pop())
        except OSError:
            continue
        with entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        stack.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
    return total


def file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def browsers_dir() -> Path:
    """The Chromium of the browser tools (Playwright)."""
    value = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    return Path(value) if value and value != "0" else Path(playwright_cache())


def hf_cache_dir() -> Path:
    try:
        from huggingface_hub import constants
        return Path(constants.HF_HUB_CACHE)
    except ImportError:
        home = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
        return Path(home) / "hub"


def _sessions(storage: Storage, now: float) -> dict[str, Any]:
    stale_after = now - STALE_DAYS * 86400
    sizes: dict[str, int] = {}
    for session_id, size in storage.db.execute("SELECT session_id, SUM(LENGTH(data)) FROM messages GROUP BY session_id"):
        sizes[session_id] = size or 0
    for session_id, size in storage.db.execute(
            "SELECT session_id, SUM(COALESCE(LENGTH(content), 0)) FROM checkpoints GROUP BY session_id"):
        sizes[session_id] = sizes.get(session_id, 0) + (size or 0)
    rows = storage.db.execute("SELECT id, cwd, title, updated_at FROM sessions").fetchall()
    stale = [r for r in rows if r["updated_at"] < stale_after]
    folders: dict[str, Path] = {}
    for p in storage.list_projects():
        folders[path_key(p["path"])] = Path(p["path"])
    for r in rows:
        root = project_root(Path(r["cwd"]))
        folders.setdefault(path_key(str(root)), root)
    worktrees = []
    for folder in folders.values():
        base = folder / ".harness" / "worktrees"
        try:
            children = [c for c in base.iterdir() if c.is_dir()]
        except OSError:
            continue
        for child in children:
            worktrees.append({"name": child.name, "project": folder.name, "path": str(child), "size": folder_size(child)})
    worktrees.sort(key=lambda w: -w["size"])
    db = sum(file_size(harness_home() / name) for name in DB_FILES)
    largest = sorted(rows, key=lambda r: -sizes.get(r["id"], 0))[:LARGEST]
    return {
        "size": db + sum(w["size"] for w in worktrees),
        "database": db,
        "count": len(rows),
        "stale_count": len(stale),
        "stale_size": sum(sizes.get(r["id"], 0) for r in stale),
        "worktrees": worktrees,
        "largest": [{"title": r["title"] or "Untitled session", "project": Path(r["cwd"]).name, "size": sizes.get(r["id"], 0),
                     "updated_at": r["updated_at"]} for r in largest if sizes.get(r["id"], 0) > 0],
    }


def _models() -> dict[str, Any]:
    """The model files in the Hugging Face cache (Settings > Local Models downloads them there)."""
    root = hf_cache_dir()
    items = []
    try:
        folders = sorted(f for f in root.iterdir() if f.name.startswith("models--"))
    except OSError:
        folders = []
    for folder in folders:
        size = 0
        for dirpath, _dirs, names in os.walk(folder / "snapshots"):
            for name in names:
                if name.endswith(MODEL_SUFFIXES):
                    try:
                        size += os.path.getsize(os.path.join(dirpath, name))  # The blob of a link.
                    except OSError:
                        pass
        if size:
            items.append({"name": folder.name[len("models--"):].replace("--", "/"), "size": size})
    items.sort(key=lambda i: -i["size"])
    return {"size": sum(i["size"] for i in items), "path": str(root), "items": items}


def _runtime() -> dict[str, Any]:
    root = browsers_dir()
    items = []
    try:
        folders = [f for f in root.iterdir() if f.is_dir() and not f.name.startswith(".")]
    except OSError:
        folders = []
    for folder in folders:
        items.append({"name": folder.name, "path": str(folder), "size": folder_size(folder)})
    items.sort(key=lambda i: -i["size"])
    return {"size": sum(i["size"] for i in items), "path": str(root), "items": items}


def _home_parts() -> tuple[dict[str, Any], dict[str, Any]]:
    """The memory and settings (all of ~/.harness but the database, the logs, and the browser
    profile), and the logs with the browser profile."""
    home = harness_home()
    memory: list[dict[str, Any]] = []
    caches: list[dict[str, Any]] = []
    try:
        entries = sorted(home.iterdir())
    except OSError:
        entries = []
    for entry in entries:
        if entry.name in DB_FILES:
            continue
        size = folder_size(entry) if entry.is_dir() else file_size(entry)
        item = {"name": entry.name, "path": str(entry), "size": size}
        (caches if entry.name in (LOGS, BROWSER_PROFILE) else memory).append(item)
    memory.sort(key=lambda i: -i["size"])
    return ({"size": sum(i["size"] for i in memory), "items": memory},
            {"size": sum(i["size"] for i in caches), "items": caches})


def usage(storage: Storage, now: float | None = None) -> dict[str, Any]:
    """The disk space of Harness on this computer, by category. It can take some seconds."""
    now = time.time() if now is None else now
    memory, caches = _home_parts()
    return {
        "checked_at": now,
        "home": str(harness_home()),
        "sessions": _sessions(storage, now),
        "models": _models(),
        "runtime": _runtime(),
        "memory": memory,
        "caches": caches,
    }
