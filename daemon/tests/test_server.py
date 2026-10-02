from __future__ import annotations

import json
from pathlib import Path
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
            # A crash, or a start that failed (for example, the port is in use), gives no further
            # status. Stop now, and show the error and the logs.
            if (msg["type"] == "server.status" and msg["name"] == name and msg["state"] != state
                    and (msg["state"] == "crashed" or (msg["state"] == "stopped" and msg.get("error")))):
                logs = "\n".join(m["text"] for m in seen if m["type"] == "server.log" and m["name"] == name)
                raise AssertionError(f"'{name}' is {msg['state']}, not {state}: {msg.get('error')}\nLogs:\n{logs}")

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
    usage = [m for m in seen if m["type"] == "turn.usage"]
    assert usage and usage[-1]["completion_tokens"] == 10
    # The model makes the title from the first prompt. It can come before or after turn.end.
    title = next((m for m in seen if m["type"] == "session.title"), None) or c.until("session.title")[0]
    assert title == {"type": "session.title", "id": ready["session_id"], "title": "Fake session title"}
    assert "Say hello" in fake_model.title_requests[0]["messages"][0]["content"]
    c.close()

    c2 = Client(daemon)
    c2.until("auth.ok")
    c2.send({"type": "session.list"})
    sessions = c2.until("sessions")[0]["items"]
    assert sessions[0]["id"] == ready["session_id"] and sessions[0]["title"] == "Fake session title"
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


def test_steer_through_the_protocol(daemon, project, fake_model):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["bash(sleep 2)"]}))
    fake_model.script(
        {"tool_calls": [{"name": "bash", "arguments": {"command": "sleep 2"}}]},
        {"text": "OK."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "steer", "id": "early", "text": "no turn yet"})
    assert c.until("steer.returned")[0]["ids"] == ["early"]
    c.send({"type": "prompt", "text": "wait"})
    c.until("tool.start")
    c.send({"type": "steer", "id": "s1", "text": "Then say OK.", "display": "say OK"})
    end, seen = c.until("turn.end")
    assert end["stop_reason"] == "end"
    taken = next(m for m in seen if m["type"] == "steer.taken")
    assert (taken["id"], taken["text"]) == ("s1", "say OK")
    assert fake_model.requests[-1]["messages"][-1] == {"role": "user", "content": "Then say OK."}
    c.close()


def test_return_to_a_session_with_a_running_turn(daemon, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'hey'"}}]},
        {"text": "Changed."},
    )
    c = Client(daemon)
    first = c.new_session(project)
    c.send({"type": "prompt", "text": "edit it"})
    request, seen = c.until("permission.request")
    assert request["session_id"] == first["session_id"]
    running = [m for m in seen if m["type"] == "sessions.running"]
    assert running[-1]["items"] == [{"session_id": first["session_id"], "waiting": True}]

    # Go to a new session. The turn of the first session waits in the background.
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    second, seen = c.until("session.ready")
    assert second["session_id"] != first["session_id"] and not second["running"]
    assert not [m for m in seen if m["type"] == "error"]

    # Return to the first session. The client gets the open request again.
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    back = c.until("session.ready")[0]
    assert back["running"] and back["requests"][0]["request_id"] == request["request_id"]
    assert [m["role"] for m in back["history"]] == ["user", "assistant"]
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    end, seen = c.until("turn.end")
    assert end["session_id"] == first["session_id"] and end["stop_reason"] == "end"
    assert "'hey'" in (project / "hello.py").read_text()
    idle = c.until("sessions.running")[0]
    assert idle["items"] == []
    c.close()


def test_turn_in_the_background_completes(daemon, project, fake_model):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["bash(sleep 2)"]}))
    fake_model.script({"tool_calls": [{"name": "bash", "arguments": {"command": "sleep 2"}}]}, {"text": "Done."})
    c = Client(daemon)
    first = c.new_session(project)
    c.send({"type": "prompt", "text": "wait"})
    c.until("tool.start")
    c.send({"type": "session.leave"})  # The start screen.
    # The client gets no events of the turn, only the running sessions (and the title, for the sidebar).
    msg, seen = c.until("sessions.running", timeout=20)
    while msg["items"]:
        msg, more = c.until("sessions.running", timeout=20)
        seen += more
    assert {m["type"] for m in seen} <= {"sessions.running", "session.title"}
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    back = c.until("session.ready")[0]
    assert not back["running"]
    assert back["history"][-1] == {"role": "assistant", "content": "Done."}
    c.close()


def _term_text(c: Client, marker: str, timeout: float = 20) -> str:
    """The terminal output until it has ``marker``."""
    text = ""
    deadline = time.time() + timeout
    while marker not in text:
        msg = c.recv(max(deadline - time.time(), 0.01))
        if msg["type"] == "term.output":
            text += msg["data"]
    return text


