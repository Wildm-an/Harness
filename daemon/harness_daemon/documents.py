"""Office documents and PDFs for the agent: read Word, PowerPoint, Excel, and PDF files, and edit
Word, PowerPoint, and Excel files.

The read tool shows a document as text with numbered parts, so that the agent can name what to
change: [P3] is paragraph 3 of a Word document, [T1 R2 C3] is a table cell, "Slide 2" and its
shapes [2.1], [2.2] are parts of a presentation, and B4 is a cell of a workbook. The office_edit
tool (tools/office.py) changes these parts.

The libraries load only when they are needed: the daemon starts fast.
"""

from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Any, Callable

READ_EXTS = {".pdf", ".docx", ".pptx", ".xlsx", ".xlsm"}
EDIT_EXTS = {".docx", ".pptx", ".xlsx", ".xlsm"}
OLD_FORMATS = {".doc": ".docx", ".ppt": ".pptx", ".xls": ".xlsx"}

MAX_TEXT = 60_000  # Characters of the text of one document.
MAX_SHEET_ROWS = 300
MAX_SHEET_COLS = 40


class DocumentError(Exception):
    """A document that cannot be read or changed. The message goes to the agent."""


def is_document(path: Path) -> bool:
    return path.suffix.lower() in READ_EXTS


def old_format_note(path: Path) -> str | None:
    """A note for an old binary Office format, which the tools cannot read."""
    new = OLD_FORMATS.get(path.suffix.lower())
    return f"{path.name} is an old {path.suffix} file. Save it as {new} first, for example in Office." if new else None


# -- reading ------------------------------------------------------------------------------------


def parse_pages(spec: str | None, count: int) -> list[int]:
    """The page numbers (1-based) of "3", "2-5", or "1,4-6". None or "" gives all pages."""
    if not spec or not str(spec).strip():
        return list(range(1, count + 1))
    pages: list[int] = []
    for part in str(spec).replace(" ", "").split(","):
        m = re.fullmatch(r"(\d+)(?:-(\d+))?", part)
        if not m:
            raise DocumentError(f"Pages must look like 3, 2-5, or 1,4-6. Got: {spec}")
        start, end = int(m.group(1)), int(m.group(2) or m.group(1))
        pages.extend(range(min(start, end), max(start, end) + 1))
    pages = [p for p in dict.fromkeys(pages) if 1 <= p <= count]
    if not pages:
        raise DocumentError(f"The document has {count} pages. No page matches {spec}.")
    return pages


def pdf_text(data: bytes, pages: str | None = None) -> str:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise DocumentError("The PDF has a password. The agent cannot read it.")
        numbers = parse_pages(pages, len(reader.pages))
        parts = [f"[The PDF has {len(reader.pages)} pages.]"]
        for n in numbers:
            text = (reader.pages[n - 1].extract_text() or "").strip()
            parts.append(f"--- Page {n} ---\n{text or '(No text on this page. It can be an image.)'}")
        return "\n\n".join(parts)
    except PdfReadError as e:
        raise DocumentError(f"The PDF cannot be read: {e}") from None


def _docx_parts(doc: Any) -> Callable[[], list[tuple[str, Any]]]:
    """The paragraphs and tables of the body, in their order: ("p", paragraph) or ("t", table)."""
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    def parts() -> list[tuple[str, Any]]:
        out: list[tuple[str, Any]] = []
        for child in doc.element.body.iterchildren():
            tag = child.tag.rsplit("}", 1)[-1]
            if tag == "p":
                out.append(("p", Paragraph(child, doc)))
            elif tag == "tbl":
                out.append(("t", Table(child, doc)))
        return out

    return parts


def docx_text(doc: Any) -> str:
    lines: list[str] = []
    p_no = t_no = 0
    for kind, part in _docx_parts(doc)():
        if kind == "p":
            p_no += 1
            text = part.text
            style = part.style.name if part.style is not None else ""
            label = f" ({style})" if style and style != "Normal" else ""
            lines.append(f"[P{p_no}]{label} {text}" if text.strip() else f"[P{p_no}]{label}")
        else:
            t_no += 1
            lines.append(f"[T{t_no}] Table, {len(part.rows)} rows x {len(part.columns)} columns:")
            for r, row in enumerate(part.rows, 1):
                cells = [cell.text.replace("\n", " / ") for cell in row.cells]
                lines.append(f"  R{r}: " + " | ".join(cells))
    return "\n".join(lines) if lines else "(The document is empty.)"


