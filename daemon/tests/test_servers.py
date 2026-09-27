"""Tests for launch.json, the server manager, the port forward, and the project file URLs."""

from __future__ import annotations

import json
import socket
import sys
import time
from pathlib import Path

import httpx
import pytest
from websockets.sync.client import connect

from harness_daemon.config import ConfigError
from harness_daemon.launch import load_launch, propose, save_launch

from test_server import TOKEN, Client, daemon  # noqa: F401 - the daemon fixture

DEV_SERVER = Path(__file__).with_name("dev_server.py").as_posix()
PYTHON = Path(getattr(sys, "_base_executable", sys.executable)).as_posix()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def command(port: int, crash: bool = False) -> str:
    return f'"{PYTHON}" "{DEV_SERVER}" {port}{" crash" if crash else ""}'


# -- launch.json ------------------------------------------------------------------------


def test_launch_json_is_checked(project):
    assert load_launch(project) is None
    save_launch(project, [{"name": "web", "command": "npm run dev", "port": 5173, "default": True}])
    [server] = load_launch(project)
    assert (server.name, server.port, server.default, server.cwd) == ("web", 5173, True, ".")
    for bad, message in [
        ([{"name": "a b", "command": "x"}], "name"),
        ([{"name": "a", "command": ""}], "command"),
        ([{"name": "a", "command": "x", "port": 70000}], "port"),
        ([{"name": "a", "command": "x", "ready_pattern": "("}], "ready_pattern"),
        ([{"name": "a", "command": "x", "cwd": "../outside"}], "outside"),
        ([{"name": "a", "command": "x"}, {"name": "a", "command": "y"}], "same name"),
    ]:
        with pytest.raises(ConfigError, match=message):
            save_launch(project, bad)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.mark.parametrize("files,expected", [
    ({"package.json": '{"scripts": {"dev": "vite"}}', "pnpm-lock.yaml": ""}, ("pnpm run dev", 5173)),
    ({"package.json": '{"scripts": {"dev": "next dev"}}'}, ("npm run dev", 3000)),
    ({"package.json": '{"scripts": {"dev": "vite"}}', "yarn.lock": ""}, ("yarn dev", 5173)),
    ({"vite.config.ts": ""}, ("npx vite", 5173)),
    ({"next.config.js": ""}, ("npx next dev", 3000)),
    ({"manage.py": ""}, ("python manage.py runserver", 8000)),
    ({"main.py": "from fastapi import FastAPI\napp = FastAPI()\n"}, ("uvicorn main:app --reload --port 8000", 8000)),
    ({"app.py": "from flask import Flask\napp = Flask(__name__)\n"}, ("flask run", 5000)),
    ({"index.html": "<h1>hi</h1>"}, ("python -m http.server 8080 --bind 127.0.0.1", 8080)),
])
def test_proposal_table(tmp_path, files, expected):
    for name, text in files.items():
        write(tmp_path / name, text)
    [server] = propose(tmp_path)
    assert (server.command, server.port) == expected and server.default


def test_proposal_with_a_frontend_and_a_backend(tmp_path):
    write(tmp_path / "frontend" / "package.json", '{"scripts": {"dev": "vite"}}')
    write(tmp_path / "backend" / "main.py", "from fastapi import FastAPI\napp = FastAPI()\n")
    servers = propose(tmp_path)
    assert [(s.name, s.cwd, s.default) for s in servers] == [("web", "frontend", True), ("api", "backend", False)]
    assert propose(tmp_path / "missing") == []


# -- the server manager through the protocol ----------------------------------------------------


def http_base(ws_url: str) -> str:
    return ws_url.replace("ws://", "http://").removesuffix("/ws")


