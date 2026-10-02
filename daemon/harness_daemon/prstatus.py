"""The pull request of the branch of a project folder, for the sidebar ("Show PR status").

The daemon reads the branch with git, and the pull request with the GitHub CLI (``gh``).
Without ``gh``, or for a folder that is not a git repository, the pull request is None.
The results stay in a cache for a short time, because the sidebar asks often.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import sys
import time
from typing import Any

from .storage import path_key

CACHE_SECONDS = 60
GIT_TIMEOUT = 5
GH_TIMEOUT = 15

_cache: dict[str, tuple[float, dict[str, Any]]] = {}


async def _run(args: list[str], cwd: str, timeout: float) -> tuple[int, str]:
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, cwd=cwd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, **kwargs,
        )
    except OSError:
        return -1, ""
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, ""
    return proc.returncode or 0, out.decode("utf-8", "replace")


def parse_pr(text: str) -> dict[str, Any] | None:
    """The output of ``gh pr view --json number,state,url,isDraft,title``. state: open, draft, merged, or closed."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("number"), int):
        return None
    state = str(data.get("state") or "").lower()
    if state == "open" and data.get("isDraft"):
        state = "draft"
    return {"number": data["number"], "state": state, "url": data.get("url"), "title": data.get("title")}


async def folder_status(path: str) -> dict[str, Any]:
    """{"path", "branch", "pr"}. ``branch`` is None outside a git repository."""
    key = path_key(path)
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1]
    result: dict[str, Any] = {"path": path, "branch": None, "pr": None}
    git = shutil.which("git")
    if git:
        code, out = await _run([git, "rev-parse", "--abbrev-ref", "HEAD"], path, GIT_TIMEOUT)
        branch = out.strip() if code == 0 else ""
        if branch and branch != "HEAD":
            result["branch"] = branch
            gh = shutil.which("gh")
            if gh:
                code, out = await _run([gh, "pr", "view", "--json", "number,state,url,isDraft,title"], path, GH_TIMEOUT)
                if code == 0:
                    result["pr"] = parse_pr(out)
    _cache[key] = (time.monotonic(), result)
    return result


async def pr_status(paths: list[str]) -> list[dict[str, Any]]:
    return list(await asyncio.gather(*(folder_status(p) for p in paths)))