def _shape_text(shape: Any) -> str:
    if shape.has_text_frame:
        return " / ".join(p.text for p in shape.text_frame.paragraphs if p.text.strip())
    if getattr(shape, "has_table", False) and shape.has_table:
        return " || ".join(" | ".join(c.text for c in row.cells) for row in shape.table.rows)
    return ""


def pptx_text(prs: Any) -> str:
    lines: list[str] = [f"[The presentation has {len(prs.slides)} slides.]"]
    for n, slide in enumerate(prs.slides, 1):
        lines.append(f"## Slide {n} ({slide.slide_layout.name})")
        for s, shape in enumerate(slide.shapes, 1):
            text = _shape_text(shape)
            if text:
                lines.append(f"  [{n}.{s}] ({shape.name}) {text}")
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip() if slide.notes_slide.notes_text_frame else ""
            if notes:
                lines.append(f"  Notes: {notes}")
    return "\n".join(lines)


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    return text if len(text) <= 200 else text[:200] + "…"


def xlsx_text(wb: Any) -> str:
    from openpyxl.utils import get_column_letter

    lines: list[str] = []
    for ws in wb.worksheets:
        dims = ws.dimensions if ws.max_row and ws.max_column else "empty"
        lines.append(f'## Sheet "{ws.title}" ({dims})')
        rows = min(ws.max_row, MAX_SHEET_ROWS)
        cols = min(ws.max_column, MAX_SHEET_COLS)
        for r in range(1, rows + 1):
            cells = []
            for c in range(1, cols + 1):
                value = ws.cell(row=r, column=c).value
                if value is not None and str(value) != "":
                    cells.append(f"{get_column_letter(c)}{r}={_cell_text(value)}")
            if cells:
                lines.append("  " + "  ".join(cells))
        if ws.max_row > rows or ws.max_column > cols:
            lines.append(f"  [Only the first {rows} rows and {cols} columns are here.]")
    return "\n".join(lines) if lines else "(The workbook has no sheets.)"


def _load(path: Path, data: bytes | None = None) -> Any:
    """The document object of a .docx, .pptx, or .xlsx file (or a new one if data is b"")."""
    ext = path.suffix.lower()
    stream = None if data == b"" else io.BytesIO(data if data is not None else path.read_bytes())
    try:
        if ext == ".docx":
            import docx

            return docx.Document(stream)
        if ext == ".pptx":
            import pptx

            return pptx.Presentation(stream)
        if ext in (".xlsx", ".xlsm"):
            import openpyxl

            if stream is None:
                return openpyxl.Workbook()
            return openpyxl.load_workbook(stream, keep_vba=ext == ".xlsm")
    except DocumentError:
        raise
    except Exception as e:  # noqa: BLE001 - a broken or encrypted file.
        raise DocumentError(f"{path.name} cannot be opened: {e}") from None
    raise DocumentError(f"{path.name} is not a Word, PowerPoint, or Excel file.")


def object_text(path: Path, obj: Any) -> str:
    ext = path.suffix.lower()
    if ext == ".docx":
        return docx_text(obj)
    if ext == ".pptx":
        return pptx_text(obj)
    return xlsx_text(obj)


def read_document(path: Path, pages: str | None = None) -> str:
    """The text of a PDF, Word, PowerPoint, or Excel file, with numbered parts."""
    data = path.read_bytes()
    if path.suffix.lower() == ".pdf":
        text = pdf_text(data, pages)
    else:
        text = object_text(path, _load(path, data))
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT] + f"\n\n[The text is cut at {MAX_TEXT} characters. For a PDF, read some pages with 'pages'.]"
    return text


# -- editing ------------------------------------------------------------------------------------


def _need(edit: dict[str, Any], key: str, kind: type | tuple[type, ...] = str) -> Any:
    value = edit.get(key)
    if not isinstance(value, kind) or (isinstance(value, str) and kind is str and value == "" and key != "replace"):
        name = getattr(kind, "__name__", "the right type")
        raise DocumentError(f"The '{edit.get('op')}' edit needs '{key}' ({name}).")
    return value


