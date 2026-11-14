"""The data of one trial: the task, the workspace, the events of the session, and the baseline of the files."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .tasks import Task

SKIP = {".git", ".harness", "__pycache__", "node_modules"}


def file_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def workspace_files(root: Path) -> dict[str, str]:
    """The relative path and the SHA-256 of each file, with no .git, .harness, or caches."""
    out = {}
    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if path.is_file() and not (set(rel.parts) & SKIP):
            out[rel.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return out


@dataclass
class Trial:
    task: Task
    workspace: Path
    baseline: dict[str, str] = field(default_factory=dict)
    baseline_text: dict[str, str] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    approvals: list[dict[str, Any]] = field(default_factory=list)
    stop_reasons: list[str] = field(default_factory=list)
    timed_out: bool = False
    error: str | None = None
    session_id: str | None = None

    @property
    def final_text(self) -> str:
        """The text of the last turn."""
        ends = [i for i, e in enumerate(self.events) if e.get("type") == "turn.end"]
        start = ends[-2] if len(ends) >= 2 else -1
        return "".join(e.get("text", "") for e in self.events[start + 1:] if e.get("type") == "token")

    def usage(self) -> dict[str, int]:
        total = {"prompt_tokens": 0, "completion_tokens": 0}
        for e in self.events:
            if e.get("type") == "turn.end":
                for key in total:
                    total[key] += int((e.get("usage") or {}).get(key) or 0)
        return total
