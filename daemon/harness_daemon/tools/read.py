from __future__ import annotations

from typing import Any

from ..files import is_binary
from .base import Tool, ToolContext, ToolError, ToolResult, get_int

MAX_LINE_CHARS = 2000
DEFAULT_LIMIT = 2000


class ReadTool(Tool):
    name = "read"
    description = (
        "Read a text file. The result shows each line with its line number. "
        "For a large file, use offset and limit to read one part."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path, relative to the project folder."},
            "offset": {"type": "integer", "description": "The first line to read. Line 1 is the first line."},
            "limit": {"type": "integer", "description": f"The maximum number of lines to read. Default {DEFAULT_LIMIT}."},
        },
        "required": ["path"],
    }

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.resolve(args.get("path"), read_only=True)
        offset = max(get_int(args, "offset", 1) or 1, 1)
        limit = max(get_int(args, "limit", DEFAULT_LIMIT) or DEFAULT_LIMIT, 1)
        if path.is_dir():
            raise ToolError(f"{args['path']} is a folder, not a file.")
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            raise ToolError(f"File not found: {args['path']}") from None
        if is_binary(data):
            raise ToolError(f"{args['path']} is a binary file.")
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