def _index(value: Any, count: int, what: str) -> int:
    if not isinstance(value, int) or not 1 <= value <= count:
        raise DocumentError(f"{what} {value} does not exist. There are {count}.")
    return value - 1


def _replace_in_paragraph(paragraph: Any, find: str, replace: str) -> int:
    """Replace text in one paragraph. A match inside one run keeps its formatting. A match across
    runs puts the new text of the paragraph in its first run."""
    if find not in paragraph.text:
        return 0
    count = 0
    for run in paragraph.runs:
        if find in run.text:
            count += run.text.count(find)
            run.text = run.text.replace(find, replace)
    if find in paragraph.text or count == 0:
        whole = paragraph.text
        count += whole.count(find)
        new = whole.replace(find, replace)
        runs = paragraph.runs
        if runs:
            runs[0].text = new
            for run in runs[1:]:
                run.text = ""
    return count


def _docx_paragraphs(doc: Any) -> list[Any]:
    return [part for kind, part in _docx_parts(doc)() if kind == "p"]


def _docx_all_paragraphs(doc: Any) -> list[Any]:
    """The body paragraphs and the paragraphs in table cells."""
    out = list(_docx_paragraphs(doc))
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                out.extend(cell.paragraphs)
    return out


def _set_paragraph_text(paragraph: Any, text: str) -> None:
    runs = paragraph.runs
    if runs:
        runs[0].text = text
        for run in runs[1:]:
            run.text = ""
    else:
        paragraph.add_run(text)


def _docx_edit(doc: Any, edit: dict[str, Any]) -> str:
    op = edit.get("op")
    if op == "replace":
        find, replace = _need(edit, "find"), _need(edit, "replace")
        count = sum(_replace_in_paragraph(p, find, replace) for p in _docx_all_paragraphs(doc))
        if not count:
            raise DocumentError(f"The text to replace is not in the document: {find!r}")
        return f"Replaced {count} time(s)"
    paragraphs = _docx_paragraphs(doc)
    if op == "insert_paragraph":
        after = edit.get("after", len(paragraphs))
        if not isinstance(after, int) or not 0 <= after <= len(paragraphs):
            raise DocumentError(f"'after' must be from 0 to {len(paragraphs)} (0 is the start).")
        text, style = _need(edit, "text"), edit.get("style")
        try:
            if after < len(paragraphs):
                paragraphs[after].insert_paragraph_before(text, style)
            else:
                doc.add_paragraph(text, style)
        except KeyError:
            raise DocumentError(f"The document has no style {style!r}.") from None
        return f"Inserted a paragraph after [P{after}]"
    if op == "set_paragraph":
        p = paragraphs[_index(edit.get("index"), len(paragraphs), "Paragraph")]
        _set_paragraph_text(p, _need(edit, "text"))
        if edit.get("style"):
            try:
                p.style = edit["style"]
            except KeyError:
                raise DocumentError(f"The document has no style {edit['style']!r}.") from None
        return f"Changed [P{edit['index']}]"
    if op == "delete_paragraph":
        p = paragraphs[_index(edit.get("index"), len(paragraphs), "Paragraph")]
        p._element.getparent().remove(p._element)
        return f"Deleted [P{edit['index']}]"
    if op == "set_cell":
        table = doc.tables[_index(edit.get("table"), len(doc.tables), "Table")]
        row = table.rows[_index(edit.get("row"), len(table.rows), "Row")]
        cell = row.cells[_index(edit.get("col"), len(row.cells), "Column")]
        _set_paragraph_text(cell.paragraphs[0], _need(edit, "text"))
        for extra in cell.paragraphs[1:]:
            extra._element.getparent().remove(extra._element)
        return f"Set [T{edit['table']} R{edit['row']} C{edit['col']}]"
    if op == "add_table":
        rows = _need(edit, "rows", list)
        if not rows or not all(isinstance(r, list) for r in rows):
            raise DocumentError("'rows' must be a list of rows, each a list of cell texts.")
        cols = max(len(r) for r in rows)
        table = doc.add_table(rows=len(rows), cols=cols)
        try:
            table.style = edit.get("style") or "Table Grid"
        except (KeyError, ValueError):
            pass  # A document with no table styles keeps a plain table.
        for r, values in enumerate(rows):
            for c, value in enumerate(values):
                table.cell(r, c).text = "" if value is None else str(value)
        return f"Added a table of {len(rows)} rows at the end"
    raise DocumentError(f"Unknown Word edit: {op!r}. Use replace, insert_paragraph, set_paragraph, delete_paragraph, set_cell, or add_table.")


