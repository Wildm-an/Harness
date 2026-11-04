"""office_edit: change a Word (.docx), PowerPoint (.pptx), or Excel (.xlsx) file, or make a new one.

The agent reads the document first with the read tool, which numbers its parts. The permission
request shows the change as a diff of the document text. The edit rules of the project apply:
an "edit(<path>)" rule allows the tool as it allows the edit tool.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..documents import DocumentError, apply_edits
from ..files import relpath
from .base import Approval, Tool, ToolContext, ToolError, ToolResult
from .edit import unified_diff


class OfficeEditTool(Tool):
    name = "office_edit"
    description = (
        "Change a Word (.docx), PowerPoint (.pptx), or Excel (.xlsx) file, or make a new one with "
        "create: true. Read the file first: the read tool numbers its parts. Give a list of edits; "
        "they apply in order, then the file is saved once. Each edit has an 'op':\n"
        "Word: replace {find, replace}; insert_paragraph {after (paragraph number, 0 for the start), "
        "text, style?}; set_paragraph {index, text, style?}; delete_paragraph {index}; "
        "set_cell {table, row, col, text}; add_table {rows: [[text, ...], ...]}.\n"
        "PowerPoint: replace {find, replace, slide?}; add_slide {title?, body? (lines), layout? "
        "(name or number), position?}; delete_slide {slide}; set_text {slide, shape, text}; "
        "set_notes {slide, text}.\n"
        "Excel: set {cell, value, sheet?} (a value that starts with = is a formula); "
        "set_rows {start, rows: [[value, ...], ...], sheet?}; add_sheet {name}; "
        "rename_sheet {sheet, name}; delete_sheet {sheet}.\n"
        "Numbers start at 1. A replace keeps the formatting when the text is in one run.\n"
        "This tool is for small changes. To make a formatted document, a deck, or a workbook with "
        "formulas, or for tracked changes, comments, charts, or a template, load the docx, pptx, or "
        "xlsx skill first."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "The .docx, .pptx, or .xlsx file, relative to the project folder."},
            "create": {"type": "boolean", "description": "True to make a new, empty document first."},
            "edits": {
                "type": "array",
                "description": "The edits, in order. Each is an object with 'op' and its fields.",
                "items": {"type": "object", "properties": {"op": {"type": "string"}}, "required": ["op"]},
            },
        },
        "required": ["path", "edits"],
    }
    needs_approval = True

    def _plan(self, args: dict[str, Any], ctx: ToolContext) -> tuple[Path, bytes, str, str, list[str]]:
        path = ctx.resolve(args.get("path"))
        edits = args.get("edits")
        if not isinstance(edits, list) or not edits:
            raise ToolError("edits must be a list of one or more edits.")
        if path.is_dir():
            raise ToolError(f"{args['path']} is a folder, not a file.")
        try:
            data, before, after, done = apply_edits(path, edits, bool(args.get("create")))
        except DocumentError as e:
            raise ToolError(str(e)) from None
        return path, data, before, after, done

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        path, _, before, after, _ = self._plan(args, ctx)
        rel = relpath(ctx.cwd, path)
        diff = unified_diff(before, after, rel, new_file=not path.exists())
        return Approval(key=rel, rule=f"edit({rel})", diff=diff, tool="edit")

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path, data, before, after, done = self._plan(args, ctx)
        new = not path.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        rel = relpath(ctx.cwd, path)
        diff = unified_diff(before, after, rel, new_file=new)
        verb = "Created" if new else "Changed"
        return ToolResult(f"{verb} {rel}:\n- " + "\n- ".join(done), changed_paths=[path], diff=diff)
