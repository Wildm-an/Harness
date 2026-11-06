"""The pull request of the branch of a project folder, for the sidebar ("Show PR status").

The daemon reads the branch with git, and the pull request with the GitHub CLI (``gh``).
Without ``gh``, or for a folder that is not a git repository, the pull request is None.
The results stay in a cache for a short time, because the sidebar asks often.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
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


# The fields of a pull request that the app shows: the hover card, the sidebar, and the rail.
PR_FIELDS = "number,state,url,isDraft,title,additions,deletions,changedFiles,author,updatedAt,mergedAt,closedAt,headRefName,baseRefName"

_REPO_RE = re.compile(r"github\.com/([^/\s]+/[^/\s]+)/pull/\d+", re.IGNORECASE)


def repo_of(url: str | None) -> str | None:
    """"owner/name" of a GitHub pull request URL, else None."""
    m = _REPO_RE.search(url or "")
    return m.group(1) if m else None


_REMOTE_RE = re.compile(r"github\.com[:/]+([^/\s:]+/[^/\s]+?)(?:\.git)?/?$", re.IGNORECASE)


def github_repo(remote: str) -> str | None:
    """"owner/name" of a GitHub remote URL (https or ssh), else None."""
    m = _REMOTE_RE.search(remote.strip())
    return m.group(1) if m else None


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def parse_pr(text: str) -> dict[str, Any] | None:
    """The output of ``gh pr view --json PR_FIELDS``. state: open, draft, merged, or closed.

    ``updated_at`` is the time of the last state change: the merge, the close, or the last update.
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("number"), int):
        return None
    state = str(data.get("state") or "").lower()
    if state == "open" and data.get("isDraft"):
        state = "draft"
    author = data.get("author")
    login = author.get("login") if isinstance(author, dict) else None
    url = data.get("url")
    return {
        "number": data["number"],
        "state": state,
        "url": url,
        "title": data.get("title"),
        "repo": repo_of(url if isinstance(url, str) else None),
        "additions": _int(data.get("additions")),
        "deletions": _int(data.get("deletions")),
        "changed_files": _int(data.get("changedFiles")),
        "author": login if isinstance(login, str) else None,
        "updated_at": data.get("mergedAt") or data.get("closedAt") or data.get("updatedAt"),
        "head": data.get("headRefName"),
        "base": data.get("baseRefName"),
    }


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
                result["pr"] = await branch_pr(gh, path)
    _cache[key] = (time.monotonic(), result)
    return result


async def branch_pr(gh: str, path: str) -> dict[str, Any] | None:
    """The pull request of the current branch of a folder (``gh pr view``), else None."""
    code, out = await _run([gh, "pr", "view", "--json", PR_FIELDS], path, GH_TIMEOUT)
    return parse_pr(out) if code == 0 else None


_info_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}

# The cache time of a "fresh" request: the PR list of the rail asks often, so a change of the state on
# GitHub (merged, closed) shows soon. Two windows that ask at the same time still run gh one time.
FRESH_SECONDS = 10


async def pr_info(url: str, fresh: bool = False) -> dict[str, Any] | None:
    """A pull request from its URL, for the hover card of a link in the chat and the PR list of the
    rail. None: no ``gh``, or gh cannot read it (no access, a bad URL, no network). The result stays
    in a cache for a short time: CACHE_SECONDS, or FRESH_SECONDS for a ``fresh`` request."""
    cached = _info_cache.get(url)
    if cached and time.monotonic() - cached[0] < (FRESH_SECONDS if fresh else CACHE_SECONDS):
        return cached[1]
    gh = shutil.which("gh")
    if not gh or not repo_of(url):
        return None
    code, out = await _run([gh, "pr", "view", url, "--json", PR_FIELDS], os.path.expanduser("~"), GH_TIMEOUT)
    pr = parse_pr(out) if code == 0 else None
    _info_cache[url] = (time.monotonic(), pr)
    return pr


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


async def _numstat(git: str, path: str, *revs: str) -> dict[str, int]:
    """{"files", "added", "removed"} of ``git diff --numstat <revs>``. All zero when git fails."""
    code, out = await _run([git, "diff", "--numstat", *revs], path, GIT_TIMEOUT)
    added, removed, files = parse_numstat(out) if code == 0 else (0, 0, 0)
    return {"files": files, "added": added, "removed": removed}


async def _count(git: str, path: str, revs: str) -> int:
    """The number of commits of ``git rev-list --count <revs>``. 0 when git fails."""
    code, out = await _run([git, "rev-list", "--count", revs], path, GIT_TIMEOUT)
    return int(out.strip()) if code == 0 and out.strip().isdigit() else 0


EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"  # The base of a repository with no commit yet.


