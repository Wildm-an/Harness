"""The apply_patch tool: one patch that adds, deletes, updates, or moves files, in the format of OpenAI Codex.

GPT and Codex models learn this format in training. The setting "edit_tool" selects it (agent.py,
_sync_edit_tools): "edit" (default) keeps edit and write, "apply_patch" puts this tool in their place, and
"auto" uses APPLY_PATCH_FAMILIES. The grammar follows the Lark grammar and the parser of openai/codex
(codex-rs/core/assets/tools/apply_patch.lark, codex-rs/apply-patch/src/streaming_parser.rs):

    start: begin_patch hunk+ end_patch
    begin_patch: "*** Begin Patch" LF
    end_patch: "*** End Patch" LF?
    hunk: add_hunk | delete_hunk | update_hunk
    add_hunk: "*** Add File: " filename LF add_line+
    delete_hunk: "*** Delete File: " filename LF
    update_hunk: "*** Update File: " filename LF change_move? change?
    change_move: "*** Move to: " filename LF
    change: (change_context | change_line)+ eof_line?
    change_context: ("@@" | "@@ " /(.+)/) LF
    change_line: ("+" | "-" | " ") /(.*)/ LF
    eof_line: "*** End of File" LF

As in Codex, the parser accepts spaces around the markers, an empty line in an update as an empty context line,
and a patch in a shell heredoc (<<'EOF' ... EOF). A hunk with no context and no removed lines adds its lines at the
end of the file, as in Codex. Differences from Codex: a hunk context that matches only with a tolerance must match
one place (match.py), an Add File of a file that exists fails, a move to a file that exists fails, and one patch
can change a file only one time.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..files import is_binary, relpath
from .base import Approval, Tool, ToolContext, ToolError, ToolResult
from .edit import unified_diff
from .match import INDENTATION, TRAILING, scan_lines

# The model families that get apply_patch with "edit_tool": "auto". Empty until the eval result is in the
# prompt ledger (plan change 8, step 11).
APPLY_PATCH_FAMILIES: frozenset[str] = frozenset()

BEGIN = "*** Begin Patch"
END = "*** End Patch"
ADD = "*** Add File: "
DELETE = "*** Delete File: "
UPDATE = "*** Update File: "
MOVE = "*** Move to: "
END_OF_FILE = "*** End of File"

BOUNDARY_ERROR = "The patch must start with '*** Begin Patch' and end with '*** End Patch'."
HEADER_ERROR = ("Line {line}: '{text}' is not a file header. Use '*** Add File: <path>', '*** Delete File: <path>', "
                "or '*** Update File: <path>'.")
LINE_ERROR = ("Line {line}: '{text}' is not a hunk line. In an update, each line starts with a space (context), "
              "'-' (removed), or '+' (added). A new hunk starts with '@@'.")
_HEREDOC = re.compile(r"^(?:apply_patch\s*)?<<-?\s*(['\"]?)(\w+)\1$")


def uses_patch(setting: Any, family: str | None) -> bool:
    """True if the agent changes files with apply_patch. ``setting``: the value of "edit_tool"."""
    if setting == "apply_patch":
        return True
    return setting == "auto" and family is not None and family in APPLY_PATCH_FAMILIES


@dataclass
class Hunk:
    header: str | None  # The text after "@@ ": a line above the change, for example "def f():".
    old: list[str] = field(default_factory=list)  # Context and removed lines.
    new: list[str] = field(default_factory=list)  # Context and added lines.
    context: list[tuple[int, int]] = field(default_factory=list)  # The index of each context line in old and new.
    end_of_file: bool = False  # The old lines must be at the end of the file.


@dataclass
class FileOp:
    kind: str  # "add", "delete", or "update"
    path: str
    move_to: str | None = None
    hunks: list[Hunk] = field(default_factory=list)  # For "update".
    lines: list[str] = field(default_factory=list)  # For "add".

    @property
    def label(self) -> str:
        return {"add": "Add File", "delete": "Delete File", "update": "Update File"}[self.kind]


def _patch_lines(text: str) -> tuple[list[str], int]:
    """The lines of the patch with no heredoc wrapper, and the patch line number of the first line minus 1."""
    lead = text[:len(text) - len(text.lstrip())].count("\n")
    lines = [line.removesuffix("\r") for line in text.strip().split("\n")]
    if lines and lines[0].strip() != BEGIN and len(lines) >= 3:
        m = _HEREDOC.match(lines[0].strip())
        if m and lines[-1].strip() == m.group(2):
            return lines[1:-1], lead + 1
    return lines, lead


def parse_patch(text: str) -> list[FileOp]:
    """The file operations of a patch. Raises ToolError with the line number and the fix."""
    if not isinstance(text, str) or not text.strip():
        raise ToolError("The patch is empty. " + BOUNDARY_ERROR)
    lines, offset = _patch_lines(text)
    if lines[0].strip() != BEGIN:
        raise ToolError(BOUNDARY_ERROR)
    ops: list[FileOp] = []
    ended = False

    def close(number: int) -> None:
        """Check the update before the next header: it must have a hunk with lines, or a move."""
        if not ops or ops[-1].kind != "update":
            return
        op = ops[-1]
        if not op.hunks and op.move_to is None:
            raise ToolError(f"Line {number}: '*** Update File: {op.path}' has no hunk. Add a hunk that starts with "
                            "'@@', or remove the header.")
        if op.hunks and not op.hunks[-1].old and not op.hunks[-1].new:
            raise ToolError(f"Line {number}: a hunk of {op.path} has no lines. Each hunk needs context, removed, "
                            "or added lines.")

    for index, line in enumerate(lines[1:], start=2):
        number = index + offset
        stripped = line.strip()
        if ended:
            if stripped:
                raise ToolError(f"Line {number}: there is text after '*** End Patch'. " + BOUNDARY_ERROR)
            continue
        in_update = bool(ops) and ops[-1].kind == "update"
        head = line.rstrip() if in_update else stripped
        if head == END:
            close(number)
            ended = True
            continue
        header = next(((kind, head[len(mark):].strip()) for kind, mark in (("add", ADD), ("delete", DELETE),
                                                                            ("update", UPDATE))
                       if head.startswith(mark)), None)
        if header is not None:
            close(number)
            kind, path = header
            if not path:
                raise ToolError(f"Line {number}: the file header has no path.")
            ops.append(FileOp(kind, path))
            continue
        if not stripped and (not ops or ops[-1].kind == "delete"):
            continue  # An empty line between two sections.
        if not ops:
            raise ToolError(HEADER_ERROR.format(line=number, text=stripped))
        op = ops[-1]
        if op.kind == "add":
            if not line.startswith("+"):
                raise ToolError(f"Line {number}: '{stripped}' is not a line of the new file {op.path}. Each line of "
                                "a new file starts with '+'.")
            op.lines.append(line[1:])
            continue
        if op.kind == "delete":
            raise ToolError(HEADER_ERROR.format(line=number, text=stripped))
        _update_line(op, line, head, number)
    if not ended:
        raise ToolError(BOUNDARY_ERROR)
    if not ops:
        raise ToolError("The patch has no file changes. Add an '*** Add File:', '*** Delete File:', or "
                        "'*** Update File:' section.")
    return ops


def _update_line(op: FileOp, line: str, head: str, number: int) -> None:
    """One line of an '*** Update File:' section."""
    hunks = op.hunks
    last = hunks[-1] if hunks else None
    if last is not None and last.end_of_file and head and head != "@@" and not head.startswith("@@ "):
        raise ToolError(f"Line {number}: '{head}' comes after '*** End of File'. Start a new hunk with '@@'.")
    if last is not None and last.end_of_file and not head:
        return
    if head.startswith(MOVE) and not hunks and op.move_to is None:
        op.move_to = head[len(MOVE):].strip()
        if not op.move_to:
            raise ToolError(f"Line {number}: '*** Move to:' has no path.")
        return
    if head == "@@" or head.startswith("@@ "):
        if last is not None and not last.old and not last.new:
            raise ToolError(f"Line {number}: a hunk of {op.path} has no lines. Put the lines of the change after "
                            "the '@@' line.")
        hunks.append(Hunk(head[3:] if head.startswith("@@ ") else None))
        return
    if head == END_OF_FILE:
        if last is None or (not last.old and not last.new):
            raise ToolError(f"Line {number}: '*** End of File' comes before the lines of a hunk.")
        last.end_of_file = True
        return
    if line == "" or line[0] in " +-":
        if last is None:
            last = Hunk(None)
            hunks.append(last)
        sign, body = (line[0], line[1:]) if line else (" ", "")
        if sign == " ":
            last.context.append((len(last.old), len(last.new)))
            last.old.append(body)
            last.new.append(body)
        elif sign == "-":
            last.old.append(body)
        else:
            last.new.append(body)
        return
    raise ToolError(LINE_ERROR.format(line=number, text=line.strip()))


def _seek_line(lines: list[str], target: str, start: int) -> int | None:
    """The first line from ``start`` that is equal to ``target``: exact, then with no end spaces, then stripped."""
    for compare in (lambda a: a, str.rstrip, str.strip):
        want = compare(target)
        for i in range(start, len(lines)):
            if compare(lines[i]) == want:
                return i
    return None


def _seek_exact(lines: list[str], old: list[str], start: int, end_of_file: bool) -> int | None:
    size = len(old)
    first = max(len(lines) - size, start) if end_of_file else start
    for i in range(first, len(lines) - size + 1):
        if lines[i:i + size] == old:
            return i
    return None


def apply_update(text: str, hunks: list[Hunk], path: str = "the file") -> tuple[str, str | None]:
    """The new text of a file after the hunks, and the tolerance that a match needed (None: exact).

    Hunks apply in order: each one searches after the end of the one before. The line endings of the file stay.
    """
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    final_newline = text == "" or text.endswith("\n")
    if final_newline:
        lines.pop()  # The text after the last newline is empty.
    cursor = 0
    tolerance: str | None = None
    replacements: list[tuple[int, int, list[str]]] = []
    for number, hunk in enumerate(hunks, start=1):
        if hunk.header is not None:
            found = _seek_line(lines, hunk.header, cursor)
            if found is None:
                raise ToolError(f"Update File {path}: the line '@@ {hunk.header}' of hunk {number} was not found. "
                                "Read the file and copy the line exactly.")
            cursor = found + 1
        if not hunk.old:
            replacements.append((len(lines), 0, list(hunk.new)))
            continue
        variants = [(hunk.old, hunk.new)]
        if len(hunk.old) > 1 and hunk.old[-1] == "":
            # An empty last context line can stand for the newline at the end of the file.
            variants.append((hunk.old[:-1], hunk.new[:-1] if hunk.new and hunk.new[-1] == "" else hunk.new))
        start = None
        for old, new in variants:
            start = _seek_exact(lines, old, cursor, hunk.end_of_file)
            if start is not None:
                break
        if start is not None:
            replacements.append((start, len(old), list(new)))
            cursor = start + len(old)
            continue
        level, matches = None, []
        for old, new in variants:
            level, matches = scan_lines(lines, old, new, cursor)
            if hunk.end_of_file:
                matches = [m for m in matches if m.last_line == len(lines)]
            if matches:
                break
        if not matches:
            raise ToolError(f"Update File {path}: the context of hunk {number} was not found. Read the file and "
                            "build the hunk from its current text.")
        if len(matches) > 1:
            places = ", ".join(f"{m.first_line}-{m.last_line}" for m in matches[:10])
            raise ToolError(f"Update File {path}: hunk {number} does not match the file exactly. With {level} "
                            f"ignored, it matches {len(matches)} places (lines {places}). Read the file, and copy "
                            "the exact text with more context lines, or add an '@@' line.")
        match = matches[0]
        start = match.first_line - 1
        converted = list(match.new_lines)
        for old_index, new_index in hunk.context:
            if old_index < len(old) and new_index < len(converted):
                converted[new_index] = lines[start + old_index]  # A context line keeps the text of the file.
        replacements.append((start, len(old), converted))
        cursor = start + len(old)
        tolerance = INDENTATION if INDENTATION in (tolerance, level) else level or TRAILING
    for start, size, new_lines in sorted(replacements, key=lambda r: r[0], reverse=True):
        lines[start:start + size] = new_lines
    result = newline.join(lines)
    if final_newline and lines:
        result += newline
    return result, tolerance


@dataclass
class Change:
    """One file that the patch changes. ``before`` None: a new file. ``after`` None: a deleted file."""

    path: Path
    rel: str
    before: bytes | None
    after: bytes | None
    code: str  # A, M, or D, for the result.
    note: str | None = None


class ApplyPatchTool(Tool):
    name = "apply_patch"
    description = (
        "Add, delete, update, or move files with one patch.\n\n"
        "The input is the full patch text, in this format:\n"
        "*** Begin Patch\n"
        "*** Add File: <path>\n"
        "+<a line of the new file>\n"
        "*** Delete File: <path>\n"
        "*** Update File: <path>\n"
        "*** Move to: <new path>\n"
        "@@ <a line above the change, for example a class or def line>\n"
        " <context line>\n"
        "-<removed line>\n"
        "+<added line>\n"
        "*** End of File\n"
        "*** End Patch\n\n"
        "Usage notes:\n"
        "- Give each path relative to the project folder.\n"
        "- Read a file with the read tool before you update or delete it. The tool rejects a change to a file "
        "that you did not read in this session, or that changed after the read.\n"
        "- Each line of a new file starts with +.\n"
        "- In an update, start each hunk with @@. Give 3 lines of context above and below each change. A context "
        "line starts with a space, a removed line with -, and an added line with +.\n"
        "- If the context occurs at more places in the file, put a line above the change after the @@, for "
        "example @@ def main():.\n"
        "- \"*** Move to:\" is optional. It renames the file. \"*** End of File\" is optional. It means that the "
        "hunk is at the end of the file.\n"
        "- Put all the hunks of one file in one Update File section, in the order of the file.\n"
        "- If a hunk does not match the file, no file changes. Read the file again, and send the patch again.\n"
        "- Call this tool. Do not send a patch as a bash command.\n"
        "- For Word, PowerPoint, or Excel files, use office_edit."
    )
    parameters = {
        "type": "object",
        "properties": {
            "input": {"type": "string",
                      "description": "The full patch, from '*** Begin Patch' to '*** End Patch'."},
        },
        "required": ["input"],
    }
    needs_approval = True

    @staticmethod
    def _text(args: dict[str, Any]) -> str:
        text = args.get("input")
        if text is None:
            text = args.get("patch")  # Some models send the patch under this name.
        if not isinstance(text, str):
            raise ToolError("input must be a string with the full patch. " + BOUNDARY_ERROR)
        return text

    def validate(self, args: dict[str, Any]) -> None:
        if args.get("input") is None and args.get("patch") is None:
            raise ToolError("Missing required argument: input")

    @staticmethod
    def _resolve(ctx: ToolContext, op: FileOp, path: str) -> Path:
        try:
            return ctx.resolve(path)
        except ToolError as e:
            raise ToolError(f"{op.label} {path}: {e}") from None

    @staticmethod
    def _read(ctx: ToolContext, op: FileOp, path: Path) -> bytes:
        if path.is_dir():
            raise ToolError(f"{op.label} {op.path}: this is a folder, not a file.")
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            raise ToolError(f"{op.label} {op.path}: the file does not exist. Use '*** Add File:' to create "
                            "it.") from None
        if ctx.reads is not None:
            ctx.reads.check(path, data, op.path)
        return data

    def _plan(self, args: dict[str, Any], ctx: ToolContext) -> list[Change]:
        """Parse the patch and build all new contents in memory. A failure changes no file."""
        ops = parse_patch(self._text(args))
        changes: list[Change] = []
        seen: set[str] = set()

        def claim(op: FileOp, path: Path, shown: str) -> None:
            key = os.path.normcase(str(path))
            if key in seen:
                raise ToolError(f"{op.label} {shown}: the patch changes this file two times. Put all the hunks of "
                                "one file in one '*** Update File:' section.")
            seen.add(key)

        for op in ops:
            path = self._resolve(ctx, op, op.path)
            claim(op, path, op.path)
            rel = relpath(ctx.cwd, path)
            if op.kind == "add":
                if path.exists():
                    raise ToolError(f"Add File {op.path}: the file exists. Use '*** Update File:' to change it.")
                after = "".join(line + "\n" for line in op.lines).encode("utf-8")
                changes.append(Change(path, rel, None, after, "A"))
                continue
            data = self._read(ctx, op, path)
            if op.kind == "delete":
                changes.append(Change(path, rel, data, None, "D"))
                continue
            if is_binary(data):
                raise ToolError(f"Update File {op.path}: this is a binary file.")
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                raise ToolError(f"Update File {op.path}: the file is not UTF-8 text.") from None
            updated, tolerance = apply_update(text, op.hunks, op.path)
            note = None
            if tolerance is not None:
                note = (f"In {rel}, the hunk context did not match the file exactly. The harness ignored a "
                        f"difference in {tolerance}. Copy the text from the read result exactly next time.")
            after = updated.encode("utf-8")
            if op.move_to is None:
                changes.append(Change(path, rel, data, after, "M", note))
                continue
            target = self._resolve(ctx, op, op.move_to)
            if target != path:
                claim(op, target, op.move_to)
                if target.exists():
                    raise ToolError(f"Update File {op.path}: the move target {op.move_to} exists. Move the file to a "
                                    "new path, or update the target file.")
                changes.append(Change(path, rel, data, None, "D"))
                changes.append(Change(target, relpath(ctx.cwd, target), None, after, "A", note))
            else:
                changes.append(Change(path, rel, data, after, "M", note))
        return changes

    @staticmethod
    def _diff(changes: list[Change]) -> str:
        parts = []
        for c in changes:
            before = (c.before or b"").decode("utf-8", errors="replace")
            after = (c.after or b"").decode("utf-8", errors="replace")
            parts.append(unified_diff(before, after, c.rel, new_file=c.before is None, deleted=c.after is None))
        return "".join(parts)

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval:
        changes = self._plan(args, ctx)
        rels = [c.rel for c in changes]
        # One file: "Always allow" adds edit(<path>). Several files: no rule, so the user decides each time.
        rule = f"edit({rels[0]})" if len(rels) == 1 else ""
        return Approval(key=rels[0], keys=tuple(rels), rule=rule, tool="edit", diff=self._diff(changes),
                        input={"paths": rels, "patch": self._text(args)})

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        changes = self._plan(args, ctx)  # Again after the approval: a file can change while the user decides.
        done: list[Change] = []
        for change in changes:
            try:
                if change.after is None:
                    change.path.unlink()
                else:
                    change.path.parent.mkdir(parents=True, exist_ok=True)
                    change.path.write_bytes(change.after)
            except OSError as e:
                names = ", ".join(c.rel for c in done) or "none"
                return ToolResult(f"The patch stopped at {change.rel}: {type(e).__name__}: {e}. Files that changed "
                                  f"before the error: {names}. Read these files before you send a new patch.",
                                  is_error=True, changed_paths=[c.path for c in done], diff=self._diff(done) or None)
            if change.after is not None and ctx.reads is not None:
                ctx.reads.note(change.path, change.after)  # The agent knows the new text: no new read is necessary.
            done.append(change)
        lines = ["Applied the patch."] + [f"{c.code} {c.rel}" for c in changes]
        lines += [c.note for c in changes if c.note]
        return ToolResult("\n".join(lines), changed_paths=[c.path for c in changes], diff=self._diff(changes))
