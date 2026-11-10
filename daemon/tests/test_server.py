from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import stat
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
            try:
                msg = self.recv(max(deadline - time.time(), 0.01))
            except TimeoutError:
                got = [{k: v for k, v in m.items() if k in ("type", "name", "state", "error", "stream", "text")}
                       for m in seen]
                raise AssertionError(f"No '{state}' status of '{name}' in {timeout} s. Messages: {got}") from None
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
    assert "Say hello" in fake_model.title_requests[0]["messages"][-1]["content"]
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
    # Keys for a closed shell: the client learns that the shell stopped. A resize is no error.
    c.send({"type": "term.resize", "id": b["id"], "cols": 90, "rows": 30})
    c.send({"type": "term.input", "id": b["id"], "data": "x"})
    gone, seen = c.until("term.exit")
    assert gone["id"] == b["id"] and gone["code"] is None
    assert not [m for m in seen if m["type"] == "error"]
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
    # The checks run after the open, in the background: one time for the three opens.
    deadline = time.monotonic() + 10
    while not calls and time.monotonic() < deadline:
        time.sleep(0.05)
    time.sleep(0.3)
    assert calls == ["test-model"]
    c.close()


def test_a_failed_context_check_runs_again_before_the_next_turn(daemon, project, fake_model, monkeypatch):
    from harness_daemon import server
    from harness_daemon.providers import DEFAULT_CONTEXT_LENGTH, ContextInfo
    answers = [ContextInfo(DEFAULT_CONTEXT_LENGTH, "default", "The context length of test-model is unknown."),
               ContextInfo(1048576, "model list")]

    async def flaky(*args, **kwargs):
        return answers.pop(0)
    monkeypatch.setattr(server, "resolve_context_length", flaky)
    fake_model.script({"text": "Hi."})
    c = Client(daemon)
    c.new_session(project)
    assert "is unknown" in c.until("session.model_info")[0]["warnings"][0]
    # The default is not saved: the turn checks again, and the session gets the real context length.
    c.send({"type": "prompt", "text": "hi"})
    info, _ = c.until("session.model_info")
    assert (info["context_length"], info["context_source"]) == (1048576, "model list")
    c.until("turn.end")
    assert answers == []
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
    switched = c.until("command.result")[0]
    assert switched["model"] == "fake/other-model"
    assert "text" not in switched  # A switch shows only in the model label, not in the chat.
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


def test_session_with_a_removed_provider_opens(daemon, project, fake_model, harness_home):
    """An old session whose provider is gone opens with its stored model. A prompt fails with a
    clear error. A switch to an available model works for the next turn."""
    c = Client(daemon)
    first = c.new_session(project)
    c.close()
    providers = json.loads((harness_home / "providers.json").read_text())
    (harness_home / "providers.json").write_text(json.dumps({"other": providers["fake"]}))

    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    ready = c.until("session.ready")[0]
    assert ready["model"] == "fake/test-model"
    assert ready["model_unavailable"] == "Unknown provider: fake"
    assert ready["warnings"] == []  # The chat prompt of the client tells the user.

    c.send({"type": "prompt", "text": "hi"})
    error, _ = c.until("error")
    assert "Unknown provider: fake" in error["message"]
    c.until("turn.end")

    fake_model.script({"text": "one"})
    c.send({"type": "command", "name": "model", "args": "other/test-model"})
    assert c.until("command.result")[0]["model"] == "other/test-model"
    c.send({"type": "prompt", "text": "hi"})
    c.until("turn.end")
    assert fake_model.requests[-1]["model"] == "test-model"
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    resumed = c.until("session.ready")[0]
    assert resumed["model"] == "other/test-model" and resumed["model_unavailable"] is None
    c.close()


