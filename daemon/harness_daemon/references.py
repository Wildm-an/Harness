"""Line references in a prompt (SPEC.md section 8.5, "Context from the editor").

The user selects lines in the editor and sends them to the chat as ``@src/app.py:10-25``.
The daemon adds the text of those lines to the prompt. The client shows the prompt as
the user typed it.
"""

from __future__ import annotations

import re
from pathlib import Path

from .files import PathError, is_binary, resolve_in_cwd

# "@path:10" or "@path:10-25". The path has no spaces. "@" is not part of a word or an e-mail address.
REFERENCE_RE = re.compile(r"(?<![\w@])@([^\s@:]+):(\d+)(?:-(\d+))?\b")
MAX_LINES = 400
MAX_TOTAL_CHARS = 60_000


def expand_references(text: str, cwd: Path) -> str:
    """Return ``text`` with the referenced lines added at the end. Unknown references stay as they are."""
    blocks: list[str] = []
    total = 0
    seen: set[tuple[str, int, int]] = set()
    for m in REFERENCE_RE.finditer(text):
        rel, start = m.group(1), int(m.group(2))
        end = int(m.group(3) or start)
        if end < start:
            start, end = end, start
        key = (rel, start, end)
        if key in seen or start < 1:
            continue
        seen.add(key)
        try:
            path = resolve_in_cwd(cwd, rel)
            data = path.read_bytes()
        except (PathError, OSError):
            continue
        if is_binary(data):
            continue
        lines = data.decode("utf-8", errors="replace").splitlines()
        if start > len(lines):
            continue
        end = min(end, len(lines), start + MAX_LINES - 1)
        body = "\n".join(f"{n:>6}\t{lines[n - 1]}" for n in range(start, end + 1))
        block = f"{rel} lines {start}-{end}:\n```\n{body}\n```"
        if total + len(block) > MAX_TOTAL_CHARS:
            blocks.append(f"[More referenced lines were not added: the limit is {MAX_TOTAL_CHARS} characters.]")
            break
        total += len(block)
        blocks.append(block)
    if not blocks:
        return text
    return f"{text}\n\nThe user referenced these lines:\n\n" + "\n\n".join(blocks)
