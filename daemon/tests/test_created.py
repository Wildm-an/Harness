"""The new PDF and Word files of a tool call: the chat shows a card with "Open" (created.py)."""

from __future__ import annotations

import json

from harness_daemon.created import MAX_CREATED, before_call, created_files, scan_preview_files

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_the_scan_finds_pdf_and_word_files_and_skips_hidden_and_large_folders(tmp_path):
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "report.PDF").write_bytes(b"%PDF")
    (tmp_path / "letter.docx").write_bytes(b"PK")
    (tmp_path / "notes.txt").write_text("x")
    for skipped in (".git", ".venv", "node_modules"):
        (tmp_path / skipped).mkdir()
        (tmp_path / skipped / "hidden.pdf").write_bytes(b"%PDF")
    assert scan_preview_files(tmp_path) == {"out/report.PDF", "letter.docx"}


def test_the_scan_gives_nothing_when_the_folder_is_too_large(tmp_path):
    for i in range(30):
        (tmp_path / f"f{i}.txt").write_text("x")
    assert scan_preview_files(tmp_path, max_entries=10) is None


def test_a_bash_command_that_makes_files(tmp_path):
    (tmp_path / "old.pdf").write_bytes(b"%PDF")
    snap = before_call(tmp_path, "bash", {"command": "python build.py"})
    (tmp_path / "build").mkdir()
    (tmp_path / "build" / "report.docx").write_bytes(b"PK")
    (tmp_path / "old.pdf").write_bytes(b"%PDF changed")  # A changed file is not new.
    (tmp_path / "data.csv").write_text("a,b")
    assert created_files(tmp_path, snap, []) == ["build/report.docx"]


def test_a_background_command_is_not_scanned(tmp_path):
    snap = before_call(tmp_path, "bash", {"command": "python build.py", "run_in_background": True})
    (tmp_path / "report.pdf").write_bytes(b"%PDF")
    assert created_files(tmp_path, snap, []) == []


def test_a_tool_that_names_a_new_file(tmp_path):
    snap = before_call(tmp_path, "office_edit", {"path": "memo.docx", "create": True})
    (tmp_path / "memo.docx").write_bytes(b"PK")
    assert created_files(tmp_path, snap, [tmp_path / "memo.docx"]) == ["memo.docx"]
    # The same tool on a file that existed before: not new.
    snap = before_call(tmp_path, "office_edit", {"path": "memo.docx"})
    assert created_files(tmp_path, snap, [tmp_path / "memo.docx"]) == []
    # A path outside the project, or a file type that the Preview pane cannot show: no card.
    assert before_call(tmp_path, "write", {"path": "../outside.pdf"}).named is None
    assert before_call(tmp_path, "write", {"path": "notes.md"}).named is None


def test_at_most_a_few_cards_for_one_call(tmp_path):
    snap = before_call(tmp_path, "bash", {"command": "make"})
    for i in range(MAX_CREATED + 5):
        (tmp_path / f"page-{i:02d}.pdf").write_bytes(b"%PDF")
    assert len(created_files(tmp_path, snap, [])) == MAX_CREATED


def test_the_tool_result_and_the_history_have_the_new_file(daemon, project, fake_model):  # noqa: F811
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps({"permission_mode": "acceptEdits"}))
    fake_model.script(
        {"tool_calls": [{"name": "office_edit", "arguments": {
            "path": "memo.docx", "create": True, "edits": [{"op": "insert_paragraph", "after": 0, "text": "Hello"}]}}]},
        {"text": "Done."},
    )
    c = Client(daemon)
    first = c.new_session(project)
    c.send({"type": "prompt", "text": "make a memo"})
    result = c.until("tool.result")[0]
    assert not result["is_error"], result["output"]
    assert result["created"] == ["memo.docx"]
    c.until("turn.end")
    c.send({"type": "session.resume", "session_id": first["session_id"]})
    history = c.until("session.ready")[0]["history"]
    tool_message = next(m for m in history if m["role"] == "tool")
    assert tool_message["created"] == ["memo.docx"]
    c.close()
    # The model does not get the field: it is for the client only.
    sent = fake_model.requests[-1]["messages"]
    assert all("created" not in m for m in sent)