async def _find_base(git: str, path: str, remote: bool) -> tuple[str, str, str | None, bool]:
    """(head, base, base_ref, merged) of a folder. ``head`` is "HEAD", or the empty tree with no commit.
    ``base_ref`` is the default branch of ``origin`` (for example ``origin/main``), else None. ``base``
    is the merge base of HEAD with it, else ``head``. ``merged``: ``base`` is that merge base."""
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
    code, _ = await _run([git, "rev-parse", "--verify", "--quiet", "HEAD"], path, GIT_TIMEOUT)
    head = "HEAD" if code == 0 else EMPTY_TREE
    if base_ref and head == "HEAD":
        code, out = await _run([git, "merge-base", "HEAD", base_ref], path, GIT_TIMEOUT)
        if code == 0 and out.strip():
            return head, out.strip(), base_ref, True
    return head, head, base_ref, False


async def folder_changes(path: str, with_pr: bool = True) -> dict[str, Any]:
    """The changes of a folder against its base, as Claude Code shows them in the session rail.

    The base is the merge base of HEAD with the default branch of ``origin`` (for example
    ``origin/main``), else HEAD. The totals have the commits that the base does not have, the
    uncommitted changes, and the new files that git does not ignore.

    The work is also in three parts, so the rail can show each part in its own color:

    - ``uncommitted``: the changes and the new files that are not in a commit.
    - ``unpushed``: the commits that the remote branch does not have. None with no remote.
    - ``pushed``: the commits on the remote branch that the base does not have. None when the
      branch is not on the remote.

    Each part is {"files", "added", "removed"}, and ``unpushed`` and ``pushed`` also have "commits".
    ``upstream`` is the remote branch (for example ``origin/feature``), and ``behind`` is the number
    of its commits that HEAD does not have. ``pr`` is the pull request of the branch (with_pr).

    ``github``: the ``origin`` remote is on GitHub and ``gh`` is installed, so a pull request is possible.
    """
    result: dict[str, Any] = {"path": path, "repo": False, "branch": None, "base": None,
                              "added": 0, "removed": 0, "files": 0, "github": False, "github_repo": None, "remote": False,
                              "upstream": None, "behind": 0, "uncommitted": None, "unpushed": None,
                              "pushed": None, "pr": None}
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
    result["remote"] = bool(remote)
    gh = shutil.which("gh")
    result["github"] = "github.com" in remote.lower() and gh is not None
    result["github_repo"] = github_repo(remote)
    head, base, base_ref, merged = await _find_base(git, path, bool(remote))
    if merged:
        result["base"] = base_ref

    # The remote branch: the upstream of the branch, else a branch of origin with the same name
    # (a push with no -u). Only a branch of a remote counts.
    upstream = None
    if remote and result["branch"]:
        code, out = await _run([git, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], path, GIT_TIMEOUT)
        upstream = out.strip() if code == 0 and out.strip() else None
        if upstream is None:
            name = f"origin/{result['branch']}"
            code, _ = await _run([git, "rev-parse", "--verify", "--quiet", f"refs/remotes/{name}"], path, GIT_TIMEOUT)
            upstream = name if code == 0 else None
    result["upstream"] = upstream

    code, out = await _run([git, "ls-files", "--others", "--exclude-standard"], path, GIT_TIMEOUT)
    untracked = [line for line in out.splitlines() if line.strip()] if code == 0 else []
    new_lines = await asyncio.to_thread(lambda: sum(_count_lines(f"{path}/{name}") for name in untracked[:MAX_UNTRACKED]))

    total = await _numstat(git, path, base)
    result["files"] = total["files"] + len(untracked)
    result["added"] = total["added"] + new_lines
    result["removed"] = total["removed"]

    uncommitted = await _numstat(git, path, head)
    uncommitted["files"] += len(untracked)
    uncommitted["added"] += new_lines
    result["uncommitted"] = uncommitted

    if head == "HEAD" and upstream:
        result["unpushed"] = {"commits": await _count(git, path, f"{upstream}..HEAD"), **await _numstat(git, path, f"{upstream}...HEAD")}
        result["behind"] = await _count(git, path, f"HEAD..{upstream}")
        if base_ref:
            result["pushed"] = {"commits": await _count(git, path, f"{base_ref}..{upstream}"), **await _numstat(git, path, f"{base_ref}...{upstream}")}
    elif head == "HEAD" and remote:
        # The branch is not on the remote: all its commits since the base are not pushed.
        commits = await _count(git, path, f"{base_ref}..HEAD") if base_ref else await _count(git, path, "HEAD")
        result["unpushed"] = {"commits": commits, **(await _numstat(git, path, base, "HEAD") if base != "HEAD" else {"files": 0, "added": 0, "removed": 0})}

    if with_pr and result["github"] and result["branch"] and gh:
        result["pr"] = await branch_pr(gh, path)
        # The sidebar gets the new state at its next request.
        _cache[path_key(path)] = (time.monotonic(), {"path": path, "branch": result["branch"], "pr": result["pr"]})
    return result


