"""The tolerant match of the edit tool: old_string that differs from the file only in whitespace at the line ends,
or in a constant indentation.

Aider measured that a strict match gave 9 times more edit errors than a flexible one. The levels here stay safe:
- They compare whole lines. A fragment inside a line matches only exactly.
- Whitespace inside a line never counts as equal: a string literal can depend on it.
- A level needs exactly one match. An ambiguous match is an error with the line numbers.
- The indentation rules keep the relative indentation of the new text: Python blocks and Makefile tabs stay correct.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

TRAILING = "trailing whitespace"
INDENTATION = "indentation"
_INDENT = re.compile(r"^[ \t]*")


@dataclass(frozen=True)
class Match:
    first_line: int  # 1-based, in the file.
    last_line: int
    new_lines: list[str]  # The new text for these lines, in the indentation of the file.
    tolerance: str


def _indent(line: str) -> str:
    return _INDENT.match(line).group(0)


def _lines(text: str) -> list[str]:
    lines = text.replace("\r\n", "\n").split("\n")
    if len(lines) > 1 and lines[-1] == "":
        lines = lines[:-1]  # The newline at the end of old_string closes its last line.
    return lines


def _reindent(old: list[str], found: list[str], new: list[str]) -> list[str] | None:
    """The new lines in the indentation of the file, by one rule that explains each old line. None: no rule."""
    pairs = [(_indent(o), _indent(f)) for o, f in zip(old, found) if o.strip()]
    if not pairs:
        return None
    # A: the file has one more prefix for each line. B: the file has one prefix less.
    head_o, head_f = pairs[0]
    if head_f.endswith(head_o) and all(f == head_f[:len(head_f) - len(head_o)] + o for o, f in pairs):
        prefix = head_f[:len(head_f) - len(head_o)]
        return [prefix + line if line.strip() else line for line in new]
    if head_o.endswith(head_f) and all(o == head_o[:len(head_o) - len(head_f)] + f for o, f in pairs):
        prefix = head_o[:len(head_o) - len(head_f)]
        if any(line.strip() and not line.startswith(prefix) for line in new):
            return None
        return [line[len(prefix):] if line.strip() else line for line in new]
    # C: tabs in the file, spaces in old_string. D: the reverse. One constant number of spaces for each tab.
    for n in (2, 4, 8):
        if all(set(o) <= {" "} and set(f) <= {"\t"} and len(o) == n * len(f) for o, f in pairs):
            out = []
            for line in new:
                spaces = _indent(line)
                if line.strip() and (set(spaces) - {" "} or len(spaces) % n):
                    return None
                out.append("\t" * (len(spaces) // n) + line[len(spaces):] if line.strip() else line)
            return out
        if all(set(o) <= {"\t"} and set(f) <= {" "} and len(f) == n * len(o) for o, f in pairs):
            out = []
            for line in new:
                tabs = _indent(line)
                if line.strip() and set(tabs) - {"\t"}:
                    return None
                out.append(" " * (n * len(tabs)) + line[len(tabs):] if line.strip() else line)
            return out
    return None


def find_tolerant(text: str, old: str, new: str) -> tuple[str | None, list[Match]]:
    """The matches of the first tolerant level that finds one: (level, matches). (None, []): no match."""
    file_lines = text.replace("\r\n", "\n").split("\n")
    old_lines, new_lines = _lines(old), _lines(new)
    size = len(old_lines)
    if not any(line.strip() for line in old_lines):
        return None, []
    for level in (TRAILING, INDENTATION):
        matches = []
        for i in range(len(file_lines) - size + 1):
            found = file_lines[i:i + size]
            if level == TRAILING:
                if all(f.rstrip() == o.rstrip() for f, o in zip(found, old_lines)):
                    matches.append(Match(i + 1, i + size, new_lines, TRAILING))
            elif all(f.strip() == o.strip() for f, o in zip(found, old_lines)):
                converted = _reindent(old_lines, found, new_lines)
                if converted is not None:
                    matches.append(Match(i + 1, i + size, converted, INDENTATION))
        if matches:
            return level, matches
    return None, []


def apply_match(text: str, match: Match) -> str:
    """The file text with the matched lines replaced. The line endings of the file stay."""
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    lines[match.first_line - 1:match.last_line] = match.new_lines
    return newline.join(lines)