def test_removed_provider_switches_by_network(daemon, project, fake_model, harness_home):
    """With "Preferred providers" on, an old session whose provider is gone gets the model
    by network when it opens. The chat shows nothing: only the model label changes."""
    c = Client(daemon)
    first = c.new_session(project)
    c.close()
    providers = json.loads((harness_home / "providers.json").read_text())
    (harness_home / "providers.json").write_text(json.dumps({"other": providers["fake"]}))
    (harness_home / "settings.json").write_text(json.dumps({
        "auto_model": True, "online_model": "other/online-model", "offline_model": "other/local-model"}))

    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    ready = c.until("session.ready")[0]
    assert ready["model"] == "other/online-model"
    assert ready["model_unavailable"] is None and ready["warnings"] == []
    c.close()

    c = Client(daemon)  # The new model is saved: the next open does not switch again.
    c.until("auth.ok")
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    assert c.until("session.ready")[0]["model"] == "other/online-model"
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
    c.new_session(project)
    # The checks of the endpoint run after the open: the warning comes just after session.ready.
    info = c.until("session.model_info")[0]
    assert "does not support tool calls" in info["warnings"][0]
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
    c.send({"type": "user_settings.set", "values": {"instructions_speaking": "Line one.\nLine two.\n"}})
    assert c.until("user_settings")[0]["values"]["instructions_speaking"] == "Line one.\nLine two."
    c.send({"type": "user_settings.set", "values": {"instructions_speaking": ""}})
    assert c.until("user_settings")[0]["values"]["instructions_speaking"] is None
    c.send({"type": "user_settings.set", "values": {"instructions_other": "x" * 10_001}})
    assert "10000 characters or less" in c.until("error")[0]["message"]
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


def test_the_editor_creates_files_and_folders(daemon, project, fake_model):
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "fs.create", "path": "src/new/helpers.py", "kind": "file"})
    created = c.until("fs.created")[0]
    assert (created["path"], created["kind"]) == ("src/new/helpers.py", "file")
    assert (project / "src" / "new" / "helpers.py").read_bytes() == b""
    c.send({"type": "fs.create", "path": r"docs\notes", "kind": "dir"})  # Windows separators too.
    assert c.until("fs.created")[0]["path"] == "docs/notes" and (project / "docs" / "notes").is_dir()
    # A name that exists, a path outside the project, and a bad kind are errors.
    c.send({"type": "fs.create", "path": "src/new/helpers.py", "kind": "file"})
    assert "exists already" in c.until("error")[0]["message"]
    c.send({"type": "fs.create", "path": "../outside.txt", "kind": "file"})
    assert "outside the project" in c.until("error")[0]["message"]
    c.send({"type": "fs.create", "path": "x", "kind": "link"})
    assert "'kind'" in c.until("error")[0]["message"]
    c.close()


def test_the_editor_renames_files_and_folders(daemon, project, fake_model, tmp_path):
    (project / "src" / "deep").mkdir(parents=True)
    (project / "src" / "deep" / "a.py").write_text("a")
    (project / "notes.txt").write_text("n")
    (project / "other.txt").write_text("o")
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "fs.rename", "path": "notes.txt", "name": "todo.md"})
    done = c.until("fs.renamed")[0]
    assert (done["path"], done["new_path"], done["kind"]) == ("notes.txt", "todo.md", "file")
    assert (project / "todo.md").read_text() == "n" and not (project / "notes.txt").exists()
    c.send({"type": "fs.rename", "path": "src\\deep", "name": "lib"})  # A folder keeps its files. Windows separators too.
    done = c.until("fs.renamed")[0]
    assert (done["new_path"], done["kind"]) == ("src/lib", "dir") and (project / "src" / "lib" / "a.py").read_text() == "a"
    c.send({"type": "fs.rename", "path": "todo.md", "name": "TODO.md"})  # A change of case only.
    assert c.until("fs.renamed")[0]["new_path"] == "TODO.md"
    # A name that exists, a path in the name, the session folder, a missing file, and a path outside are errors.
    for path, name, error in [
        ("TODO.md", "other.txt", "exists already"),
        ("TODO.md", "../x.md", "no / or"),
        ("TODO.md", "..", "no / or"),
        (".", "x", "Give a file"),
        ("missing.txt", "x.txt", "does not exist"),
        ("../outside.txt", "x.txt", "outside the project"),
    ]:
        c.send({"type": "fs.rename", "path": path, "name": name})
        assert error in c.until("error")[0]["message"]
    assert (project / "other.txt").read_text() == "o"
    c.close()


def test_the_editor_deletes_files_and_folders(daemon, project, fake_model, tmp_path, monkeypatch):
    from harness_daemon import trash
    monkeypatch.setattr(trash, "_recycle_windows", lambda path: False)  # Keep the Recycle Bin clean.
    (project / "src" / "deep").mkdir(parents=True)
    (project / "src" / "deep" / "a.py").write_text("a")
    (project / "notes.txt").write_text("n")
    outside = tmp_path / "outside.txt"
    outside.write_text("keep")
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "fs.read", "path": "notes.txt"})
    c.until("fs.content")
    c.send({"type": "fs.delete", "path": "notes.txt"})
    gone = c.until("fs.deleted")[0]
    assert (gone["path"], gone["kind"], gone["trash"]) == ("notes.txt", "file", False)
    assert not (project / "notes.txt").exists()
    c.send({"type": "fs.delete", "path": "src\\deep"})  # A folder goes with its contents. Windows separators too.
    assert c.until("fs.deleted")[0]["kind"] == "dir" and not (project / "src" / "deep").exists()
    # The session folder, a path outside the project, and a missing file are errors.
    for path, error in [(".", "Give a file"), ("../outside.txt", "outside the project"), ("missing.txt", "does not exist")]:
        c.send({"type": "fs.delete", "path": path})
        assert error in c.until("error")[0]["message"]
    assert outside.read_text() == "keep"
    c.close()


