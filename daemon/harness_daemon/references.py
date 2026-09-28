"""References in a prompt (SPEC.md section 8.5, "Context from the editor").

The user adds a reference with the "@" menu of the prompt box, or from the editor:

- ``@src/app.py:10-25`` or ``@src/app.py:10``: lines of a file.
- ``@src/app.py``: a file. ``@src/``: the files of a folder.
- ``@session:<id>``: the messages of another session.

The daemon adds the referenced text at the end of the prompt. The client shows the prompt as
the user typed it. A reference that is not valid stays as text, for example an e-mail address.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .files import PathError, is_binary, resolve_in_cwd

# "@" is not part of a word or an e-mail address. The token has no spaces.
REFERENCE_RE = re.compile(r"(?<![\w@])@([^\s@]+)")
LINES_RE = re.compile(r"^(.+?):(\d+)(?:-(\d+))?$")
SESSION_RE = re.compile(r"^session:([0-9a-f]{8,64})$")
# Punctuation after a reference is part of the sentence: "Read @src/app.py."
TRAILING = ".,;:!?)]}'\""

MAX_LINES = 400  # For a line reference.
MAX_FILE_LINES = 2000  # For a file reference.
MAX_DIR_ENTRIES = 200
MAX_SESSION_CHARS = 20_000
MAX_TOTAL_CHARS = 60_000

# The stored session for a reference: its row (title, cwd) and its messages. None if it does not exist.
LoadSession = Callable[[str], "tuple[dict[str, Any], list[dict[str, Any]]] | None"]


@dataclass(frozen=True)
class Reference:
    kind: str  # "lines", "path", or "session".
    target: str  # The path, or the session id.
    start: int = 0
    end: int = 0


def parse_reference(token: str) -> Reference | None:
    """The reference of one "@" token (without the "@"), or None."""
    token = token.rstrip(TRAILING)
    session = SESSION_RE.match(token)
    if session:
        return Reference("session", session.group(1))
    lines = LINES_RE.match(token)
    if lines:
        start = int(lines.group(2))
        end = int(lines.group(3) or start)
        start, end = min(start, end), max(start, end)
        return Reference("lines", lines.group(1), start, end) if start >= 1 else None
    return Reference("path", token) if token else None


def _lines_block(cwd: Path, ref: Reference) -> str | None:
    try:
        data = resolve_in_cwd(cwd, ref.target).read_bytes()
    except (PathError, OSError):
        return None
    if is_binary(data):
        return None
    lines = data.decode("utf-8", errors="replace").splitlines()
    if ref.start > len(lines):
        return None
    end = min(ref.end, len(lines), ref.start + MAX_LINES - 1)
    body = "\n".join(f"{n:>6}\t{lines[n - 1]}" for n in range(ref.start, end + 1))
    return f"{ref.target} lines {ref.start}-{end}:\n```\n{body}\n```"


def _path_block(cwd: Path, ref: Reference) -> str | None:
    try:
        path = resolve_in_cwd(cwd, ref.target)
    except PathError:
        return None
    if path.is_dir():
        try:
            names = sorted(os.listdir(path), key=str.lower)
        except OSError:
            return None
        entries = [f"{n}/" if (path / n).is_dir() else n for n in names if n != ".git"]
        more = f"\n[{len(entries) - MAX_DIR_ENTRIES} more entries]" if len(entries) > MAX_DIR_ENTRIES else ""
        return f"The folder {ref.target} has these entries:\n```\n" + "\n".join(entries[:MAX_DIR_ENTRIES]) + f"\n```{more}"
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if is_binary(data):
        return None
    lines = data.decode("utf-8", errors="replace").splitlines()
    shown = lines[:MAX_FILE_LINES]
    body = "\n".join(f"{n:>6}\t{line}" for n, line in enumerate(shown, 1))
    more = f"\n[The file has {len(lines)} lines. Only the first {MAX_FILE_LINES} are here.]" if len(lines) > len(shown) else ""
    return f"{ref.target}:\n```\n{body}\n```{more}"


def _message_text(message: dict[str, Any]) -> str | None:
    """The text of a user or assistant message. Tool calls and tool outputs are not in it."""
    if message.get("role") not in ("user", "assistant"):
        return None
    content = message.get("display") or message.get("content")
    if isinstance(content, list):  # Text and image parts.
        content = "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return content.strip() if isinstance(content, str) and content.strip() else None


def _session_block(load_session: LoadSession | None, ref: Reference) -> str | None:
    found = load_session(ref.target) if load_session else None
    if found is None:
        return None
    row, messages = found
    lines = []
    for m in messages:
        text = _message_text(m)
        if text:
            lines.append(f"{'User' if m['role'] == 'user' else 'Agent'}: {text}")
    # The newest messages are the most useful. Keep the end of the session.
    kept: list[str] = []
    size = 0
    for line in reversed(lines):
        if size + len(line) > MAX_SESSION_CHARS:
            break
        kept.append(line)
        size += len(line)
    kept.reverse()
    note = f"[{len(lines) - len(kept)} earlier messages are not here.]\n" if len(kept) < len(lines) else ""
    title = row.get("title") or "Untitled session"
    return (f'The session "{title}" (id {ref.target}, folder {row.get("cwd")}) has these messages:\n'
            f"{note}" + ("\n\n".join(kept) if kept else "[The session has no messages.]"))


def session_ids(text: str) -> set[str]:
    """The ids of the sessions that ``text`` references, so that the caller can load them first."""
    ids = set()
    for m in REFERENCE_RE.finditer(text):
        ref = parse_reference(m.group(1))
        if ref is not None and ref.kind == "session":
            ids.add(ref.target)
    return ids


def expand_references(text: str, cwd: Path, load_session: LoadSession | None = None) -> str:
    """Return ``text`` with the referenced text added at the end. Unknown references stay as they are."""
    blocks: list[str] = []
    total = 0
    seen: set[Reference] = set()
    for m in REFERENCE_RE.finditer(text):
        ref = parse_reference(m.group(1))
        if ref is None or ref in seen:
            continue
        seen.add(ref)
        if ref.kind == "session":
            block = _session_block(load_session, ref)
        elif ref.kind == "lines":
            block = _lines_block(cwd, ref)
        else:
            block = _path_block(cwd, ref)
        if block is None:
            continue
        if total + len(block) > MAX_TOTAL_CHARS:
            blocks.append(f"[More references were not added: the limit is {MAX_TOTAL_CHARS} characters.]")
            break
        total += len(block)
        blocks.append(block)
    if not blocks:
        return text
    return f"{text}\n\nThe user referenced these items:\n\n" + "\n\n".join(blocks)