def test_terminal_tabs_have_their_own_shells(daemon, project, fake_model):
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "term.open", "cols": 80, "rows": 24, "ref": "tab-a"})
    a = c.until("term.opened")[0]
    c.send({"type": "term.open", "cols": 80, "rows": 24, "new": True, "ref": "tab-b"})
    b = c.until("term.opened")[0]
    assert (a["ref"], b["ref"]) == ("tab-a", "tab-b") and a["new"] and b["new"] and a["id"] != b["id"]
    c.send({"type": "term.input", "id": b["id"], "data": "echo tab-b-ok\r"})
    _term_text(c, "tab-b-ok")
    # Each tab opens its own shell again.
    c.send({"type": "term.open", "cols": 80, "rows": 24, "id": a["id"]})
    assert c.until("term.opened")[0]["id"] == a["id"]
    c.send({"type": "term.close", "id": b["id"]})
    c.send({"type": "term.input", "id": b["id"], "data": "x"})
    assert "Unknown terminal" in c.until("error")[0]["message"]
    c.close()


def test_terminal_runs_a_shell_and_stays_open_in_the_background(daemon, project, fake_model):
    c = Client(daemon)
    first = c.new_session(project)
    c.send({"type": "term.open", "cols": 80, "rows": 24})
    opened = c.until("term.opened")[0]
    assert opened["new"] and opened["session_id"] == first["session_id"]
    c.send({"type": "term.input", "id": opened["id"], "data": "echo harness-term-ok\r"})
    _term_text(c, "harness-term-ok")
    c.send({"type": "term.resize", "id": opened["id"], "cols": 100, "rows": 30})

    # Go to a new session. The shell of the first session keeps running.
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    c.until("session.ready")
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    c.until("session.ready")
    c.send({"type": "term.open", "cols": 80, "rows": 24})
    again = c.until("term.opened")[0]
    assert again["id"] == opened["id"] and not again["new"]
    assert "harness-term-ok" in again["replay"] and again["seq"] >= 1 and again["reset"]
    # A client that has the screen gets only the output after its last output number.
    c.send({"type": "term.open", "cols": 80, "rows": 24, "id": opened["id"], "since": again["seq"]})
    delta = c.until("term.opened")[0]
    assert not delta["reset"] and "harness-term-ok" not in delta["replay"]

    c.send({"type": "term.input", "id": opened["id"], "data": "exit\r"})
    end = c.until("term.exit", timeout=20)[0]
    assert end["id"] == opened["id"]
    c.close()


def test_session_switch_uses_the_saved_model_checks(daemon, project, fake_model, monkeypatch):
    from harness_daemon import server
    calls = []
    real = server.resolve_context_length

    async def counted(*args, **kwargs):
        calls.append(args[1])
        return await real(*args, **kwargs)
    monkeypatch.setattr(server, "resolve_context_length", counted)
    c = Client(daemon)
    first = c.new_session(project)
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    c.until("session.ready")
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    c.until("session.ready")
    assert calls == ["test-model"]
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


def test_unexpected_turn_error_ends_the_turn(daemon, project, fake_model, monkeypatch):
    from harness_daemon.agent import Agent

    async def boom(self, *args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(Agent, "run_turn", boom)
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "hi"})
    end, seen = c.until("turn.end")
    assert end["stop_reason"] == "error"
    assert any(m["type"] == "error" and "RuntimeError: boom" in m["message"] for m in seen)
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


def test_rename_pin_and_delete_a_session(daemon, project, fake_model):
    c = Client(daemon)
    first = c.new_session(project)
    c.send({"type": "session.list"})
    before = c.until("sessions")[0]["items"][0]
    assert before["pinned"] is False
    c.send({"type": "session.update", "session_id": first["session_id"], "title": "  My task  ", "pinned": True})
    updated = c.until("session.updated")[0]
    assert updated == {"type": "session.updated", "id": first["session_id"], "title": "My task", "pinned": True,
                       "archived": False}
    c.send({"type": "session.update", "session_id": first["session_id"], "archived": True})
    assert c.until("session.updated")[0]["archived"] is True
    c.send({"type": "session.list"})
    after = c.until("sessions")[0]["items"][0]
    assert after["title"] == "My task" and after["pinned"] is True and after["archived"] is True
    assert after["updated_at"] == before["updated_at"]  # A rename does not change the age.
    c.send({"type": "session.update", "session_id": first["session_id"], "title": " "})
    assert "empty" in c.until("error")[0]["message"]

    # Delete the open session: its events stop, and the session is gone.
    c.send({"type": "session.delete", "session_id": first["session_id"]})
    assert c.until("session.deleted")[0]["id"] == first["session_id"]
    c.send({"type": "session.list"})
    assert all(s["id"] != first["session_id"] for s in c.until("sessions")[0]["items"])
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    assert "Unknown session" in c.until("error")[0]["message"]
    c.close()


