from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.documents import DocumentError, parse_pages
from harness_daemon.tools import OfficeEditTool, ReadTool, ToolContext, ToolError, detect_shell


@pytest.fixture
def ctx(project):
    return ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())


def read(ctx, path: str, **extra) -> str:
    return asyncio.run(ReadTool().run({"path": path, **extra}, ctx)).output


def edit(ctx, path: str, edits: list, create: bool = False):
    return asyncio.run(OfficeEditTool().run({"path": path, "edits": edits, "create": create}, ctx))


def make_pdf(path: Path, pages: list[str]) -> None:
    """A small PDF with one line of text on each page, with a correct cross-reference table."""
    objects: list[bytes] = []
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(len(pages)))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    font = 3 + 2 * len(pages)
    for i, text in enumerate(pages):
        content = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 2 * i} 0 R "
            f"/Resources << /Font << /F1 {font} 0 R >> >> >>".encode()
        )
        objects.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


def test_read_a_pdf_and_some_pages(ctx, project):
    make_pdf(project / "spec.pdf", ["First page text", "Second page text", "Third page text"])
    text = read(ctx, "spec.pdf")
    assert "[The PDF has 3 pages.]" in text and "--- Page 2 ---" in text and "Second page text" in text
    some = read(ctx, "spec.pdf", pages="3")
    assert "Third page text" in some and "First page text" not in some
    with pytest.raises(ToolError, match="No page matches"):
        read(ctx, "spec.pdf", pages="9")


def test_parse_pages():
    assert parse_pages("1,3-4", 5) == [1, 3, 4]
    assert parse_pages(None, 3) == [1, 2, 3]
    with pytest.raises(DocumentError):
        parse_pages("one", 3)


def test_word_documents(ctx, project):
    result = edit(
        ctx,
        "report.docx",
        [
            {"op": "insert_paragraph", "after": 0, "text": "Quarterly report", "style": "Heading 1"},
            {"op": "insert_paragraph", "after": 1, "text": "Sales grew in March."},
            {"op": "add_table", "rows": [["Month", "Sales"], ["March", "120"]]},
        ],
        create=True,
    )
    assert result.output.startswith("Created report.docx")
    text = read(ctx, "report.docx")
    assert "(Heading 1) Quarterly report" in text and "[P2] Sales grew in March." in text
    assert "[T1] Table, 2 rows x 2 columns:" in text and "R2: March | 120" in text

    edit(
        ctx,
        "report.docx",
        [
            {"op": "replace", "find": "March", "replace": "April"},
            {"op": "set_cell", "table": 1, "row": 2, "col": 2, "text": "135"},
            {"op": "set_paragraph", "index": 1, "text": "Q2 report"},
        ],
    )
    text = read(ctx, "report.docx")
    assert "(Heading 1) Q2 report" in text and "Sales grew in April." in text and "R2: April | 135" in text

    edit(ctx, "report.docx", [{"op": "delete_paragraph", "index": 2}])
    assert "Sales grew" not in read(ctx, "report.docx")
    with pytest.raises(ToolError, match="not in the document"):
        edit(ctx, "report.docx", [{"op": "replace", "find": "nothing like this", "replace": "x"}])
    with pytest.raises(ToolError, match="no style"):
        edit(ctx, "report.docx", [{"op": "insert_paragraph", "text": "x", "style": "No Such Style"}])


def test_presentations(ctx, project):
    edit(
        ctx,
        "deck.pptx",
        [
            {"op": "add_slide", "title": "Welcome", "body": ["Point one", "Point two"]},
            {"op": "add_slide", "title": "Results", "body": "Up 20%"},
            {"op": "set_notes", "slide": 1, "text": "Say hello."},
        ],
        create=True,
    )
    text = read(ctx, "deck.pptx")
    assert "[The presentation has 2 slides.]" in text and "## Slide 1" in text
    assert "Welcome" in text and "Point one / Point two" in text and "Notes: Say hello." in text

    edit(ctx, "deck.pptx", [{"op": "replace", "find": "Up 20%", "replace": "Up 25%"}, {"op": "delete_slide", "slide": 1}])
    text = read(ctx, "deck.pptx")
    assert "[The presentation has 1 slides.]" in text and "Up 25%" in text and "Welcome" not in text
    with pytest.raises(ToolError, match="Slide 5 does not exist"):
        edit(ctx, "deck.pptx", [{"op": "set_notes", "slide": 5, "text": "x"}])


def test_workbooks(ctx, project):
    edit(
        ctx,
        "budget.xlsx",
        [
            {"op": "set_rows", "start": "A1", "rows": [["Item", "Cost"], ["Rent", "1200"], ["Food", "350.5"]]},
            {"op": "set", "cell": "B4", "value": "=SUM(B2:B3)"},
            {"op": "add_sheet", "name": "Notes"},
            {"op": "set", "sheet": "Notes", "cell": "A1", "value": "Draft"},
        ],
        create=True,
    )
    text = read(ctx, "budget.xlsx")
    assert 'Sheet "Sheet" (A1:B4)' in text and "B2=1200" in text and "B3=350.5" in text and "B4==SUM(B2:B3)" in text
    assert 'Sheet "Notes"' in text and "A1=Draft" in text

    edit(ctx, "budget.xlsx", [{"op": "rename_sheet", "sheet": "Notes", "name": "Info"}, {"op": "delete_sheet", "sheet": "Info"}])
    assert "Notes" not in read(ctx, "budget.xlsx")
    with pytest.raises(ToolError, match="No sheet"):
        edit(ctx, "budget.xlsx", [{"op": "set", "sheet": "Missing", "cell": "A1", "value": 1}])
    with pytest.raises(ToolError, match="at least one sheet"):
        edit(ctx, "budget.xlsx", [{"op": "delete_sheet", "sheet": "Sheet"}])


def test_the_permission_request_shows_the_change_and_uses_the_edit_rules(ctx, project):
    edit(ctx, "notes.docx", [{"op": "insert_paragraph", "text": "Old line"}], create=True)
    approval = asyncio.run(
        OfficeEditTool().prepare({"path": "notes.docx", "edits": [{"op": "replace", "find": "Old", "replace": "New"}]}, ctx)
    )
    assert approval.tool == "edit" and approval.rule == "edit(notes.docx)"
    assert "-[P1] Old line" in approval.diff and "+[P1] New line" in approval.diff
    assert "Old line" in read(ctx, "notes.docx")  # A request changes nothing.


def test_errors_for_files_that_are_not_documents(ctx, project):
    (project / "old.doc").write_bytes(b"\xd0\xcf\x11\xe0\x00\x00binary")
    with pytest.raises(ToolError, match="Save it as .docx"):
        read(ctx, "old.doc")
    with pytest.raises(ToolError, match="does not exist"):
        edit(ctx, "missing.docx", [{"op": "replace", "find": "a", "replace": "b"}])
    edit(ctx, "book.xlsx", [{"op": "set", "cell": "A1", "value": 1}], create=True)
    with pytest.raises(ToolError, match="exists already"):
        edit(ctx, "book.xlsx", [{"op": "set", "cell": "A1", "value": 2}], create=True)
    with pytest.raises(ToolError, match=".docx, .pptx, and .xlsx"):
        edit(ctx, "hello.py", [{"op": "set", "cell": "A1", "value": 1}])
