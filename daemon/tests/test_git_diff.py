"""Tests for the full change of a folder in the Changes pane (prstatus.folder_diff, split_diff)."""

from __future__ import annotations

import asyncio
import shutil
import subprocess
from pathlib import Path

import pytest

from harness_daemon.prstatus import folder_diff, split_diff

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", *args],
                   cwd=cwd, check=True, capture_output=True)


def test_split_diff_finds_each_file_and_its_state():
    text = (
        "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+ONE\n"
        "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n"
        "diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n"
        "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n"
    )
    files = split_diff(text)
    assert [(f["path"], f["status"]) for f in files] == [("a.txt", "M"), ("gone.txt", "D"), ("new.txt", "R"), ("logo.png", "M")]
    assert files[2]["old_path"] == "old.txt"
    assert files[3]["binary"] is True
    assert files[0]["patch"].startswith("diff --git a/a.txt") and "+ONE\n" in files[0]["patch"]


def test_a_folder_that_is_not_a_repository(tmp_path):
    result = asyncio.run(folder_diff(str(tmp_path)))
    assert result["repo"] is False and result["files"] == []


@needs_git
def test_the_branch_diff_has_the_commits_the_changes_and_the_new_files(tmp_path):
    origin = tmp_path / "origin"
    origin.mkdir()
    git(origin, "init")
    (origin / "a.txt").write_text("one\n")
    git(origin, "add", ".")
    git(origin, "commit", "-m", "first")
    work = tmp_path / "work"
    git(tmp_path, "clone", str(origin), str(work))
    (work / "a.txt").write_text("one\ntwo\n")
    git(work, "commit", "-am", "second")  # Committed, not pushed.
    (work / "b.txt").write_text("b1\nb2\n")  # A new file.
    result = asyncio.run(folder_diff(str(work)))
    assert result["repo"] and result["base"] == "origin/main" and result["branch"] == "main"
    by_path = {f["path"]: f for f in result["files"]}
    assert set(by_path) == {"a.txt", "b.txt"}
    assert "+two" in by_path["a.txt"]["patch"]
    assert by_path["b.txt"]["status"] == "A" and by_path["b.txt"].get("untracked")
    assert "+b1\n+b2\n" in by_path["b.txt"]["patch"]

    # "uncommitted": only the change that is not in a commit.
    result = asyncio.run(folder_diff(str(work), "uncommitted"))
    assert [f["path"] for f in result["files"]] == ["b.txt"]
