import asyncio
import shutil
import subprocess

import pytest

from harness_daemon.prstatus import file_statuses, parse_status


def test_parse_the_states():
    text = "\0".join([
        " M src/app.py",
        "M  README.md",
        "A  new.py",
        " D gone.py",
        "R  after.py",
        "before.py",
        "UU both.py",
        "?? notes/todo.txt",
        "!! build/out.o",
        "",
    ])
    assert parse_status(text) == {
        "src/app.py": "modified",
        "README.md": "modified",
        "new.py": "added",
        "gone.py": "deleted",
        "after.py": "renamed",
        "both.py": "conflict",
        "notes/todo.txt": "untracked",
    }


def test_paths_are_relative_to_the_folder():
    text = " M client/src/a.ts\0 M daemon/b.py\0"
    assert parse_status(text, "client/") == {"src/a.ts": "modified"}


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_a_real_repository(tmp_path):
    def git(*args):
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    (tmp_path / "kept.txt").write_text("one\n")
    git("add", "kept.txt")
    git("commit", "-q", "-m", "first")
    (tmp_path / "kept.txt").write_text("two\n")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "new.txt").write_text("new\n")
    assert asyncio.run(file_statuses(str(tmp_path))) == {"kept.txt": "modified", "sub/new.txt": "untracked"}
    assert asyncio.run(file_statuses(str(tmp_path / "sub"))) == {"new.txt": "untracked"}


def test_not_a_repository(tmp_path):
    assert asyncio.run(file_statuses(str(tmp_path))) == {}