def test_server_lifecycle_approval_logs_and_forward(daemon, project, fake_model):  # noqa: F811
    port = free_port()
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "server.list"})
    listing = c.until("servers")[0]
    assert listing["config"] == "missing" and listing["items"] == []

    c.send({"type": "server.save", "servers": [
        {"name": "web", "command": command(port), "port": port, "ready_pattern": "Local:.*http", "default": True},
    ]})
    listing = c.until("servers")[0]
    assert listing["config"] == "exists" and listing["items"][0]["state"] == "stopped"
    assert json.loads((project / ".harness" / "launch.json").read_text())["servers"][0]["name"] == "web"

    # The first start needs approval. "Always" adds a server(<command>) rule.
    c.send({"type": "server.start", "name": "web"})
    request = c.until("permission.request")[0]
    assert request["tool"] == "server" and request["rule"] == f"server({command(port)})"
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_always"})
    running, seen = c.until_status("web", "running")
    assert running["url"] == f"http://127.0.0.1:{port}/" and running["port"] == port
    assert any(m["type"] == "server.status" and m["state"] == "starting" for m in seen)
    logs = c.collect_logs("web", until=lambda text: "a warning on stderr" in text)
    assert "Local:" in logs["stdout"] and "a warning on stderr" in logs["stderr"]

    # The forward endpoint carries the TCP bytes of an HTTP request to the server port.
    with connect(daemon.replace("/ws", "/forward")) as fw:
        fw.send(json.dumps({"type": "auth", "token": TOKEN}))
        fw.send(json.dumps({"type": "forward", "session_id": ready["session_id"], "server": "web"}))
        assert json.loads(fw.recv(timeout=5)) == {"type": "forward.ok"}
        fw.send(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        received = b""
        while b"hello from the dev server" not in received:
            received += fw.recv(timeout=5)
        assert received.startswith(b"HTTP/1.0 200")

    # A server that is not in launch.json cannot be reached.
    with connect(daemon.replace("/ws", "/forward")) as fw:
        fw.send(json.dumps({"type": "auth", "token": TOKEN}))
        fw.send(json.dumps({"type": "forward", "session_id": ready["session_id"], "server": "other"}))
        assert "not in launch.json" in json.loads(fw.recv(timeout=5))["message"]

    c.send({"type": "server.logs", "name": "web"})
    history = c.until("server.logs")[0]
    assert {line["stream"] for line in history["lines"]} == {"stdout", "stderr"}

    c.send({"type": "server.stop", "name": "web"})
    c.until_status("web", "stopped")
    assert not port_open(port)

    # The rule is saved: the second start needs no approval.
    c.send({"type": "server.start", "name": "web"})
    c.until_status("web", "running")
    c.close()
    # The session closed: the daemon stops the servers that it started.
    deadline = time.time() + 15
    while port_open(port) and time.time() < deadline:
        time.sleep(0.2)
    assert not port_open(port)


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def test_port_in_use_crash_and_deny(daemon, project, fake_model):  # noqa: F811
    busy = socket.socket()
    busy.bind(("127.0.0.1", 0))
    busy.listen()
    busy_port = busy.getsockname()[1]
    crash_port = free_port()
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["server"]}))
    save_launch(project, [
        {"name": "busy", "command": command(busy_port), "port": busy_port},
        {"name": "bad", "command": command(crash_port, crash=True), "port": crash_port},
    ])
    c = Client(daemon)
    c.new_session(project)
    try:
        c.send({"type": "server.start", "name": "busy"})
        status = c.until("server.status")[0]
        assert status["state"] == "stopped" and "in use" in status["error"]

        c.send({"type": "server.start", "name": "bad"})
        crashed, _ = c.until_status("bad", "crashed")
        assert "exit code 3" in crashed["error"]
        assert any("something is wrong" in line["text"] for line in crashed["last_lines"])
    finally:
        busy.close()
        c.close()


def test_denied_start(daemon, project, fake_model):  # noqa: F811
    save_launch(project, [{"name": "web", "command": command(free_port())}])
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "server.start", "name": "web"})
    request = c.until("permission.request")[0]
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "deny"})
    status = c.until("server.status")[0]
    assert status["state"] == "stopped" and "denied" in status["error"]
    c.close()


def test_preview_command_starts_the_default_server(daemon, project, fake_model):  # noqa: F811
    port = free_port()
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["server"]}))
    save_launch(project, [
        {"name": "api", "command": command(free_port()), "port": free_port()},
        {"name": "web", "command": command(port), "port": port, "ready_pattern": "Local:", "default": True},
    ])
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "command", "name": "preview", "args": ""})
    result = c.until("command.result")[0]
    assert result["action"] == "preview" and result["server"] == "web"
    c.until_status("web", "running")
    c.close()


def test_project_files_for_the_browser(daemon, project, fake_model):  # noqa: F811
    (project / "site").mkdir()
    (project / "site" / "index.html").write_text("<h1>Site</h1>", encoding="utf-8")
    (project / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
    c = Client(daemon)
    ready = c.new_session(project)
    token = ready["files_token"]
    base = http_base(daemon)
    page = httpx.get(f"{base}/files/{token}/site/index.html")
    assert page.status_code == 200 and page.text == "<h1>Site</h1>"
    assert page.headers["content-type"].startswith("text/html")
    assert "sandbox" in page.headers["content-security-policy"]
    assert httpx.get(f"{base}/files/{token}/site/").text == "<h1>Site</h1>"  # A folder serves index.html.
    # A path out of the project is never served. (A client normalizes "../", so send it encoded.)
    (project.parent / "outside.txt").write_text("secret", encoding="utf-8")
    assert httpx.get(f"{base}/files/{token}/%2e%2e/outside.txt").status_code == 404
    assert "secret" not in httpx.get(f"{base}/files/{token}/../outside.txt", follow_redirects=True).text
    assert httpx.get(f"{base}/files/wrong-token/site/index.html").status_code == 404
    c.close()
    time.sleep(0.5)
    assert httpx.get(f"{base}/files/{token}/site/index.html").status_code == 404  # The session closed.
