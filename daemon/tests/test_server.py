from __future__ import annotations

import json
import socket
import threading
import time

import pytest
import uvicorn
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import connect

from harness_daemon.server import create_app
from harness_daemon.storage import Storage

TOKEN = "test-token"


@pytest.fixture
def daemon(harness_home, tmp_path):
    storage = Storage(tmp_path / "daemon.db")
    app = create_app(token=TOKEN, storage=storage)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.02)
    yield f"ws://127.0.0.1:{port}/ws"
    server.should_exit = True
    thread.join(timeout=10)
    storage.close()


class Client:
    def __init__(self, url: str, token: str = TOKEN):
        self._conn = connect(url)
        self.ws = self._conn.__enter__()
        self.send({"type": "auth", "token": token})

    def send(self, msg: dict) -> None:
        self.ws.send(json.dumps(msg))

    def recv(self, timeout: float = 10) -> dict:
        return json.loads(self.ws.recv(timeout=timeout))

    def until(self, kind: str, timeout: float = 10) -> tuple[dict, list[dict]]:
        seen = []
        deadline = time.time() + timeout
        while True:
            msg = self.recv(max(deadline - time.time(), 0.01))
            seen.append(msg)
            if msg["type"] == kind:
                return msg, seen

    def new_session(self, project, model="fake/test-model") -> dict:
        self.until("auth.ok")
        self.send({"type": "session.new", "cwd": str(project), "model": model})
        return self.until("session.ready")[0]

    def until_status(self, name: str, state: str, timeout: float = 20) -> tuple[dict, list[dict]]:
        """Wait for a server.status message of one server in one state."""
        seen = []
        deadline = time.time() + timeout
        while True:
            msg = self.recv(max(deadline - time.time(), 0.01))
            seen.append(msg)
            if msg["type"] == "server.status" and msg["name"] == name and msg["state"] == state:
                return msg, seen

    def collect_logs(self, name: str, until, timeout: float = 10) -> dict[str, str]:
        """Collect the server.log text of one server until ``until(all text)`` is true."""
        logs = {"stdout": "", "stderr": ""}
        deadline = time.time() + timeout
        while not until(logs["stdout"] + logs["stderr"]):
            msg = self.recv(max(deadline - time.time(), 0.01))
            if msg["type"] == "server.log" and msg["name"] == name:
                logs[msg["stream"]] += msg["text"] + "\n"
        return logs

    def close(self) -> None:
        self._conn.__exit__(None, None, None)


def test_bad_token_closes_the_socket(daemon):
    with connect(daemon) as ws:
        ws.send(json.dumps({"type": "auth", "token": "wrong"}))
        with pytest.raises(ConnectionClosed) as info:
            ws.recv(timeout=5)
    assert info.value.rcvd.code == 4401


def test_client_that_leaves_before_auth_does_not_break_the_daemon(daemon, project, fake_model):
    with connect(daemon):
        pass  # Close before the auth message, like a page reload.
    c = Client(daemon)
    assert c.recv()["type"] == "auth.ok"
    c.close()


def test_first_message_must_be_auth(daemon):
    with connect(daemon) as ws:
        ws.send(json.dumps({"type": "prompt", "text": "hi"}))
        with pytest.raises(ConnectionClosed):
            ws.recv(timeout=5)


def test_prompt_streams_and_resume_restores_history(daemon, project, fake_model):
    fake_model.script({"text": "Hello there."})
    c = Client(daemon)
    ready = c.new_session(project)
    assert ready["model"] == "fake/test-model" and ready["warnings"] == [] and ready["history"] == []
    c.send({"type": "prompt", "text": "Say hello"})
    end, seen = c.until("turn.end")
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "Hello there."
    assert end["stop_reason"] == "end" and end["usage"]["prompt_tokens"] == 100
    c.close()

    c2 = Client(daemon)
    c2.until("auth.ok")
    c2.send({"type": "session.list"})
    sessions = c2.until("sessions")[0]["items"]
    assert sessions[0]["id"] == ready["session_id"] and sessions[0]["title"] == "Say hello"
    c2.send({"type": "session.resume", "session_id": ready["session_id"]})
    resumed = c2.until("session.ready")[0]
    assert [m["role"] for m in resumed["history"]] == ["user", "assistant"]
    assert resumed["history"][1]["content"] == "Hello there."
    c2.close()


def test_permission_request_and_reply(daemon, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'hey'"}}]},
        {"text": "Changed."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "edit it"})
    request, seen = c.until("permission.request")
    assert any(m["type"] == "tool.start" for m in seen)
    assert request["tool"] == "edit" and "+    return 'hey'" in request["diff"]
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_always"})
    end, seen = c.until("turn.end")
    kinds = [m["type"] for m in seen]
    assert kinds.index("tool.result") < kinds.index("fs.changed") < kinds.index("turn.end")
    assert "'hey'" in (project / "hello.py").read_text()
    rules = json.loads((project / ".harness" / "settings.json").read_text())
    assert rules["allow"] == ["edit(hello.py)"]
    c.close()


