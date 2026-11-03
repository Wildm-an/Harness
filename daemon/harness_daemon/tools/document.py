"""The ``show_document`` tool: the agent opens a PDF or a Word file for the user to look at.

The tool only checks the file. The client sees the tool call and its result, and opens the file in
its Preview pane (client ``PreviewPane.tsx``). The pane gets the bytes with the daemon message
``fs.read_bytes``. The tool changes no file and needs no approval.

The agent reads the text of a document with ``read`` (documents.py). This tool is for the user.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..files import relpath
from .base import Tool, ToolContext, ToolError, ToolResult

# The file types of the Preview pane: pdf.js for PDF, docx-preview for Word.
PREVIEW_SUFFIXES = (".pdf", ".docx")
# The file goes to the client as base64 in one WebSocket message (the limit is 32 MB).
MAX_PREVIEW_FILE = 20 * 1024 * 1024


def check_preview_file(path: Path, shown: str) -> None:
    """Raise ToolError if the Preview pane cannot show the file."""
    if path.suffix.lower() not in PREVIEW_SUFFIXES:
        if path.suffix.lower() == ".doc":
            raise ToolError(f"{shown} is an old Word file (.doc). The Preview pane shows only .pdf and .docx files.")
        raise ToolError(f"The Preview pane shows only .pdf and .docx files. {shown} is not one of them.")
    if not path.is_file():
        raise ToolError(f"The file does not exist: {shown}")
    if path.stat().st_size > MAX_PREVIEW_FILE:
        raise ToolError(f"{shown} is larger than {MAX_PREVIEW_FILE // (1024 * 1024)} MB. The Preview pane cannot show it.")


class ShowDocumentTool(Tool):
    name = "show_document"
    description = (
        "Open a PDF (.pdf) or Word (.docx) file of the project in the Preview pane of the app, so "
        "that the user can look at it. Use it when the user asks to see a document, or after you "
        "make or change a document that the user must check. This tool does not give you the "
        "text: use read for that."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "The path of the .pdf or .docx file, relative to the project."},
        },
        "required": ["path"],
    }

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        raw = args.get("path")
        path = ctx.resolve(raw)
        rel = relpath(ctx.cwd, path)
        check_preview_file(path, rel or str(raw))
        return ToolResult(f"Opened {rel} in the Preview pane. The user can see it now.")