def test_trash_deletes_read_only_files_and_links(tmp_path, monkeypatch):
    from harness_daemon import trash
    monkeypatch.setattr(trash, "_recycle_windows", lambda path: False)
    folder = tmp_path / "f"
    folder.mkdir()
    (folder / "ro.txt").write_text("x")
    os.chmod(folder / "ro.txt", stat.S_IREAD)
    assert trash.delete(folder) is False and not folder.exists()
    target = tmp_path / "target.txt"
    target.write_text("t")
    link = tmp_path / "link.txt"
    try:
        link.symlink_to(target)
    except OSError:
        return  # Windows without the right to make links.
    trash.delete(link)
    assert not os.path.lexists(link) and target.read_text() == "t"  # The target stays.


PNG_DOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def test_a_prompt_with_pasted_images(daemon, project, fake_model):
    # A model with no image input gets a note: it cannot see the images.
    c = Client(daemon)
    c.new_session(project)
    fake_model.script({"text": "I cannot see it."})
    c.send({"type": "prompt", "text": "What is wrong here?", "images": [PNG_DOT]})
    _, seen = c.until("turn.end")
    # The user sees that the model did not get the image.
    notices = [m["text"] for m in seen if m["type"] == "notice"]
    assert any("test-model cannot read images" in n for n in notices), notices
    last = fake_model.requests[-1]["messages"][-1]
    assert isinstance(last["content"], str) and "attached 1 image" in last["content"]
    c.send({"type": "prompt", "text": "x", "images": ["https://example.com/a.png"]})
    assert "data URL" in c.until("error")[0]["message"]
    c.close()

    # A model with image input gets the image as a part of the message.
    fake_model.capabilities = ["completion", "tools", "vision"]
    c = Client(daemon)
    c.new_session(project, model="fake/other-model")
    # The checks of the endpoint after the open find the image input.
    assert c.until("session.model_info")[0]["image_input"] is True
    fake_model.script({"text": "I see a dot."})
    c.send({"type": "prompt", "text": "", "images": [PNG_DOT]})  # Only an image: the prompt can go.
    c.until("turn.end")
    parts = fake_model.requests[-1]["messages"][-1]["content"]
    assert parts[1] == {"type": "image_url", "image_url": {"url": PNG_DOT}}
    c.close()


def _openai_provider(harness_home, fake_model) -> None:
    """A second provider "box": the fake model as an OpenAI-compatible server, with no /api/show."""
    providers = json.loads((harness_home / "providers.json").read_text())
    providers["box"] = {"base_url": fake_model.base_url, "api_key": "test", "kind": "openai", "context_length": 32768}
    (harness_home / "providers.json").write_text(json.dumps(providers))


def test_an_openai_server_that_lists_image_input(daemon, harness_home, project, fake_model):
    # The bug: a model of an OpenAI-compatible server always got a note in place of the image.
    _openai_provider(harness_home, fake_model)
    fake_model.model_fields = {"test-model": {"architecture": {"input_modalities": ["text", "image"]}}}
    c = Client(daemon)
    c.new_session(project, model="box/test-model")
    assert c.until("session.model_info")[0]["image_input"] is True
    fake_model.script({"text": "I see a dot."})
    c.send({"type": "prompt", "text": "What is this?", "images": [PNG_DOT]})
    c.until("turn.end")
    parts = fake_model.requests[-1]["messages"][-1]["content"]
    assert parts[0] == {"type": "text", "text": "What is this?"}
    assert parts[1] == {"type": "image_url", "image_url": {"url": PNG_DOT}}
    c.close()


