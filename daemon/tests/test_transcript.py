"""The transcript export of a session (transcript.py, session.export, scripts/export_transcript.py)."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

from harness_daemon.storage import Storage
from harness_daemon.transcript import export_transcript

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

DAEMON_DIR = Path(__file__).resolve().parents[1]
IMAGE = "data:image/png;base64," + "A" * 400


def stored_session(path: Path) -> tuple[Storage, str]:
    storage = Storage(path)
    sid = storage.create_session("/p", "fake", "m")
    messages = [
        {"role": "user", "content": "secret plan"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "read", "arguments": '{"path": "a.py"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "print('x')", "is_error": False},
        {"role": "user", "content": [{"type": "image_url", "image_url": {"url": IMAGE}}]},
    ]
    storage.append_messages(sid, messages)
    storage.start_turn(sid, {"id": "t1", "started_at": 1.0})
    return storage, sid


def test_a_full_export_has_all_messages_and_the_records(tmp_path):
    storage, sid = stored_session(tmp_path / "s.db")
    data = export_transcript(storage, sid)
    assert data["format"] == "harness-transcript" and data["version"] == 1 and data["content"] is True
    assert len(data["messages"]) == 4 and data["messages"][0]["content"] == "secret plan"
    assert data["turns"][0]["id"] == "t1" and data["model_requests"] == [] and data["tool_calls"] == []
    # Images become a size marker unless the caller asks for them.
    assert "[image: " in json.dumps(data["messages"][3]) and "AAAA" not in json.dumps(data)
    assert "AAAA" in json.dumps(export_transcript(storage, sid, images=True))
    storage.close()


def test_a_metadata_export_has_no_text(tmp_path):
    storage, sid = stored_session(tmp_path / "s.db")
    text = json.dumps(export_transcript(storage, sid, content=False))
    for secret in ("secret plan", "a.py", "print("):
        assert secret not in text
    data = json.loads(text)
    assert data["messages"][1]["tool_calls"][0]["name"] == "read"
    assert data["messages"][0]["content_chars"] == len("secret plan")
    storage.close()


def test_the_export_has_the_messages_before_a_summary(tmp_path):
    storage, sid = stored_session(tmp_path / "s.db")
    storage.db.execute("UPDATE sessions SET context_start = 3 WHERE id = ?", (sid,))
    storage.db.commit()
    assert len(storage.load_messages(sid)) == 1
    assert len(export_transcript(storage, sid)["messages"]) == 4
    storage.close()


def test_the_session_export_message(daemon, project, fake_model):  # noqa: F811
    fake_model.script({"text": "Hi."})
    c = Client(daemon)
    ready = c.new_session(project)
    c.send({"type": "prompt", "text": "hello there"})
    c.until("turn.end")
    c.send({"type": "session.export", "session_id": ready["session_id"]})
    reply, _ = c.until("session.export")
    data = json.loads(base64.b64decode(reply["data"]))
    assert reply["name"].endswith(".json") and data["session"]["id"] == ready["session_id"]
    assert any(m.get("content") == "hello there" for m in data["messages"])
    assert data["turns"][0]["stop_reason"] == "end" and data["model_requests"][0]["purpose"] == "turn"
    c.send({"type": "session.export", "content": False})  # The current session.
    reply, _ = c.until("session.export")
    assert "hello there" not in base64.b64decode(reply["data"]).decode("utf-8")
    assert reply["name"].endswith("-metadata.json")


def test_the_script_reads_the_database_read_only(tmp_path):
    storage, sid = stored_session(tmp_path / "s.db")
    storage.close()
    out = subprocess.run([sys.executable, "scripts/export_transcript.py", "--db", str(tmp_path / "s.db"),
                          "--session", sid[:8], "--no-content"], cwd=DAEMON_DIR, capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    data = json.loads(out.stdout)
    assert data["content"] is False and len(data["messages"]) == 4 and "secret plan" not in out.stdout