def test_interrupt(daemon, project, fake_model):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["bash(sleep 30)"]}))
    fake_model.script({"tool_calls": [{"name": "bash", "arguments": {"command": "sleep 30"}}]})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "wait"})
    c.until("tool.start")
    c.send({"type": "prompt", "text": "second prompt"})
    busy = c.until("error")[0]
    assert "A turn is running" in busy["message"]
    start = time.time()
    c.send({"type": "interrupt"})
    end, seen = c.until("turn.end")
    # The limit is generous: taskkill is slow on a busy Windows computer.
    assert end["stop_reason"] == "interrupted" and time.time() - start < 20
    assert any(m["type"] == "tool.result" and m["is_error"] for m in seen)
    c.close()


def test_editor_files_and_conflict(daemon, project, fake_model):
    (project / "src").mkdir()
    (project / "src" / "app.py").write_bytes(b"x = 1\n")
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "fs.list", "path": "."})
    tree = c.until("fs.tree")[0]
    assert [i["name"] for i in tree["items"]] == ["src", "hello.py"]

    c.send({"type": "fs.read", "path": "src/app.py"})
    content = c.until("fs.content")[0]
    assert content["content"] == "x = 1\n"

    c.send({"type": "fs.write", "path": "src/app.py", "content": "x = 2\n", "base_hash": content["hash"]})
    saved = c.until("fs.saved")[0]
    assert (project / "src" / "app.py").read_bytes() == b"x = 2\n"

    # The editor still has the first hash. The file changed, so the daemon must not save.
    c.send({"type": "fs.write", "path": "src/app.py", "content": "x = 3\n", "base_hash": content["hash"]})
    conflict = c.until("fs.conflict")[0]
    assert conflict["disk_hash"] == saved["hash"]
    assert (project / "src" / "app.py").read_text() == "x = 2\n"

    c.send({"type": "fs.read", "path": "../outside.txt"})
    assert "outside the project" in c.until("error")[0]["message"]
    c.close()


def test_commands(daemon, project, fake_model):
    fake_model.script({"text": "one"})
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "command", "name": "help", "args": ""})
    assert "/clear" in c.until("command.result")[0]["text"]

    c.send({"type": "command", "name": "model", "args": "fake/other-model"})
    assert c.until("command.result")[0]["model"] == "fake/other-model"
    c.send({"type": "prompt", "text": "hi"})
    c.until("turn.end")
    assert fake_model.requests[-1]["model"] == "other-model"

    c.send({"type": "command", "name": "clear", "args": ""})
    c.until("command.result")
    c.send({"type": "session.resume", "session_id": ready["session_id"]})
    resumed = c.until("session.ready")[0]
    assert resumed["history"] == [] and resumed["model"] == "fake/other-model"

    c.send({"type": "command", "name": "nope", "args": ""})
    assert "Unknown command" in c.until("error")[0]["message"]
    c.close()


def test_errors_for_bad_messages(daemon, project, fake_model):
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "prompt", "text": "hi"})
    assert "No session" in c.until("error")[0]["message"]
    c.send({"type": "hf.search", "query": "qwen", "sort": "size"})
    assert "The sort must be one of" in c.until("error")[0]["message"]
    c.send({"type": "no.such.type"})
    assert "Unknown message type" in c.until("error")[0]["message"]
    c.send({"type": "session.new", "cwd": "relative/path", "model": "fake/m"})
    assert "absolute" in c.until("error")[0]["message"]
    c.ws.send("not json")
    assert "not valid JSON" in c.until("error")[0]["message"]
    c.send({"type": "skills.list"})
    assert any(i["name"] == "help" for i in c.until("skills")[0]["items"])
    c.close()


def test_warning_for_model_without_tools(daemon, project, fake_model):
    fake_model.capabilities = ["completion"]
    c = Client(daemon)
    ready = c.new_session(project)
    assert "does not support tool calls" in ready["warnings"][0]
    c.close()


def test_edit_request_has_rule_and_result_has_diff(daemon, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'yo'"}}]},
        {"text": "Done."},
    )
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "prompt", "text": "edit"})
    request = c.until("permission.request")[0]
    assert request["rule"] == "edit(hello.py)"
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    result = c.until("tool.result")[0]
    assert "+    return 'yo'" in result["diff"]
    c.until("turn.end")
    # The diff is in the stored history for the client, but not in the model request.
    assert all("diff" not in m for m in fake_model.requests[-1]["messages"])
    c.send({"type": "session.resume", "session_id": ready["session_id"]})
    history = c.until("session.ready")[0]["history"]
    assert "+    return 'yo'" in next(m for m in history if m["role"] == "tool")["diff"]
    c.close()


def test_permission_rules_get_and_set(daemon, project, fake_model):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["bash(ls)"], "max_tool_calls": 7}))
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "permissions.get"})
    rules = c.until("permissions")[0]
    assert rules == {"type": "permissions", "path": ".harness/settings.json", "allow": ["bash(ls)"], "deny": []}

    c.send({"type": "permissions.set", "allow": ["bash(ls)", "edit(src/*)", "bash(ls)"], "deny": ["bash(rm:*)"]})
    rules = c.until("permissions")[0]
    assert rules["allow"] == ["bash(ls)", "edit(src/*)"] and rules["deny"] == ["bash(rm:*)"]
    data = json.loads((project / ".harness" / "settings.json").read_text())
    assert data["max_tool_calls"] == 7  # Other settings stay.

    c.send({"type": "permissions.set", "allow": ["not a rule!"], "deny": []})
    assert "Not a valid rule" in c.until("error")[0]["message"]
    c.close()