def test_an_unknown_image_input_sends_the_image(daemon, harness_home, project, fake_model):
    # The model list does not tell: the image goes to the model.
    _openai_provider(harness_home, fake_model)
    c = Client(daemon)
    ready = c.new_session(project, model="box/test-model")
    assert ready["image_input"] is None
    fake_model.script({"text": "I see a dot."})
    c.send({"type": "prompt", "text": "What is this?", "images": [PNG_DOT]})
    _, seen = c.until("turn.end")
    assert not [m for m in seen if m["type"] == "notice"]
    parts = fake_model.requests[-1]["messages"][-1]["content"]
    assert parts[1] == {"type": "image_url", "image_url": {"url": PNG_DOT}}
    c.close()


def test_a_rejected_image_becomes_a_note_with_a_notice(daemon, harness_home, project, fake_model):
    # The model list does not tell, and the endpoint rejects the image: the request goes again with a
    # note, and the user sees why.
    _openai_provider(harness_home, fake_model)
    c = Client(daemon)
    c.new_session(project, model="box/test-model")
    # Two rejections: the model client tries a 400 error one more time without reasoning_effort.
    rejected = {"error": "image input is not supported", "status": 400}
    fake_model.script(rejected, rejected, {"text": "I cannot see it."})
    c.send({"type": "prompt", "text": "What is this?", "images": [PNG_DOT]})
    _, seen = c.until("turn.end")
    assert not [m for m in seen if m["type"] == "error"]
    info = [m for m in seen if m["type"] == "session.model_info"][-1]
    assert info["image_input"] is False and "rejected the attached image" in info["warnings"][0]
    *tries, last = fake_model.requests
    assert len(tries) == 2 and all(r["messages"][-1]["content"][1]["type"] == "image_url" for r in tries)
    note = last["messages"][-1]["content"]
    assert isinstance(note, str) and "attached 1 image" in note

    # The next image of the session gets the note at once, with the notice.
    fake_model.script({"text": "Still no."})
    c.send({"type": "prompt", "text": "And this?", "images": [PNG_DOT]})
    _, seen = c.until("turn.end")
    assert any("cannot read images" in m["text"] for m in seen if m["type"] == "notice")
    assert isinstance(fake_model.requests[-1]["messages"][-1]["content"], str)
    c.close()


def test_an_error_that_is_not_the_image_stays_an_error(daemon, harness_home, project, fake_model):
    _openai_provider(harness_home, fake_model)
    c = Client(daemon)
    c.new_session(project, model="box/test-model")
    # The API client tries a rate limit error one more time.
    fake_model.script({"error": "Rate limit.", "status": 429}, {"error": "Rate limit.", "status": 429})
    c.send({"type": "prompt", "text": "What is this?", "images": [PNG_DOT]})
    _, seen = c.until("turn.end")
    assert any("HTTP 429" in m.get("text", m.get("message", "")) for m in seen if m["type"] in ("error", "notice"))
    assert not [m for m in seen if m["type"] == "session.model_info" and m["image_input"] is False]
    assert all(r["messages"][-1]["content"][1]["type"] == "image_url" for r in fake_model.requests)
    c.close()


def test_the_default_model_follows_the_network(daemon, harness_home, project, fake_model):
    import json as _json

    providers = _json.loads((harness_home / "providers.json").read_text())
    # A provider that does not answer: nothing listens on port 1.
    providers["cloud"] = {"base_url": "http://127.0.0.1:1/v1", "api_key": "x", "kind": "openai"}
    (harness_home / "providers.json").write_text(_json.dumps(providers))
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "user_settings.set", "values": {"auto_model": True, "online_model": "cloud/big-model",
                                                     "offline_model": "fake/test-model"}})
    got = c.until("user_settings")[0]["values"]
    assert (got["auto_model"], got["online_model"], got["offline_model"]) == (True, "cloud/big-model", "fake/test-model")
    c.send({"type": "session.new", "cwd": str(project), "model": ""})
    ready = c.until("session.ready")[0]
    assert ready["model"] == "fake/test-model"
    assert any("uses the local model fake/test-model" in w for w in ready["warnings"])
    c.close()

    # The online model answers: a new session uses it. Off: the default_model setting applies, as before.
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "user_settings.set", "values": {"online_model": "fake/other-model"}})
    c.until("user_settings")
    c.send({"type": "session.new", "cwd": str(project), "model": ""})
    assert c.until("session.ready")[0]["model"] == "fake/other-model"
    c.close()


