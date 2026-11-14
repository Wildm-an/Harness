from __future__ import annotations

import asyncio
import base64
import io
from pathlib import Path
from typing import Any

from ..documents import DocumentError, is_document, old_format_note, read_document
from ..files import is_binary
from .base import Tool, ToolContext, ToolError, ToolResult, get_int

MAX_LINE_CHARS = 2000
DEFAULT_LIMIT = 2000
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}
MAX_IMAGE_BYTES = 5_000_000  # The largest image that goes to the model as it is.
MAX_IMAGE_SIDE = 1568  # A larger image becomes smaller, if Pillow is installed (as the images of the prompt box).


def _image_result(path: Path, image_input: bool, shown: str) -> ToolResult:
    """An image file for the model: a data URL. A large image becomes smaller, if Pillow is there."""
    if not image_input:
        raise ToolError(f"{shown} is an image. The model of this session does not accept images.")
    data = path.read_bytes()
    mime = IMAGE_TYPES[path.suffix.lower()]
    size = None
    try:
        from PIL import Image

        with Image.open(io.BytesIO(data)) as img:
            size = img.size
            if max(img.size) > MAX_IMAGE_SIDE or len(data) > MAX_IMAGE_BYTES:
                img.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))
                out = io.BytesIO()
                if img.mode in ("RGBA", "LA", "P"):
                    img.save(out, "PNG", optimize=True)
                    mime = "image/png"
                else:
                    img.convert("RGB").save(out, "JPEG", quality=85)
                    mime = "image/jpeg"
                data = out.getvalue()
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001 - a bad image file gives a clear error.
        raise ToolError(f"{shown} is not a valid image: {e}") from None
    if len(data) > MAX_IMAGE_BYTES:
        raise ToolError(f"{shown} is too large for the model: {len(data) // 1_000_000} MB. The limit is 5 MB.")
    note = f" {size[0]}x{size[1]} pixels." if size else ""
    return ToolResult(f"(The image {shown}: {mime}, {max(len(data) // 1000, 1)} KB.{note})",
                      image=f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}")


class ReadTool(Tool):
    name = "read"
    description = (
        "Read a text file. The result shows each line as the line number, a tab, and the text. "
        "The line number and the tab are not part of the file. "
        "For a large file, use offset and limit to read one part. "
        "Use it in place of cat, head, tail, or Get-Content in bash. "
        "When you need several files, read them all in one reply with several read calls. "
        "It also reads PDF, Word (.docx), PowerPoint (.pptx), and Excel (.xlsx) files as text with "
        "numbered parts: paragraphs [P1], table cells, slides and shapes [2.1], and cells such as B4. "
        "Use office_edit to change a Word, PowerPoint, or Excel file. "
        "It shows a PNG, JPEG, GIF, or WebP image to a model that accepts images."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path, relative to the project folder."},
            "offset": {"type": "integer", "description": "The first line to read. Line 1 is the first line."},
            "limit": {"type": "integer", "description": f"The maximum number of lines to read. Default {DEFAULT_LIMIT}."},
            "pages": {"type": "string", "description": "For a PDF: the pages to read, for example 1-5 or 2,7. Default: all."},
        },
        "required": ["path"],
    }

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.resolve(args.get("path"), read_only=True)
        offset = max(get_int(args, "offset", 1) or 1, 1)
        limit = max(get_int(args, "limit", DEFAULT_LIMIT) or DEFAULT_LIMIT, 1)
        if path.is_dir():
            raise ToolError(f"{args['path']} is a folder, not a file.")
        if not path.exists():
            raise ToolError(f"File not found: {args['path']}")
        if path.suffix.lower() in IMAGE_TYPES:
            return await asyncio.to_thread(_image_result, path, ctx.image_input, args["path"])
        if is_document(path):
            try:
                text = await asyncio.to_thread(read_document, path, args.get("pages"))
            except DocumentError as e:
                raise ToolError(str(e)) from None
            return ToolResult(text)
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            raise ToolError(f"File not found: {args['path']}") from None
        if is_binary(data):
            note = old_format_note(path)
            raise ToolError(note or f"{args['path']} is a binary file.")
        if ctx.reads is not None:
            ctx.reads.note(path, data)
        lines = data.decode("utf-8", errors="replace").splitlines()
        if not lines:
            return ToolResult("(The file is empty.)")
        if offset > len(lines):
            raise ToolError(f"The file has {len(lines)} lines. Offset {offset} is after the end.")
        end = min(offset - 1 + limit, len(lines))
        out = []
        for n in range(offset - 1, end):
            line = lines[n]
            if len(line) > MAX_LINE_CHARS:
                line = line[:MAX_LINE_CHARS] + " [line truncated]"
            out.append(f"{n + 1:>6}\t{line}")
        if end < len(lines):
            out.append(f"\n[Lines {offset}-{end} of {len(lines)}. Use offset={end + 1} to read more.]")
        return ToolResult("\n".join(out))
