from __future__ import annotations

import difflib
from pathlib import Path
from typing import Any

from ..files import is_binary, relpath
from .base import Approval, Tool, ToolContext, ToolError, ToolResult, get_bool


def unified_diff(before: str, after: str, name: str, new_file: bool = False) -> str:
    lines = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile="/dev/null" if new_file else f"a/{name}",
        tofile=f"b/{name}",
    )
    return "".join(line if line.endswith("\n") else line + "\n" for line in lines)


class EditTool(Tool):
    name = "edit"
    description = (
        "Replace an exact string in an existing file. old_string must match the file exactly, "
        "with the same spaces and indentation. old_string must occur one time in the file, "
        "unless replace_all is true. Read the file before you edit it."
    )
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path, relative to the project folder."},
            "old_string": {"type": "string", "description": "The exact text to replace."},
            "new_string": {"type": "string", "description": "The new text."},
            "replace_all": {"type": "boolean", "description": "Replace each occurrence. Default false."},
        },
        "required": ["path", "old_string", "new_string"],
    }
    needs_approval = True

    def _plan(self, args: dict[str, Any], ctx: ToolContext) -> tuple[Path, bytes, bytes]:
        path = ctx.resolve(args.get("path"))
        old = args.get("old_string")
        new = args.get("new_string")
        if not isinstance(old, str) or not isinstance(new, str):
            raise ToolError("old_string and new_string must be strings.")
        if old == "":
            raise ToolError("old_string is empty. Give the exact text to replace.")
        if old == new:
            raise ToolError("old_string and new_string are the same. No change is necessary.")
        if path.is_dir():
            raise ToolError(f"{args['path']} is a folder, not a file.")
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            raise ToolError(f"File not found: {args['path']}") from None
        if is_binary(data):
            raise ToolError(f"{args['path']} is a binary file.")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise ToolError(f"{args['path']} is not UTF-8 text.") from None

        count = text.count(old)
        # Models write "\n". Try the file line endings if the exact text is not found.
        if count == 0 and "\r\n" in text and "\n" in old:
            old = old.replace("\r\n", "\n").replace("\n", "\r\n")
            new = new.replace("\r\n", "\n").replace("\n", "\r\n")
            count = text.count(old)
        if count == 0:
            raise ToolError("old_string was not found in the file. Read the file and copy the exact text.")
        replace_all = get_bool(args, "replace_all")
        if count > 1 and not replace_all:
            raise ToolError(
                f"old_string occurs {count} times in the file. Add more lines around it to make it unique, "
                "or set replace_all to true."
            )
        updated = text.replace(old, new) if replace_all else text.replace(old, new, 1)
        return path, data, updated.encode("utf-8")

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        path, before, after = self._plan(args, ctx)
        rel = relpath(ctx.cwd, path)
        diff = unified_diff(before.decode("utf-8"), after.decode("utf-8"), rel)
        return Approval(key=rel, rule=f"edit({rel})", diff=diff)

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path, before, after = self._plan(args, ctx)
        path.write_bytes(after)
        rel = relpath(ctx.cwd, path)
        diff = unified_diff(before.decode("utf-8"), after.decode("utf-8"), rel)
        return ToolResult(f"Edited {rel}.", changed_paths=[path], diff=diff)
