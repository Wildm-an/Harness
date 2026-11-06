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


# -- the changes of a folder, for the "Changes" section of the session rail -----------------

MAX_UNTRACKED = 200  # Untracked files that count as added lines, at most.
MAX_UNTRACKED_BYTES = 1_000_000  # A larger untracked file counts as one changed file with no lines.


def parse_numstat(text: str) -> tuple[int, int, int]:
    """The added lines, the removed lines, and the files of ``git diff --numstat``. A binary file has "-"."""
    added = removed = files = 0
    for line in text.splitlines():
        parts = line.split("\t", 2)
        if len(parts) < 3:
            continue
        files += 1
        added += int(parts[0]) if parts[0].isdigit() else 0
        removed += int(parts[1]) if parts[1].isdigit() else 0
    return added, removed, files


def _count_lines(path: str) -> int:
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_UNTRACKED_BYTES + 1)
    except OSError:
        return 0
    if len(data) > MAX_UNTRACKED_BYTES or b"\0" in data[:8000]:
        return 0  # A large or binary file.
    return data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)


async def folder_changes(path: str) -> dict[str, Any]:
    """The changes of a folder against its base, as Claude Code shows them in the session rail.

    The base is the merge base of HEAD with the default branch of ``origin`` (for example
    ``origin/main``), else HEAD. The count has the commits that the base does not have, the
    uncommitted changes, and the new files that git does not ignore.

    Return {"path", "repo", "branch", "base", "added", "removed", "files", "github"}. ``github``:
    the ``origin`` remote is on GitHub and ``gh`` is installed, so a pull request is possible.
    """
    result: dict[str, Any] = {"path": path, "repo": False, "branch": None, "base": None,
                              "added": 0, "removed": 0, "files": 0, "github": False}
    git = shutil.which("git")
    if not git:
        return result
    code, out = await _run([git, "rev-parse", "--abbrev-ref", "HEAD"], path, GIT_TIMEOUT)
    if code != 0:
        return result
    result["repo"] = True
    branch = out.strip()
    result["branch"] = branch if branch and branch != "HEAD" else None
    code, remote = await _run([git, "remote", "get-url", "origin"], path, GIT_TIMEOUT)
    remote = remote.strip() if code == 0 else ""
    result["github"] = "github.com" in remote.lower() and shutil.which("gh") is not None
    base_ref = None
    if remote:
        code, out = await _run([git, "rev-parse", "--abbrev-ref", "origin/HEAD"], path, GIT_TIMEOUT)
        base_ref = out.strip() if code == 0 and out.strip() else None
        if base_ref is None:
            for name in ("origin/main", "origin/master"):
                code, _ = await _run([git, "rev-parse", "--verify", "--quiet", name], path, GIT_TIMEOUT)
                if code == 0:
                    base_ref = name
                    break
    base = "HEAD"
    if base_ref:
        code, out = await _run([git, "merge-base", "HEAD", base_ref], path, GIT_TIMEOUT)
        if code == 0 and out.strip():
            base = out.strip()
            result["base"] = base_ref
    code, out = await _run([git, "diff", "--numstat", base], path, GIT_TIMEOUT)
    if code == 0:
        result["added"], result["removed"], result["files"] = parse_numstat(out)
    code, out = await _run([git, "ls-files", "--others", "--exclude-standard"], path, GIT_TIMEOUT)
    if code == 0:
        untracked = [line for line in out.splitlines() if line.strip()]
        result["files"] += len(untracked)
        counts = await asyncio.to_thread(
            lambda: sum(_count_lines(f"{path}/{name}") for name in untracked[:MAX_UNTRACKED]))
        result["added"] += counts
    return result


MAX_STATUS_FILES = 5000  # More changed files than this: the tree colors only the first ones.


def parse_status(text: str, prefix: str = "") -> dict[str, str]:
    """The output of ``git status --porcelain=v1 -z --untracked-files=all``: {path: state}.

    The state is "modified", "added", "deleted", "renamed", "untracked", or "conflict". The paths are
    relative to the folder with the repository path ``prefix`` (``git rev-parse --show-prefix``).
    The files outside the folder are not in the result.
    """
    result: dict[str, str] = {}
    parts = text.split("\0")
    i = 0
    while i < len(parts) and len(result) < MAX_STATUS_FILES:
        entry = parts[i]
        i += 1
        if len(entry) < 4:
            continue
        x, y, path = entry[0], entry[1], entry[3:]
        if x in "RC":
            i += 1  # The next part is the old path of the rename or the copy.
        if x == "!":
            continue
        if x == "?":
            state = "untracked"
        elif "U" in (x, y) or (x, y) in (("A", "A"), ("D", "D")):
            state = "conflict"
        elif x == "A":
            state = "added"
        elif "D" in (x, y):
            state = "deleted"
        elif x == "R":
            state = "renamed"
        else:
            state = "modified"
        if prefix:
            if not path.startswith(prefix):
                continue
            path = path[len(prefix):]
        path = path.rstrip("/")
        if path:
            result[path] = state
    return result


async def file_statuses(path: str) -> dict[str, str]:
    """The git state of the changed files in a folder, for the colors of the file tree.

    Return {} for a folder that is not in a git repository, or when git is not installed.
    """
    git = shutil.which("git")
    if not git:
        return {}
    code, prefix = await _run([git, "rev-parse", "--show-prefix"], path, GIT_TIMEOUT)
    if code != 0:
        return {}
    code, out = await _run([git, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], path, GIT_TIMEOUT)
    if code != 0:
        return {}
    return parse_status(out, prefix.strip())
