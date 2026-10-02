from __future__ import annotations

import asyncio
import json
import shutil
import subprocess

import pytest

from harness_daemon import prstatus


def test_parse_pr():
    data = {"number": 12, "state": "OPEN", "url": "https://github.com/o/r/pull/12", "isDraft": False, "title": "Fix"}
    assert prstatus.parse_pr(json.dumps(data)) == {"number": 12, "state": "open", "url": data["url"], "title": "Fix"}
    assert prstatus.parse_pr(json.dumps({**data, "isDraft": True}))["state"] == "draft"
    assert prstatus.parse_pr(json.dumps({**data, "state": "MERGED"}))["state"] == "merged"
    assert prstatus.parse_pr("not json") is None
    assert prstatus.parse_pr("{}") is None


def test_folder_that_is_not_a_repository(tmp_path):
    prstatus._cache.clear()
    [item] = asyncio.run(prstatus.pr_status([str(tmp_path)]))
    assert item == {"path": str(tmp_path), "branch": None, "pr": None}


def test_missing_folder(tmp_path):
    prstatus._cache.clear()
    missing = str(tmp_path / "gone")
    assert asyncio.run(prstatus.pr_status([missing])) == [{"path": missing, "branch": None, "pr": None}]


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_branch_of_a_repository(tmp_path, monkeypatch):
    prstatus._cache.clear()
    subprocess.run(["git", "init", "-q", "-b", "feature", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "-c", "user.email=a@b", "-c", "user.name=a",
                    "commit", "-q", "--allow-empty", "-m", "start"], check=True)
    which = shutil.which
    monkeypatch.setattr(prstatus.shutil, "which", lambda name: which(name) if name == "git" else None)
    [item] = asyncio.run(prstatus.pr_status([str(tmp_path)]))
    assert item["branch"] == "feature" and item["pr"] is None  # No gh: no pull request.