def test_move_a_session_to_another_folder(daemon, project, fake_model, tmp_path):
    other = tmp_path / "other-project"
    other.mkdir()
    fake_model.script({"text": "Hello."})
    c = Client(daemon)
    first = c.new_session(project)
    c.send({"type": "prompt", "text": "hi"})
    c.until("turn.end")
    c.send({"type": "session.move", "session_id": first["session_id"], "cwd": str(other)})
    moved = c.until("session.ready")[0]
    assert moved["session_id"] == first["session_id"] and Path(moved["cwd"]) == other.resolve()
    assert [m["role"] for m in moved["history"]] == ["user", "assistant"]  # The history stays.
    c.send({"type": "session.move", "session_id": first["session_id"], "cwd": str(tmp_path / "missing")})
    assert "does not exist" in c.until("error")[0]["message"]
    c.close()


def test_user_settings_need_no_session(daemon, harness_home, project, fake_model):
    c = Client(daemon)
    c.send({"type": "user_settings.get"})
    got = c.until("user_settings")[0]
    assert got["values"]["prompt_suggestions"] is True and got["path"].endswith("settings.json")
    c.send({"type": "user_settings.set", "values": {"prompt_suggestions": False, "max_tool_calls": 80,
                                                     "terminal_shell": "pwsh.exe"}})
    got = c.until("user_settings")[0]["values"]
    assert (got["prompt_suggestions"], got["max_tool_calls"], got["terminal_shell"]) == (False, 80, "pwsh.exe")
    c.send({"type": "user_settings.set", "values": {"terminal_shell": None}})
    assert c.until("user_settings")[0]["values"]["terminal_shell"] is None
    c.send({"type": "user_settings.set", "values": {"max_tool_calls": True}})
    assert "must be int" in c.until("error")[0]["message"]
    c.send({"type": "user_settings.set", "values": {"bash_timeout": 0}})
    assert "from 1 to 3600" in c.until("error")[0]["message"]
    c.close()


def test_rewind_and_fork(daemon, project, fake_model):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"allow": ["edit", "write"]}))
    original = (project / "hello.py").read_text()
    fake_model.script(
        {"tool_calls": [{"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'hey'"}}]},
        {"text": "Edited."},
        {"tool_calls": [{"name": "write", "arguments": {"path": "new.txt", "content": "new"}}]},
        {"text": "Written."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "change hello", "id": "p1"})
    c.until("turn.end")
    c.send({"type": "prompt", "text": "make a file", "id": "p2"})
    c.until("turn.end")
    assert "'hey'" in (project / "hello.py").read_text() and (project / "new.txt").exists()

    # A fork has the conversation before the message, and the message text goes to the prompt box.
    c.send({"type": "session.fork", "id": "p2"})
    ready = c.until("session.ready")[0]
    assert [m["content"] for m in ready["history"] if m["role"] == "user"] == ["change hello"]
    assert c.until("prompt.fill")[0]["text"] == "make a file"
    assert (project / "new.txt").exists()  # A fork does not change files.

    # Rewind in the fork to p1: the code and the conversation go back to the start.
    c.send({"type": "session.rewind", "id": "p1", "conversation": True, "code": True})
    ready = c.until("session.ready")[0]
    assert ready["history"] == []
    assert c.until("prompt.fill")[0]["text"] == "change hello"
    assert (project / "hello.py").read_text() == original
    assert (project / "new.txt").exists()  # new.txt came after the fork point.

    # The first session: rewind only the code of p2. The conversation stays.
    first = ready["session_id"]
    c.send({"type": "session.list"})
    sessions = c.until("sessions")[0]["items"]
    source = next(s["id"] for s in sessions if s["id"] != first)
    c.send({"type": "session.resume", "session_id": source})
    c.until("session.ready")
    c.send({"type": "session.rewind", "id": "p2", "conversation": False, "code": True})
    notice = c.until("notice")[0]
    assert "1 file restored" in notice["text"]
    assert not (project / "new.txt").exists()
    c.send({"type": "session.rewind", "id": "missing", "conversation": True})
    assert "not in the context" in c.until("error")[0]["message"]
    c.close()


def test_ping(daemon):
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "ping"})
    assert c.until("pong")[0]["type"] == "pong"
    c.close()


def test_update_refused_without_enable(daemon):
    from harness_daemon import update

    update.enable([], sidecar=True)
    c = Client(daemon)
    ok = c.until("auth.ok")[0]
    assert ok["updatable"] is False
    c.send({"type": "daemon.update", "filename": "harness_daemon-9.9.9-py3-none-any.whl", "data": ""})
    assert "cannot update itself" in c.until("error")[0]["message"]
    c.close()
