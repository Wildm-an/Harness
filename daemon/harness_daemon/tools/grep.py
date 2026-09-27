from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any

from ..files import is_binary, relpath
from .base import Tool, ToolContext, ToolError, ToolResult, get_bool, get_int
from .search import find_ripgrep, glob_match, run_ripgrep, walk_files

MAX_FILES = 200
MAX_LINES = 300
MAX_LINE_CHARS = 300
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_CONTEXT = 10
MODES = ("files", "content", "count")


class GrepTool(Tool):
    name = "grep"
    description = (
        "Search the content of files with a regular expression. "
        "output=files (default) lists the files that match. "
        "output=content shows the matching lines as path:line:text. "
        "output=count shows the number of matching lines in each file."
    )
    parameters = {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "The regular expression."},
            "path": {"type": "string", "description": "A file or folder to search. Default: the project folder."},
            "glob": {"type": "string", "description": "Search only files that match this glob, for example *.py."},
            "output": {"type": "string", "enum": list(MODES), "description": "files, content, or count."},
            "ignore_case": {"type": "boolean", "description": "Ignore upper and lower case. Default false."},
            "context": {"type": "integer", "description": "Lines to show before and after each match (content only)."},
        },
        "required": ["pattern"],
    }

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        pattern = args.get("pattern")
        if not isinstance(pattern, str) or not pattern:
            raise ToolError("pattern is empty.")
        mode = args.get("output") or "files"
        if mode not in MODES:
            raise ToolError(f"output must be one of: {', '.join(MODES)}.")
        target = ctx.resolve(args.get("path") or ".", read_only=True)
        if not target.exists():
            raise ToolError(f"Not found: {args.get('path')}")
        file_glob = args.get("glob") or None
        ignore_case = get_bool(args, "ignore_case")
        context = min(max(get_int(args, "context", 0) or 0, 0), MAX_CONTEXT) if mode == "content" else 0

        rg = find_ripgrep(ctx.settings.get("ripgrep"))
        if rg:
            lines = await asyncio.to_thread(
                _search_rg, rg, ctx.cwd, target, pattern, mode, file_glob, ignore_case, context)
        else:
            lines = await asyncio.to_thread(
                _search_python, ctx.cwd, target, pattern, mode, file_glob, ignore_case, context)
        if not lines:
            return ToolResult(f"No matches for {pattern}.")
        return ToolResult(_limit(lines, mode))


MATCH_LINE_RE = re.compile(r"^(.+?):(\d+):(.*)$")


def search_project(cwd: Path, query: str, *, regex: bool, ignore_case: bool, file_glob: str | None,
                   ripgrep: str | None, limit: int = 500) -> tuple[list[dict[str, Any]], bool]:
    """The project search of the editor. Return the matches and True if the list is truncated."""
    rg = find_ripgrep(ripgrep)
    search = _search_rg if rg else _search_python
    args = (rg,) if rg else ()
    lines = search(*args, cwd, cwd, query, "content", file_glob, ignore_case, 0, fixed=not regex)
    items = []
    for line in lines:
        m = MATCH_LINE_RE.match(line)
        if m:
            items.append({"path": m.group(1), "line": int(m.group(2)), "text": m.group(3)[:MAX_LINE_CHARS]})
        if len(items) >= limit:
            return items, True
    return items, False


def _limit(lines: list[str], mode: str) -> str:
    limit = MAX_LINES if mode == "content" else MAX_FILES
    out = [line if len(line) <= MAX_LINE_CHARS else line[:MAX_LINE_CHARS] + " [...]" for line in lines[:limit]]
    if len(lines) > limit:
        out.append(f"[{len(lines)} results. Only the first {limit} are shown. Use a narrower pattern, path, or glob.]")
    return "\n".join(out)


def _search_rg(rg: str, cwd: Path, target: Path, pattern: str, mode: str,
               file_glob: str | None, ignore_case: bool, context: int, fixed: bool = False) -> list[str]:
    args = ["--color", "never", "--no-messages", "--hidden", "-g", "!.git", "--path-separator", "/"]
    if ignore_case:
        args.append("-i")
    if fixed:
        args.append("-F")
    if file_glob:
        args += ["-g", file_glob]
    if mode == "files":
        args.append("-l")
    elif mode == "count":
        args.append("-c")
    else:
        args += ["-n", "--no-heading", "--max-columns", str(MAX_LINE_CHARS), "--max-columns-preview"]
        if context:
            args += ["-C", str(context)]
    args += ["-e", pattern, "--", relpath(cwd, target) or "."]
    proc = run_ripgrep(rg, args, cwd)
    if proc.returncode == 2 and not proc.stdout:
        message = proc.stderr.decode("utf-8", errors="replace").strip() or "ripgrep failed."
        raise ToolError(f"The search failed: {message}")
    text = proc.stdout.decode("utf-8", errors="replace")
    return [line[2:] if line.startswith("./") else line for line in text.splitlines()]


def _search_python(cwd: Path, target: Path, pattern: str, mode: str,
                   file_glob: str | None, ignore_case: bool, context: int, fixed: bool = False) -> list[str]:
    try:
        regex = re.compile(re.escape(pattern) if fixed else pattern, re.IGNORECASE if ignore_case else 0)
    except re.error as e:
        raise ToolError(f"The pattern is not a valid regular expression: {e}") from None
    base = target if target.is_dir() else target.parent
    out: list[str] = []
    for path in walk_files(target):
        if file_glob and not glob_match(path.relative_to(base).as_posix(), file_glob):
            continue
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                continue
            data = path.read_bytes()
        except OSError:
            continue
        if is_binary(data):
            continue
        lines = data.decode("utf-8", errors="replace").splitlines()
        hits = [i for i, line in enumerate(lines) if regex.search(line)]
        if not hits:
            continue
        rel = relpath(cwd, path)
        if mode == "files":
            out.append(rel)
        elif mode == "count":
            out.append(f"{rel}:{len(hits)}")
        else:
            out.extend(_with_context(rel, lines, hits, context))
        if len(out) > MAX_LINES + 1:  # Enough to show the limit note.
            break
    return out


def _with_context(rel: str, lines: list[str], hits: list[int], context: int) -> list[str]:
    """Format matches as rg does: "path:N:text" for a match, "path-N-text" for context, "--" between groups."""
    hit_set = set(hits)
    shown: list[int] = []
    for i in hits:
        for j in range(max(i - context, 0), min(i + context + 1, len(lines))):
            if not shown or j > shown[-1]:
                shown.append(j)
    out = []
    previous = None
    for j in shown:
        if previous is not None and j != previous + 1:
            out.append("--")
        sep = ":" if j in hit_set else "-"
        out.append(f"{rel}{sep}{j + 1}{sep}{lines[j]}")
        previous = j
    return out
