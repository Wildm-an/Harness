from __future__ import annotations

from pathlib import Path
from typing import Any

from ..files import is_binary, relpath
from .base import Approval, Tool, ToolContext, ToolError, ToolResult
from .edit import unified_diff


class WriteTool(Tool):
    name = "write"
    description = (
        "Create a file, or replace all the content of a file. The folders are created if necessary. "
        "To change part of an existing file, use the edit tool."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path, relative to the project folder."},
            "content": {"type": "string", "description": "The full content of the file."},
        },
        "required": ["path", "content"],
    }
    needs_approval = True

    def _plan(self, args: dict[str, Any], ctx: ToolContext) -> tuple[Path, str | None, str]:
        path = ctx.resolve(args.get("path"))
        content = args.get("content")
        if not isinstance(content, str):
            raise ToolError("content must be a string.")
        if path.is_dir():
            raise ToolError(f"{args['path']} is a folder, not a file.")
        if not path.exists():
            return path, None, content
        data = path.read_bytes()
        if is_binary(data):
            raise ToolError(f"{args['path']} is a binary file. The write tool does not replace binary files.")
        before = data.decode("utf-8", errors="replace")
        # Keep Windows line endings in a file that has them.
        if "\r\n" in before and "\r\n" not in content:
            content = content.replace("\n", "\r\n")
        return path, before, content

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        path, before, after = self._plan(args, ctx)
        rel = relpath(ctx.cwd, path)
        diff = unified_diff(before or "", after, rel, new_file=before is None)
        return Approval(key=rel, rule=f"write({rel})", diff=diff)

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path, before, after = self._plan(args, ctx)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(after.encode("utf-8"))
        rel = relpath(ctx.cwd, path)
        lines = after.count("\n") + (0 if after.endswith("\n") or not after else 1)
        verb = "Created" if before is None else "Replaced the content of"
        diff = unified_diff(before or "", after, rel, new_file=before is None)
        return ToolResult(f"{verb} {rel} ({lines} lines).", changed_paths=[path], diff=diff)
