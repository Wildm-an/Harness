from __future__ import annotations

import asyncio
import json
import shutil
import subprocess

import pytest

from harness_daemon import prstatus


def test_parse_pr():
    data = {"number": 12, "state": "OPEN", "url": "https://github.com/o/r/pull/12", "isDraft": False, "title": "Fix"}
    pr = prstatus.parse_pr(json.dumps(data))
    assert {k: pr[k] for k in ("number", "state", "url", "title", "repo")} == {
        "number": 12, "state": "open", "url": data["url"], "title": "Fix", "repo": "o/r"}
    full = {**data, "state": "MERGED", "additions": 1479, "deletions": 599, "changedFiles": 33,
            "author": {"login": "octo"}, "updatedAt": "2026-11-01T10:00:00Z", "mergedAt": "2026-11-02T10:00:00Z"}
    pr = prstatus.parse_pr(json.dumps(full))
    assert (pr["additions"], pr["deletions"], pr["changed_files"], pr["author"]) == (1479, 599, 33, "octo")
    assert pr["updated_at"] == "2026-11-02T10:00:00Z"  # The merge time, not the last update.
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


def _git(path, *args):
    subprocess.run(["git", "-C", str(path), "-c", "user.email=a@b", "-c", "user.name=a", *args], check=True,
                   capture_output=True)


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_changes_in_three_parts(tmp_path):
    """The uncommitted, the unpushed, and the pushed work each have their own counts."""
    origin = tmp_path / "origin.git"
    work = tmp_path / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True)
    _git(work, "remote", "add", "origin", str(origin))
    (work / "a.txt").write_text("one\n")
    _git(work, "add", "a.txt")
    _git(work, "commit", "-q", "-m", "start")
    _git(work, "push", "-q", "-u", "origin", "main")
    _git(work, "remote", "set-head", "origin", "main")
    _git(work, "switch", "-q", "-c", "feature")
    (work / "b.txt").write_text("b\nb\n")
    _git(work, "add", "b.txt")
    _git(work, "commit", "-q", "-m", "pushed")
    _git(work, "push", "-q", "-u", "origin", "feature")
    (work / "c.txt").write_text("c\n")
    _git(work, "add", "c.txt")
    _git(work, "commit", "-q", "-m", "local")
    (work / "a.txt").write_text("one\ntwo\n")
    (work / "new.txt").write_text("x\ny\nz\n")

    result = asyncio.run(prstatus.folder_changes(str(work), with_pr=False))
    assert result["upstream"] == "origin/feature" and result["behind"] == 0
    assert result["uncommitted"] == {"files": 2, "added": 4, "removed": 0}
    assert result["unpushed"] == {"commits": 1, "files": 1, "added": 1, "removed": 0}
    assert result["pushed"] == {"commits": 1, "files": 1, "added": 2, "removed": 0}
    assert (result["files"], result["added"]) == (4, 7)


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_changes_of_a_branch_that_is_not_pushed(tmp_path):
    origin = tmp_path / "origin.git"
    work = tmp_path / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(work)], check=True)
    _git(work, "remote", "add", "origin", str(origin))
    _git(work, "commit", "-q", "--allow-empty", "-m", "start")
    _git(work, "push", "-q", "-u", "origin", "main")
    _git(work, "switch", "-q", "-c", "local-only")
    (work / "b.txt").write_text("b\n")
    _git(work, "add", "b.txt")
    _git(work, "commit", "-q", "-m", "local")
    result = asyncio.run(prstatus.folder_changes(str(work), with_pr=False))
    assert result["upstream"] is None and result["pushed"] is None
    assert result["unpushed"] == {"commits": 1, "files": 1, "added": 1, "removed": 0}
    assert result["uncommitted"] == {"files": 0, "added": 0, "removed": 0}


def test_github_repo():
    assert prstatus.github_repo("https://github.com/Wildm-an/Harness.git") == "Wildm-an/Harness"
    assert prstatus.github_repo("git@github.com:Wildm-an/Harness.git") == "Wildm-an/Harness"
    assert prstatus.github_repo("https://github.com/o/r") == "o/r"
    assert prstatus.github_repo("https://gitlab.com/o/r.git") is None


def test_repo_of():
    assert prstatus.repo_of("https://github.com/Wildm-an/Harness/pull/5") == "Wildm-an/Harness"
    assert prstatus.repo_of("https://example.com/x") is None


def test_pr_info_fresh_uses_a_short_cache(monkeypatch):
    """The PR list of the rail asks with "fresh": a new state on GitHub shows after FRESH_SECONDS, not CACHE_SECONDS."""
    url = "https://github.com/o/r/pull/7"
    prstatus._info_cache.clear()
    calls: list[str] = []
    states = iter(["OPEN", "MERGED"])

    async def fake_run(args, cwd, timeout):
        calls.append(args[3])
        return 0, json.dumps({"number": 7, "state": next(states), "url": url, "isDraft": False, "title": "T"})

    now = [1000.0]
    monkeypatch.setattr(prstatus, "_run", fake_run)
    monkeypatch.setattr(prstatus.shutil, "which", lambda name: "gh")
    monkeypatch.setattr(prstatus.time, "monotonic", lambda: now[0])
    assert asyncio.run(prstatus.pr_info(url))["state"] == "open"
    now[0] += prstatus.FRESH_SECONDS + 1
    assert asyncio.run(prstatus.pr_info(url))["state"] == "open"  # A normal request keeps the cache.
    assert asyncio.run(prstatus.pr_info(url, fresh=True))["state"] == "merged"
    assert calls == [url, url]
    prstatus._info_cache.clear()