DIFF_TIMEOUT = 20
MAX_FILE_PATCH = 300_000  # Characters. A larger change of one file shows as "too large".
MAX_DIFF_CHARS = 4_000_000  # Characters of all the files. More: the other files have no text, and "truncated" is true.
_DIFF_HEAD = re.compile(r"^diff --git a/(.*) b/(.*)$")


def split_diff(text: str) -> list[dict[str, Any]]:
    """The files of a ``git diff`` text: {"path", "old_path", "status", "binary", "patch"}. Status: "A"
    (added), "D" (deleted), "R" (renamed), or "M" (modified). ``patch`` is the text of the file, with its
    header lines."""
    files: list[dict[str, Any]] = []
    current: list[str] = []

    def close() -> None:
        if not current:
            return
        head = _DIFF_HEAD.match(current[0])
        old = head.group(1) if head else ""
        new = head.group(2) if head else ""
        status = "M"
        binary = False
        for line in current[1:]:
            if line.startswith("@@"):
                break
            if line.startswith("new file mode"):
                status = "A"
            elif line.startswith("deleted file mode"):
                status = "D"
            elif line.startswith("rename from "):
                status, old = "R", line[len("rename from "):]
            elif line.startswith("rename to "):
                new = line[len("rename to "):]
            elif line.startswith("--- a/"):
                old = line[6:]
            elif line.startswith("+++ b/"):
                new = line[6:]
            elif line.startswith("Binary files "):
                binary = True
        files.append({"path": old if status == "D" else new, "old_path": old if status == "R" else None,
                      "status": status, "binary": binary, "patch": "\n".join(current) + "\n"})

    for line in text.splitlines():
        if line.startswith("diff --git "):
            close()
            current = [line]
        elif current:
            current.append(line)
    close()
    return files


def _new_file_patch(path: str, name: str) -> dict[str, Any]:
    """An untracked file as a change that adds all its lines."""
    entry: dict[str, Any] = {"path": name, "old_path": None, "status": "A", "binary": False, "untracked": True, "patch": ""}
    try:
        with open(f"{path}/{name}", "rb") as f:
            data = f.read(MAX_UNTRACKED_BYTES + 1)
    except OSError:
        return entry
    if b"\0" in data[:8000]:
        entry["binary"] = True
        return entry
    if len(data) > MAX_UNTRACKED_BYTES:
        entry["too_large"] = True
        return entry
    lines = data.decode("utf-8", "replace").splitlines()
    body = "".join(f"+{line}\n" for line in lines)
    hunk = f"@@ -0,0 +1,{len(lines)} @@\n{body}" if lines else ""
    entry["patch"] = f"diff --git a/{name} b/{name}\nnew file mode 100644\n--- /dev/null\n+++ b/{name}\n{hunk}"
    return entry


async def folder_diff(path: str, scope: str = "branch") -> dict[str, Any]:
    """The full change of a folder, for the Changes pane: each file with its unified diff.

    ``scope`` "branch": the folder against the base of the branch (the same total as the Changes section
    of the rail: the commits that the base does not have, the uncommitted changes, and the new files).
    "uncommitted": the folder against HEAD, and the new files.
    """
    scope = "uncommitted" if scope == "uncommitted" else "branch"
    result: dict[str, Any] = {"repo": False, "branch": None, "base": None, "scope": scope, "files": [], "truncated": False}
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
    head, base, base_ref, merged = await _find_base(git, path, code == 0 and bool(remote.strip()))
    if scope == "branch" and merged:
        result["base"] = base_ref
    rev = base if scope == "branch" else head
    code, out = await _run([git, "-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "-M", "--unified=3", rev],
                           path, DIFF_TIMEOUT)
    files = split_diff(out) if code == 0 else []
    code, out = await _run([git, "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"], path, GIT_TIMEOUT)
    untracked = [line for line in out.splitlines() if line.strip()] if code == 0 else []
    files += await asyncio.to_thread(lambda: [_new_file_patch(path, name) for name in untracked[:MAX_UNTRACKED]])
    files.sort(key=lambda f: f["path"].lower())
    total = 0
    for f in files:
        if len(f["patch"]) > MAX_FILE_PATCH:
            f["patch"] = ""
            f["too_large"] = True
        total += len(f["patch"])
        if total > MAX_DIFF_CHARS:
            f["patch"] = ""
            f["too_large"] = True
            result["truncated"] = True
    result["files"] = files
    if len(untracked) > MAX_UNTRACKED:
        result["truncated"] = True
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