def _pptx_slide(prs: Any, edit: dict[str, Any]) -> Any:
    return prs.slides[_index(edit.get("slide"), len(prs.slides), "Slide")]


def _pptx_edit(prs: Any, edit: dict[str, Any]) -> str:
    op = edit.get("op")
    if op == "replace":
        find, replace = _need(edit, "find"), _need(edit, "replace")
        slides = [_pptx_slide(prs, edit)] if edit.get("slide") is not None else list(prs.slides)
        count = 0
        for slide in slides:
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for p in shape.text_frame.paragraphs:
                        count += _replace_in_paragraph(p, find, replace)
                elif getattr(shape, "has_table", False) and shape.has_table:
                    for row in shape.table.rows:
                        for cell in row.cells:
                            for p in cell.text_frame.paragraphs:
                                count += _replace_in_paragraph(p, find, replace)
        if not count:
            raise DocumentError(f"The text to replace is not in the presentation: {find!r}")
        return f"Replaced {count} time(s)"
    if op == "add_slide":
        layouts = list(prs.slide_layouts)
        layout_ref = edit.get("layout")  # A layout name, or a number from 1. Default: "Title and Content".
        if layout_ref is None:
            layout = layouts[1] if len(layouts) > 1 else layouts[0]
        elif isinstance(layout_ref, str):
            match = [lay for lay in layouts if lay.name.lower() == layout_ref.lower()]
            if not match:
                raise DocumentError(f"No layout {layout_ref!r}. The layouts: {', '.join(lay.name for lay in layouts)}.")
            layout = match[0]
        else:
            layout = layouts[_index(layout_ref, len(layouts), "Layout")]
        slide = prs.slides.add_slide(layout)
        if edit.get("title") and slide.shapes.title is not None:
            slide.shapes.title.text = str(edit["title"])
        body = edit.get("body")
        if body:
            holders = [ph for ph in slide.placeholders if ph.placeholder_format.idx != 0 and ph.has_text_frame]
            if holders:
                lines = body if isinstance(body, list) else str(body).split("\n")
                frame = holders[0].text_frame
                frame.text = str(lines[0])
                for line in lines[1:]:
                    frame.add_paragraph().text = str(line)
        position = edit.get("position")
        if isinstance(position, int) and 1 <= position < len(prs.slides):
            ids = prs.slides._sldIdLst  # noqa: SLF001 - python-pptx has no move API.
            item = ids[-1]
            ids.remove(item)
            ids.insert(position - 1, item)
        return f"Added a slide ({layout.name})"
    if op == "delete_slide":
        index = _index(edit.get("slide"), len(prs.slides), "Slide")
        ids = prs.slides._sldIdLst  # noqa: SLF001
        item = ids[index]
        prs.part.drop_rel(item.rId)
        ids.remove(item)
        return f"Deleted slide {index + 1}"
    if op == "set_text":
        slide = _pptx_slide(prs, edit)
        shapes = list(slide.shapes)
        shape = shapes[_index(edit.get("shape"), len(shapes), "Shape")]
        if not shape.has_text_frame:
            raise DocumentError(f"Shape {edit['slide']}.{edit['shape']} has no text.")
        lines = str(_need(edit, "text")).split("\n")
        frame = shape.text_frame
        _set_paragraph_text(frame.paragraphs[0], lines[0])
        for p in list(frame.paragraphs[1:]):
            p._p.getparent().remove(p._p)
        for line in lines[1:]:
            frame.add_paragraph().text = line
        return f"Changed [{edit['slide']}.{edit['shape']}]"
    if op == "set_notes":
        slide = _pptx_slide(prs, edit)
        slide.notes_slide.notes_text_frame.text = str(_need(edit, "text"))
        return f"Set the notes of slide {edit['slide']}"
    raise DocumentError(f"Unknown PowerPoint edit: {op!r}. Use replace, add_slide, delete_slide, set_text, or set_notes.")