def test_web_search_settings_and_keys(daemon, harness_home, project, fake_model):
    c = Client(daemon)
    c.send({"type": "user_settings.get"})
    assert c.until("user_settings")[0]["values"]["web_search"] == "duckduckgo"
    c.send({"type": "user_settings.set", "values": {"web_search": "searxng", "web_search_url": "http://localhost:8888"}})
    got = c.until("user_settings")[0]["values"]
    assert (got["web_search"], got["web_search_url"]) == ("searxng", "http://localhost:8888")
    c.send({"type": "user_settings.set", "values": {"web_search": "google"}})
    assert "must be one of" in c.until("error")[0]["message"]
    c.send({"type": "user_settings.set", "values": {"web_search_url": "ftp://x"}})
    assert "web_search_url" in c.until("error")[0]["message"]
    c.send({"type": "web.key", "provider": "brave", "key": "secret"})
    assert c.until("web.key")[0] == {"type": "web.key", "provider": "brave", "set": True}
    c.send({"type": "web.key", "provider": "brave", "key": None})
    assert c.until("web.key")[0]["set"] is False
    c.send({"type": "web.key", "provider": "google", "key": "x"})
    assert "provider" in c.until("error")[0]["message"]
    c.close()


QUESTION = {"question": "Which database?", "header": "Database",
            "options": [{"label": "SQLite (Recommended)", "description": "One file."}, {"label": "Postgres"}]}


def test_a_question_card_waits_for_the_answers(daemon, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "ask_user_question", "arguments": {"questions": [QUESTION]}}]},
        {"text": "SQLite it is."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "set up the database"})
    request = c.until("permission.request")[0]
    assert request["kind"] == "question" and request["questions"][0]["options"][0]["label"] == "SQLite (Recommended)"
    c.send({"type": "plan.reply", "request_id": request["request_id"], "decision": "accept"})
    assert "No open plan request" in c.until("error")[0]["message"]
    c.send({"type": "question.reply", "request_id": request["request_id"], "answers": {"Which database?": "SQLite (Recommended)"}})
    c.until("turn.end")
    result = next(m for m in fake_model.requests[-1]["messages"] if m["role"] == "tool")
    assert '"Which database?" = "SQLite (Recommended)"' in result["content"]
    c.close()


def test_a_skipped_question_lets_the_agent_choose(daemon, project, fake_model):
    fake_model.script(
        {"tool_calls": [{"name": "ask_user_question", "arguments": {"questions": [QUESTION]}}]},
        {"text": "I chose SQLite."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "set up the database"})
    request = c.until("permission.request")[0]
    c.send({"type": "question.reply", "request_id": request["request_id"], "answers": None})
    c.until("turn.end")
    result = next(m for m in fake_model.requests[-1]["messages"] if m["role"] == "tool")
    assert "skipped the questions" in result["content"]
    c.close()


def test_plan_approval_changes_the_mode_and_starts_the_work(daemon, project, fake_model):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"permission_mode": "plan"}))
    fake_model.script(
        {"tool_calls": [{"name": "exit_plan_mode", "arguments": {"plan": "1. Change hello.py."}}]},
        {"tool_calls": [{"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'hey'"}}]},
        {"text": "Done."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "plan the change"})
    request = c.until("permission.request")[0]
    assert (request["kind"], request["plan"]) == ("plan", "1. Change hello.py.")
    assert "exit_plan_mode" in [t["function"]["name"] for t in fake_model.requests[-1]["tools"]]
    c.send({"type": "plan.reply", "request_id": request["request_id"], "decision": "accept", "mode": "acceptEdits"})
    settings = c.until("settings")[0]
    assert settings["permission_mode"] == "acceptEdits"
    c.until("turn.end")
    assert "'hey'" in (project / "hello.py").read_text()  # acceptEdits: the edit ran with no question.
    assert json.loads((project / ".harness" / "settings.json").read_text())["permission_mode"] == "acceptEdits"
    # The tool list stays the same in each mode. A note tells the model that plan mode is off.
    assert "exit_plan_mode" in [t["function"]["name"] for t in fake_model.requests[-1]["tools"]]
    assert any("Plan mode is off" in str(m.get("content")) for m in fake_model.requests[-2]["messages"])
    c.close()


def test_a_rejected_plan_stops_the_turn_and_keeps_plan_mode(daemon, project, fake_model):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"permission_mode": "plan"}))
    fake_model.script(
        {"tool_calls": [{"name": "exit_plan_mode", "arguments": {"plan": "1. Delete all."}}]},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "plan it"})
    request = c.until("permission.request")[0]
    c.send({"type": "plan.reply", "request_id": request["request_id"], "decision": "reject"})
    end = c.until("turn.end")[0]
    assert end["stop_reason"] == "denied"
    assert len([r for r in fake_model.requests if r.get("tools")]) == 1
    assert json.loads((project / ".harness" / "settings.json").read_text())["permission_mode"] == "plan"
    c.close()


