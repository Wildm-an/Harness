"""Tests for the git worktree sessions."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from harness_daemon import worktrees
from harness_daemon.worktrees import WorktreeError

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), "-c", "user.email=a@b", "-c", "user.name=a", *args],
                          check=True, capture_output=True, text=True).stdout


def make_repo(folder: Path, branch: str = "main") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", branch, str(folder)], check=True)
    (folder / "app.py").write_text("print('hi')\n")
    (folder / "web").mkdir()
    (folder / "web" / "index.html").write_text("<p>hi</p>\n")
    git(folder, "add", ".")
    git(folder, "commit", "-q", "-m", "start")
    return folder


def test_branches(tmp_path):
    repo = make_repo(tmp_path / "repo")
    git(repo, "branch", "feature")
    info = worktrees.branches(repo)
    assert info["repo"] and info["current"] == "main"
    assert info["branches"][0] == "main" and "feature" in info["branches"]
    plain = tmp_path / "plain"
    plain.mkdir()
    assert worktrees.branches(plain) == {"repo": False, "current": None, "branches": []}


def test_create_archive_restore_and_remove(tmp_path):
    repo = make_repo(tmp_path / "repo")
    (repo / ".harness").mkdir()
    (repo / ".harness" / "settings.json").write_text('{"permission_mode": "plan"}')

    info = worktrees.create(repo)
    root, path = Path(info["root"]), Path(info["path"])
    assert info["branch"].startswith("harness/session-") and info["base"] == "main"
    assert root == path and (path / "app.py").is_file()
    assert root.parent == (repo / ".harness" / "worktrees").resolve()
    assert (path / ".harness" / "settings.json").read_text() == '{"permission_mode": "plan"}'  # Copied.
    assert git(path, "rev-parse", "--abbrev-ref", "HEAD").strip() == info["branch"]
    # The main folder does not show the worktree as new files.
    assert ".harness/worktrees" not in git(repo, "status", "--porcelain", "--untracked-files=all")

    # A commit in the worktree stays on its branch after the folder goes away.
    (path / "app.py").write_text("print('changed')\n")
    assert worktrees.has_changes(info)
    git(path, "commit", "-q", "-am", "change")
    assert not worktrees.has_changes(info)
    worktrees.remove(info)
    assert not root.exists()
    assert info["branch"] in git(repo, "branch", "--list", info["branch"])

    worktrees.restore(info)  # The session opens again: the folder comes back with the commit.
    assert (path / "app.py").read_text() == "print('changed')\n"
    worktrees.remove(info)


def test_subfolder_and_base_branch(tmp_path):
    repo = make_repo(tmp_path / "repo")
    git(repo, "checkout", "-q", "-b", "feature")
    (repo / "feature.txt").write_text("f\n")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "feature")
    git(repo, "checkout", "-q", "main")

    info = worktrees.create(repo / "web", base="feature")
    assert Path(info["path"]) == Path(info["root"]) / "web" and (Path(info["path"]) / "index.html").is_file()
    assert info["base"] == "feature" and (Path(info["root"]) / "feature.txt").is_file()
    worktrees.remove(info)

    with pytest.raises(WorktreeError, match="does not exist"):
        worktrees.create(repo, base="no-such-branch")
    with pytest.raises(WorktreeError, match="does not exist"):
        worktrees.create(repo, base="--help")


def test_errors(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(WorktreeError, match="not in a git repository"):
        worktrees.create(plain)
    empty = tmp_path / "empty"
    subprocess.run(["git", "init", "-q", str(empty)], check=True)
    with pytest.raises(WorktreeError, match="no commits"):
        worktrees.create(empty)


def test_loads():
    assert worktrees.loads(None) is None and worktrees.loads("not json") is None
    assert worktrees.loads('{"branch": "b"}') is None  # Not complete.
    info = {"repo": "r", "root": "t", "path": "p", "branch": "b", "base": "main"}
    assert worktrees.loads(worktrees.dumps(info)) == info
    assert worktrees.public(info) == {"branch": "b", "base": "main", "path": "p"}


def test_worktree_session_through_the_protocol(daemon, fake_model, tmp_path):  # noqa: F811
    repo = make_repo(tmp_path / "repo")
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "git.branches", "cwd": str(repo)})
    assert c.until("git.branches")[0]["current"] == "main"

    c.send({"type": "session.new", "cwd": str(repo), "model": "fake/test-model", "worktree": {"base": "main"}})
    ready = c.until("session.ready")[0]
    work = Path(ready["cwd"])
    assert ready["worktree"]["branch"].startswith("harness/") and work != repo.resolve() and (work / "app.py").is_file()
    assert ready["project"]["name"] == "repo"  # The session stays in the project of the user.
    sid = ready["session_id"]

    c.send({"type": "session.list"})
    [item] = [s for s in c.until("sessions")[0]["items"] if s["id"] == sid]
    assert Path(item["cwd"]) == repo.resolve() and item["branch"] == ready["worktree"]["branch"]

    c.send({"type": "session.move", "session_id": sid, "cwd": str(tmp_path)})
    assert "cannot move" in c.until("error")[0]["message"]

    # A change that is not in a commit: the archive asks first.
    (work / "app.py").write_text("print('changed')\n")
    c.send({"type": "session.update", "session_id": sid, "archived": True})
    assert c.until("session.archive_confirm")[0]["id"] == sid
    assert work.is_dir()
    c.send({"type": "session.update", "session_id": sid, "archived": True, "force": True})
    assert c.until("session.updated")[0]["archived"] is True
    assert not work.exists()

    # The session opens again in a new folder of the same branch.
    c.send({"type": "session.resume", "session_id": sid})
    again = c.until("session.ready")[0]
    assert again["worktree"]["branch"] == ready["worktree"]["branch"] and Path(again["cwd"]).is_dir()

    c.send({"type": "session.delete", "session_id": sid})
    c.until("session.deleted")
    assert not work.exists()
    assert ready["worktree"]["branch"] in git(repo, "branch", "--list", ready["worktree"]["branch"])  # The branch stays.

    plain = tmp_path / "plain"
    plain.mkdir()
    c.send({"type": "session.new", "cwd": str(plain), "model": "fake/test-model", "worktree": True})
    assert "not in a git repository" in c.until("error")[0]["message"]
    c.close()