def _cell_value(value: Any) -> Any:
    """A value for a cell: "=..." is a formula, a number text becomes a number."""
    if not isinstance(value, str):
        return value
    text = value.strip()
    if text.startswith("="):
        return text
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d*\.\d+(e-?\d+)?|-?\d+e-?\d+", text, re.I):
        return float(text)
    return value


def _sheet(wb: Any, edit: dict[str, Any]) -> Any:
    name = edit.get("sheet")
    if name is None:
        return wb.active
    if name not in wb.sheetnames:
        raise DocumentError(f"No sheet {name!r}. The sheets: {', '.join(wb.sheetnames)}.")
    return wb[name]


def _xlsx_edit(wb: Any, edit: dict[str, Any]) -> str:
    from openpyxl.utils.cell import coordinate_from_string, column_index_from_string

    op = edit.get("op")
    if op == "set":
        ws = _sheet(wb, edit)
        ref = _need(edit, "cell")
        try:
            ws[ref] = _cell_value(edit.get("value"))
        except (ValueError, AttributeError):
            raise DocumentError(f"Not a cell: {ref!r}. Use a cell like B4.") from None
        return f"Set {ws.title}!{ref}"
    if op == "set_rows":
        ws = _sheet(wb, edit)
        rows = _need(edit, "rows", list)
        try:
            col_letter, row0 = coordinate_from_string(_need(edit, "start"))
        except ValueError:
            raise DocumentError(f"Not a cell: {edit.get('start')!r}. Use a cell like A1.") from None
        col0 = column_index_from_string(col_letter)
        for r, values in enumerate(rows):
            if not isinstance(values, list):
                raise DocumentError("'rows' must be a list of rows, each a list of values.")
            for c, value in enumerate(values):
                ws.cell(row=row0 + r, column=col0 + c, value=_cell_value(value))
        return f"Set {len(rows)} rows from {ws.title}!{edit['start']}"
    if op == "add_sheet":
        name = _need(edit, "name")
        if name in wb.sheetnames:
            raise DocumentError(f"The sheet {name!r} exists already.")
        wb.create_sheet(name)
        return f"Added the sheet {name!r}"
    if op == "rename_sheet":
        ws = _sheet(wb, {"sheet": _need(edit, "sheet")})
        ws.title = _need(edit, "name")
        return f"Renamed the sheet to {ws.title!r}"
    if op == "delete_sheet":
        ws = _sheet(wb, {"sheet": _need(edit, "sheet")})
        if len(wb.worksheets) == 1:
            raise DocumentError("A workbook needs at least one sheet.")
        wb.remove(ws)
        return f"Deleted the sheet {edit['sheet']!r}"
    raise DocumentError(f"Unknown Excel edit: {op!r}. Use set, set_rows, add_sheet, rename_sheet, or delete_sheet.")


def apply_edits(path: Path, edits: list[dict[str, Any]], create: bool) -> tuple[bytes, str, str, list[str]]:
    """Apply the edits to a copy of the document. Returns the new file bytes, the text before and
    after (for the diff of the permission request), and a line for each edit. Nothing is saved."""
    ext = path.suffix.lower()
    if ext not in EDIT_EXTS:
        note = old_format_note(path)
        raise DocumentError(note or f"office_edit changes .docx, .pptx, and .xlsx files. {path.name} is not one of them.")
    exists = path.exists()
    if not exists and not create:
        raise DocumentError(f"{path.name} does not exist. Set create: true to make a new document.")
    if exists and create:
        raise DocumentError(f"{path.name} exists already. Leave out create to change it.")
    obj = _load(path, None if exists else b"")
    before = object_text(path, obj) if exists else ""
    apply = _docx_edit if ext == ".docx" else _pptx_edit if ext == ".pptx" else _xlsx_edit
    done = []
    for n, edit in enumerate(edits, 1):
        if not isinstance(edit, dict):
            raise DocumentError(f"Edit {n} is not an object.")
        try:
            done.append(apply(obj, edit))
        except DocumentError as e:
            raise DocumentError(f"Edit {n} ({edit.get('op')}): {e}") from None
    out = io.BytesIO()
    obj.save(out)
    return out.getvalue(), before, object_text(path, obj), done