def _wait(check, timeout: float = 5) -> None:
    deadline = time.time() + timeout
    while not check():
        if time.time() > deadline:
            raise AssertionError("The condition did not come true in time.")
        time.sleep(0.05)


def test_the_title_comes_before_the_reply(daemon, project, fake_model):
    fake_model.script({"text": "Hello."})
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Say hello"})
    _, seen = c.until("turn.end")
    types = [m["type"] for m in seen]
    assert "session.title" in types and types.index("session.title") < types.index("token")
    c.close()


def test_title_tries_again_on_the_next_prompt(daemon, project, fake_model):
    fake_model.title_fail = 2  # The request and the one retry of the model client fail.
    fake_model.script({"text": "One."}, {"text": "Two."})
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "prompt", "text": "First task"})
    _, seen = c.until("turn.end")
    _wait(lambda: len(fake_model.title_requests) == 2)
    time.sleep(0.3)  # The failed title request ends.
    assert not any(m["type"] == "session.title" for m in seen)
    c.send({"type": "prompt", "text": "Second task"})
    _, seen = c.until("turn.end")
    title = next((m for m in seen if m["type"] == "session.title"), None) or c.until("session.title")[0]
    assert title == {"type": "session.title", "id": ready["session_id"], "title": "Fake session title"}
    # The second try names the first prompt, not the second prompt.
    assert "First task" in fake_model.title_requests[2]["messages"][-1]["content"]
    c.close()


def test_rename_during_the_title_request_keeps_the_name_of_the_user(daemon, project, fake_model):
    fake_model.title_delay = 1.0
    fake_model.script({"text": "Done."})
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "prompt", "text": "Do a task"})
    # Rename only after the title request starts. A rename before the turn starts gives no title
    # request at all, and on a slow computer that can occur.
    _wait(lambda: len(fake_model.title_requests) == 1)
    c.send({"type": "session.update", "session_id": ready["session_id"], "title": "My name"})
    _, seen = c.until("session.updated")
    time.sleep(1.5)  # The title reply comes.
    c.send({"type": "session.list"})
    sessions, more = c.until("sessions")
    assert not any(m["type"] == "session.title" for m in seen + more)
    assert next(s for s in sessions["items"] if s["id"] == ready["session_id"])["title"] == "My name"
    c.close()


def test_split_view_connection_takes_a_running_session(daemon, project, fake_model):
    """The split view has its own connection. A session with a running turn moves between the two
    connections (session.resume and session.adopt), and its turn does not stop."""
    fake_model.script(
        {"tool_calls": [{"name": "edit", "arguments": {"path": "hello.py", "old_string": "'hello'", "new_string": "'hey'"}}]},
        {"text": "Changed."},
    )
    main = Client(daemon)
    first = main.new_session(project)
    main.send({"type": "prompt", "text": "edit it"})
    request = main.until("permission.request")[0]
    main.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    main.until("session.ready")

    # The split view opens the first session: it moves, with the request that waits.
    split = Client(daemon)
    split.until("auth.ok")
    split.send({"type": "session.resume", "session_id": first["session_id"]})
    shown = split.until("session.ready")[0]
    assert shown["running"] and shown["requests"][0]["request_id"] == request["request_id"]
    running = main.until("sessions.running")[0]
    while running["items"]:
        running = main.until("sessions.running")[0]

    # The split view closes: the main connection takes the session first.
    main.send({"type": "session.adopt", "session_id": first["session_id"]})
    adopted, seen = main.until("session.adopted")
    assert adopted == {"type": "session.adopted", "id": first["session_id"], "moved": True}
    running = [m for m in seen if m["type"] == "sessions.running"]
    assert running[-1]["items"] == [{"session_id": first["session_id"], "waiting": True}]
    split.close()

    # The turn still waits. The main connection shows it and allows the edit.
    main.send({"type": "session.resume", "session_id": first["session_id"]})
    back = main.until("session.ready")[0]
    assert back["running"] and back["requests"][0]["request_id"] == request["request_id"]
    main.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    end = main.until("turn.end")[0]
    assert end["session_id"] == first["session_id"] and end["stop_reason"] == "end"
    assert "'hey'" in (project / "hello.py").read_text()

    # No other connection has the session: nothing moves.
    main.send({"type": "session.adopt", "session_id": first["session_id"]})
    assert main.until("session.adopted")[0]["moved"] is False
    main.close()
