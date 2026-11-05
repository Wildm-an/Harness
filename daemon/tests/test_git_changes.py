"""Tests for the change count of the Changes section in the session rail (prstatus.folder_changes)."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path

import pytest

from harness_daemon.prstatus import folder_changes, parse_numstat

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", *args],
                   cwd=cwd, check=True, capture_output=True)


def test_parse_numstat():
    assert parse_numstat("3\t1\ta.py\n-\t-\tlogo.png\n10\t0\tb.py\n") == (13, 1, 3)
    assert parse_numstat("") == (0, 0, 0)


def test_a_folder_that_is_not_a_repository(tmp_path):
    result = asyncio.run(folder_changes(str(tmp_path)))
    assert result["repo"] is False and result["files"] == 0


def test_a_local_repository_counts_the_uncommitted_changes(tmp_path):
    git(tmp_path, "init")
    (tmp_path / "a.txt").write_text("one\ntwo\n")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "first")
    (tmp_path / "a.txt").write_text("one\nTWO\nthree\n")
    (tmp_path / "new.txt").write_text("x\ny\n")  # A new file counts as added lines.
    result = asyncio.run(folder_changes(str(tmp_path)))
    assert result["repo"] and result["branch"] == "main" and result["base"] is None
    assert (result["added"], result["removed"], result["files"]) == (4, 1, 2)
    assert result["github"] is False  # No remote: the rail shows "Commit".


def test_a_clone_counts_the_commits_that_the_remote_does_not_have(tmp_path):
    origin = tmp_path / "origin"
    origin.mkdir()
    git(origin, "init")
    (origin / "a.txt").write_text("one\n")
    git(origin, "add", ".")
    git(origin, "commit", "-m", "first")
    work = tmp_path / "work"
    git(tmp_path, "clone", str(origin), str(work))
    (work / "a.txt").write_text("one\ntwo\n")
    git(work, "commit", "-am", "second")  # Committed, not pushed: it counts.
    (work / "b.txt").write_text("b\n")
    result = asyncio.run(folder_changes(str(work)))
    assert result["base"] == "origin/main"
    assert (result["added"], result["removed"], result["files"]) == (2, 0, 2)
    assert result["github"] is False  # The remote is not on GitHub.
