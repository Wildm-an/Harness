"""Start the daemon as a separate process, the same way the desktop client starts the sidecar."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from websockets.sync.client import connect

DAEMON_DIR = Path(__file__).resolve().parents[1]


def test_daemon_process_prints_ready_and_serves(harness_home, project, fake_model):
    fake_model.script({"text": "pong"})
    env = dict(os.environ, HARNESS_TOKEN="sidecar-token", HARNESS_HOME=str(harness_home))
    proc = subprocess.Popen(
        [sys.executable, "-m", "harness_daemon", "--port", "0"],
        cwd=DAEMON_DIR,
        env=env,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        ready = json.loads(proc.stdout.readline())
        assert ready["event"] == "ready" and ready["host"] == "127.0.0.1" and ready["port"] > 0
        assert "token" not in ready  # The token came from the environment. Do not print it.
        with connect(f"ws://127.0.0.1:{ready['port']}/ws") as ws:
            ws.send(json.dumps({"type": "auth", "token": "sidecar-token"}))
            ws.send(json.dumps({"type": "session.new", "cwd": str(project), "model": "fake/m"}))
            ws.send(json.dumps({"type": "prompt", "text": "ping"}))
            text = ""
            while True:
                msg = json.loads(ws.recv(timeout=15))
                if msg["type"] == "token":
                    text += msg["text"]
                if msg["type"] == "turn.end":
                    break
            assert text == "pong"
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def test_daemon_stops_when_stdin_closes(harness_home, project, fake_model):
    env = dict(os.environ, HARNESS_TOKEN="sidecar-token", HARNESS_HOME=str(harness_home))
    proc = subprocess.Popen(
        [sys.executable, "-m", "harness_daemon", "--exit-on-stdin-eof"],
        cwd=DAEMON_DIR,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        ready = json.loads(proc.stdout.readline())
        # An open connection must not keep the daemon alive.
        with connect(f"ws://127.0.0.1:{ready['port']}/ws") as ws:
            ws.send(json.dumps({"type": "auth", "token": "sidecar-token"}))
            assert json.loads(ws.recv(timeout=10))["type"] == "auth.ok"
            proc.stdin.close()
            assert proc.wait(timeout=15) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
