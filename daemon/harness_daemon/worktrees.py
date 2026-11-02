"""Git worktrees: a session can work in an isolated copy of the repository of its project.

A worktree session gets a new branch ``harness/<name>`` and a folder
``<repository>/.harness/worktrees/<name>``. The agent, the terminal, and the files of the session
use that folder. The project folder of the user does not change.

Archive and delete remove the folder of the worktree. The branch stays, with its commits. A
session that opens again gets a new folder for its branch.

The info of a worktree is a dict, saved as JSON with the session:
``{"repo", "root", "path", "branch", "base"}``. ``repo`` is the main folder of the repository,
``root`` is the folder of the worktree, and ``path`` is the session folder in the worktree (the
same subfolder as the project folder in the repository).
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .config import project_settings_path

BRANCH_PREFIX = "harness/"
FOLDER = Path(".harness") / "worktrees"
EXCLUDE_LINE = "/.harness/worktrees/"
GIT_TIMEOUT = 60


class WorktreeError(Exception):
    """A git step failed. The message is for the user."""


def _git(args: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    git = shutil.which("git")
    if git is None:
        raise WorktreeError("Git is not installed on the daemon computer. Install git to use worktrees.")
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = subprocess.run([git, *args], cwd=str(cwd), capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=GIT_TIMEOUT, stdin=subprocess.DEVNULL, **kwargs)
    except subprocess.TimeoutExpired:
        raise WorktreeError(f"git {args[0]} did not finish in {GIT_TIMEOUT} seconds.") from None
    except OSError as e:
        raise WorktreeError(f"git did not start: {e}") from None
    if check and proc.returncode != 0:
        lines = (proc.stderr or proc.stdout).strip().splitlines()
        raise WorktreeError(f"git {args[0]} failed: {lines[-1] if lines else f'exit code {proc.returncode}'}")
    return proc


def repo_root(folder: Path) -> Path | None:
    """The top folder of the repository of a folder, or None outside a repository."""
    try:
        proc = _git(["rev-parse", "--show-toplevel"], folder, check=False)
    except WorktreeError:
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    return Path(proc.stdout.strip()).resolve()


def branches(folder: Path) -> dict[str, Any]:
    """{"repo": bool, "current": str | None, "branches": [str]} for the "Branch to start from" menu.
    ``current`` is None for a detached HEAD. ``branches`` has the local branches, the current first."""
    if repo_root(folder) is None:
        return {"repo": False, "current": None, "branches": []}
    head = _git(["rev-parse", "--abbrev-ref", "HEAD"], folder, check=False).stdout.strip()
    current = head if head and head != "HEAD" else None
    listed = _git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"], folder,
                  check=False).stdout.split()
    names = ([current] if current else []) + [b for b in listed if b != current]
    return {"repo": True, "current": current, "branches": names}


def _ignore_worktrees(repo: Path) -> None:
    """Add the worktree folder to .git/info/exclude, so the main folder does not show it as new files."""
    common = _git(["rev-parse", "--git-common-dir"], repo).stdout.strip()
    exclude = (repo / common).resolve() / "info" / "exclude"
    try:
        text = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
        if EXCLUDE_LINE not in text.splitlines():
            exclude.parent.mkdir(parents=True, exist_ok=True)
            with exclude.open("a", encoding="utf-8") as f:
                f.write(("" if not text or text.endswith("\n") else "\n") + EXCLUDE_LINE + "\n")
    except OSError:
        pass  # Only a convenience: git still works.


def _copy_project_settings(project: Path, path: Path, root: Path) -> list[str]:
    """Copy the Harness settings of the project folder (permission mode, rules) into the worktree,
    if the worktree has none. The file is often not in git. Return the copied paths, relative to
    the worktree root with "/" separators: has_changes ignores them."""
    source, target = project_settings_path(project), project_settings_path(path)
    if source.is_file() and not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return [target.relative_to(root).as_posix()]
    return []


def new_name() -> str:
    return f"session-{secrets.token_hex(3)}"


def create(project: Path, base: str | None = None) -> dict[str, Any]:
    """Make a worktree for a new session of the project folder. ``base``: the branch to start from.
    None: the current commit of the project folder."""
    repo = repo_root(project)
    if repo is None:
        raise WorktreeError("The project folder is not in a git repository. Turn off the isolated copy, or run git init.")
    if _git(["rev-parse", "--verify", "--quiet", "HEAD"], repo, check=False).returncode != 0:
        raise WorktreeError("The repository has no commits. Make a first commit, then try again.")
    if base:
        if base.startswith("-") or _git(["rev-parse", "--verify", "--quiet", f"{base}^{{commit}}"], repo,
                                        check=False).returncode != 0:
            raise WorktreeError(f"The branch {base} does not exist.")
        start, label = base, base
    else:
        head = _git(["rev-parse", "--abbrev-ref", "HEAD"], project).stdout.strip()
        start = "HEAD"
        label = head if head and head != "HEAD" else _git(["rev-parse", "--short", "HEAD"], project).stdout.strip()
    _ignore_worktrees(repo)
    for _ in range(5):
        name = new_name()
        root = repo / FOLDER / name
        branch = BRANCH_PREFIX + name
        exists = _git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], repo, check=False).returncode == 0
        if not root.exists() and not exists:
            break
    else:
        raise WorktreeError("Could not find a free name for the worktree. Try again.")
    root.parent.mkdir(parents=True, exist_ok=True)
    _git(["worktree", "add", "-b", branch, str(root), start], repo)
    rel = os.path.relpath(project.resolve(), repo)  # relpath ignores case on Windows. relative_to does not.
    path = root if rel == "." or rel.startswith("..") else root / rel
    path.mkdir(parents=True, exist_ok=True)  # The project folder can be a folder that git does not track.
    copied = _copy_project_settings(project, path, root)
    return {"repo": str(repo), "root": str(root), "path": str(path), "branch": branch, "base": label, "copied": copied}


def restore(info: dict[str, Any]) -> None:
    """Make the folder of a worktree again for its branch, after an archive removed it."""
    root, path = Path(info["root"]), Path(info["path"])
    if path.is_dir():
        return
    repo = Path(info["repo"])
    if not repo.is_dir():
        raise WorktreeError(f"The repository folder does not exist: {repo}")
    _git(["worktree", "prune"], repo, check=False)
    if root.exists():
        raise WorktreeError(f"The worktree folder is not complete: {root}. Remove it, then open the session again.")
    if _git(["rev-parse", "--verify", "--quiet", f"refs/heads/{info['branch']}"], repo, check=False).returncode != 0:
        raise WorktreeError(f"The branch {info['branch']} of this session does not exist. Somebody deleted it.")
    root.parent.mkdir(parents=True, exist_ok=True)
    _git(["worktree", "add", str(root), info["branch"]], repo)
    path.mkdir(parents=True, exist_ok=True)


def has_changes(info: dict[str, Any]) -> bool:
    """True if the worktree has changes that are not in a commit, or new files. The files that
    create() copied into the worktree do not count."""
    root = Path(info["root"])
    if not root.is_dir():
        return False
    copied = {f"?? {p}" for p in info.get("copied") or []}
    lines = _git(["status", "--porcelain", "--untracked-files=all"], root).stdout.splitlines()
    return any(line.strip() and line not in copied for line in lines)


def remove(info: dict[str, Any]) -> None:
    """Remove the folder of a worktree, with its changes. The branch stays."""
    root, repo = Path(info["root"]), Path(info["repo"])
    if not root.exists():
        if repo.is_dir():
            _git(["worktree", "prune"], repo, check=False)
        return
    proc = _git(["worktree", "remove", "--force", str(root)], repo if repo.is_dir() else root, check=False)
    if proc.returncode != 0 and root.exists():
        _remove_tree(root)  # For example a file that a program still holds open, or a broken worktree.
        if repo.is_dir():
            _git(["worktree", "prune"], repo, check=False)


def _remove_tree(path: Path) -> None:
    def writable(func, p, _exc):  # On Windows, git makes read-only files.
        os.chmod(p, 0o700)
        func(p)

    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=writable)
    else:
        shutil.rmtree(path, onerror=writable)


def dumps(info: dict[str, Any] | None) -> str | None:
    return json.dumps(info) if info else None


def loads(text: str | None) -> dict[str, Any] | None:
    if not text:
        return None
    try:
        info = json.loads(text)
    except ValueError:
        return None
    return info if isinstance(info, dict) and {"repo", "root", "path", "branch"} <= info.keys() else None


def public(info: dict[str, Any] | None) -> dict[str, Any] | None:
    """The info for the client."""
    return {"branch": info["branch"], "base": info.get("base"), "path": info["path"]} if info else None
