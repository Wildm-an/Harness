"""Tests for the Preview pane support: the show_document tool and the fs.read_bytes message."""

from __future__ import annotations

import asyncio
import base64

import pytest

from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.tools import ShowDocumentTool, ToolContext, ToolError, default_tools, detect_shell
from harness_daemon.tools.document import MAX_PREVIEW_FILE

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

PDF = b"%PDF-1.4\n%fake\n"
DOCX = b"PK\x03\x04fake docx"


@pytest.fixture
def ctx(project):
    return ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())


def show(ctx, path):
    return asyncio.run(ShowDocumentTool().run({"path": path}, ctx))


def test_the_tool_is_in_the_default_tools():
    assert "show_document" in {t.name for t in default_tools()}
    assert not ShowDocumentTool.needs_approval


def test_preview_a_pdf_and_a_docx(ctx, project):
    (project / "docs").mkdir()
    (project / "docs" / "report.pdf").write_bytes(PDF)
    (project / "Notes.DOCX").write_bytes(DOCX)
    result = show(ctx, "docs/report.pdf")
    assert not result.is_error and "docs/report.pdf" in result.output
    assert "Notes.DOCX" in show(ctx, str(project / "Notes.DOCX")).output  # An absolute path in the project.


@pytest.mark.parametrize(
    ("name", "message"),
    [
        ("hello.py", "only .pdf and .docx"),
        ("old.doc", "old Word file"),
        ("missing.pdf", "does not exist"),
        ("../outside.pdf", "outside"),
    ],
)
def test_preview_rejects_other_files(ctx, project, name, message):
    (project / "old.doc").write_bytes(b"\xd0\xcf\x11\xe0")
    (project.parent / "outside.pdf").write_bytes(PDF)
    with pytest.raises(ToolError, match=message):
        show(ctx, name)


def test_preview_rejects_a_large_file(ctx, project):
    with open(project / "big.pdf", "wb") as f:
        f.truncate(MAX_PREVIEW_FILE + 1)
    with pytest.raises(ToolError, match="larger than 20 MB"):
        show(ctx, "big.pdf")


def test_read_bytes_sends_base64(daemon, project, fake_model):  # noqa: F811
    (project / "report.pdf").write_bytes(PDF)
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "fs.read_bytes", "path": "./report.pdf"})
    reply = c.until("fs.bytes")[0]
    assert reply["path"] == "report.pdf" and reply["size"] == len(PDF)
    assert base64.b64decode(reply["data"]) == PDF

    c.send({"type": "fs.read_bytes", "path": "hello.py"})
    error = c.until("error")[0]
    assert error["ref"] == "fs.read_bytes" and "only .pdf and .docx" in error["message"]

    c.send({"type": "fs.read_bytes", "path": "../secret.pdf"})
    assert c.until("error")[0]["ref"] == "fs.read_bytes"
    c.close()


def test_agent_opens_a_preview(daemon, project, fake_model):  # noqa: F811
    (project / "plan.docx").write_bytes(DOCX)
    fake_model.script(
        {"text": "", "tool_calls": [{"name": "show_document", "arguments": {"path": "plan.docx"}}]},
        {"text": "The plan is open."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Show me the plan"})
    _, events = c.until("turn.end")
    start = next(e for e in events if e["type"] == "tool.start")
    result = next(e for e in events if e["type"] == "tool.result")
    assert start["name"] == "show_document" and start["input"] == {"path": "plan.docx"}
    assert not result["is_error"] and "plan.docx" in result["output"], result
    assert not any(e["type"] == "permission.request" for e in events)
    c.close()
