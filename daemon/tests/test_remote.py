"""Tests for remote mode: the token file, the host information, and the folder browser."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from websockets.sync.client import connect

from harness_daemon.__main__ import load_or_create_token

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

DAEMON_DIR = Path(__file__).resolve().parents[1]


def test_token_file_is_created_read_and_replaced(tmp_path):
    path = tmp_path / "sub" / "daemon-token"
    token, created = load_or_create_token(path)
    assert created and len(token) >= 40 and path.read_text().strip() == token
    assert load_or_create_token(path) == (token, False)
    new, created = load_or_create_token(path, replace=True)
    assert created and new != token


def start_daemon(home: Path) -> tuple[subprocess.Popen, dict]:
    env = {k: v for k, v in os.environ.items() if k != "HARNESS_TOKEN"}
    env["HARNESS_HOME"] = str(home)
    proc = subprocess.Popen(
        [sys.executable, "-m", "harness_daemon", "--exit-on-stdin-eof"],
        cwd=DAEMON_DIR, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    return proc, json.loads(proc.stdout.readline())


def stop_daemon(proc: subprocess.Popen) -> None:
    proc.stdin.close()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


def test_daemon_that_is_started_by_hand_keeps_its_token(harness_home):
    proc, ready = start_daemon(harness_home)
    try:
        assert ready["token_file"] == str(harness_home / "daemon-token")
        token = ready["token"]
        with connect(f"ws://127.0.0.1:{ready['port']}/ws") as ws:
            ws.send(json.dumps({"type": "auth", "token": token}))
            hello = json.loads(ws.recv(timeout=10))
            assert hello["type"] == "auth.ok"
            assert {"hostname", "platform", "user", "home", "sep"} <= set(hello["host"])
    finally:
        stop_daemon(proc)
    proc, ready = start_daemon(harness_home)  # A restart reads the same token.
    try:
        assert ready["token"] == token
    finally:
        stop_daemon(proc)


def test_folder_browser(daemon, tmp_path, fake_model):  # noqa: F811
    root = tmp_path / "browse"
    (root / "beta").mkdir(parents=True)
    (root / "Alpha").mkdir()
    (root / ".hidden").mkdir()
    (root / "file.txt").write_text("x")
    (root / "beta" / "pyproject.toml").write_text("")
    c = Client(daemon)
    c.until("auth.ok")

    c.send({"type": "fs.dirs", "path": str(root)})
    listing = c.until("fs.dirs")[0]
    assert listing["path"] == str(root.resolve())
    assert [i["name"] for i in listing["items"]] == ["Alpha", "beta"]  # Folders only, no hidden folders.
    assert listing["parent"] == str(root.resolve().parent) and listing["roots"]
    assert listing["is_project"] is False

    c.send({"type": "fs.dirs", "path": str(root), "hidden": True})
    assert ".hidden" in [i["name"] for i in c.until("fs.dirs")[0]["items"]]

    c.send({"type": "fs.dirs", "path": str(root / "beta")})
    assert c.until("fs.dirs")[0]["is_project"] is True

    c.send({"type": "fs.dirs", "path": "relative/folder"})
    assert "absolute" in c.until("error")[0]["message"]
    c.send({"type": "fs.dirs", "path": str(root / "missing")})
    assert "does not exist" in c.until("error")[0]["message"]

    c.send({"type": "fs.dirs"})  # The home folder by default.
    assert c.until("fs.dirs")[0]["path"] == str(Path.home().resolve())
    c.close()
