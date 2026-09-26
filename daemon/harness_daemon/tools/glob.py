from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from ..files import relpath
from .base import Tool, ToolContext, ToolError, ToolResult
from .search import find_ripgrep, glob_match, run_ripgrep, walk_files

MAX_RESULTS = 200


def list_files(base: Path, rg: str | None) -> list[Path]:
    """All files under ``base``. With ripgrep, the .gitignore files apply."""
    if rg:
        proc = run_ripgrep(rg, ["--files", "--hidden", "-g", "!.git", "--path-separator", "/"], base)
        if proc.returncode in (0, 1) or proc.stdout:
            text = proc.stdout.decode("utf-8", errors="replace")
            return [base / line for line in text.splitlines() if line]
    return list(walk_files(base))


class GlobTool(Tool):
    name = "glob"
    description = (
        "Find files by a name pattern, for example **/*.py or src/**/*.ts. "
        "A pattern with no / matches the file name in each folder. The newest files come first."
    )
    parameters = {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "The glob pattern."},
            "path": {"type": "string", "description": "The folder to search. Default: the project folder."},
        },
        "required": ["pattern"],
    }

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        pattern = args.get("pattern")
        if not isinstance(pattern, str) or not pattern.strip():
            raise ToolError("pattern is empty.")
        base = ctx.resolve(args.get("path") or ".", read_only=True)
        if not base.is_dir():
            raise ToolError(f"Not a folder: {args.get('path')}")
        rg = find_ripgrep(ctx.settings.get("ripgrep"))

        def search() -> list[tuple[float, str]]:
            found = []
            for path in list_files(base, rg):
                if glob_match(path.relative_to(base).as_posix(), pattern):
                    try:
                        found.append((path.stat().st_mtime, relpath(ctx.cwd, path)))
                    except OSError:
                        continue
            return found

        found = await asyncio.to_thread(search)
        if not found:
            return ToolResult(f"No files match {pattern}.")
        found.sort(key=lambda item: item[0], reverse=True)
        lines = [rel for _, rel in found[:MAX_RESULTS]]
        if len(found) > MAX_RESULTS:
            lines.append(f"[{len(found)} files match. Only the {MAX_RESULTS} newest are shown. Use a narrower pattern.]")
        return ToolResult("\n".join(lines))
