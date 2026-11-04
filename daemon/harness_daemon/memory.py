"""Auto memory: notes that the agent keeps between sessions, as the auto memory of Claude Code.

Each project has a folder ``~/.harness/projects/<project>/memory``. Each memory is one Markdown file
with frontmatter (name, description, type), and ``MEMORY.md`` is the index: one line for each memory.
The system prompt of the agent that the user talks to includes the index. The agent saves, reads,
and deletes memories with the memory tool (tools/memory.py). The setting ``auto_memory`` off removes
both. A worktree session uses the memory of its project.
"""

from __future__ import annotations

import re
from pathlib import Path

from .config import harness_home

INDEX = "MEMORY.md"
TYPES = ("user", "feedback", "project", "reference")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_CONTENT = 5_000
MAX_DESCRIPTION = 200
MAX_INDEX_LINES = 200  # The prompt shows this many lines of the index.
MAX_INDEX_CHARS = 20_000

PROMPT = """# Memory

You have a memory that stays between sessions, in {folder}. The index MEMORY.md is below. Use the
memory tool to save, read, and delete memories.

- Save a fact when it will help in a later session: who the user is (role, knowledge, preferences),
  how the user wants you to work (also a correction, with the reason), facts about the project that
  the code and the git history do not show (goals, decisions, dates as absolute dates), and pointers
  to outside resources (URLs, dashboards, tickets).
- Do not save what the code, the docs, or the git history already show, or facts for this conversation only.
- Before you save, read the index. Update a memory on the same topic: do not make a duplicate.
- Delete a memory that is wrong.
- When the user asks you to remember or forget something, do it with the memory tool at once.
- A memory was true when it was written. Before you use a memory that names a file, a function, or a
  flag, check that it still exists.

MEMORY.md:
{index}"""


def project_root(cwd: Path) -> Path:
    """The project of a folder. A worktree (<project>/.harness/worktrees/<name>) belongs to its project."""
    parts = cwd.parts
    for i in range(len(parts) - 2):
        if parts[i] == ".harness" and parts[i + 1] == "worktrees":
            return Path(*parts[:i])
    return cwd


def memory_dir(cwd: Path) -> Path:
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(project_root(Path(cwd)).resolve()))
    return harness_home() / "projects" / slug / "memory"


class MemoryError(Exception):
    """A bad memory request. The message goes to the model."""


class MemoryStore:
    def __init__(self, cwd: Path):
        self.dir = memory_dir(cwd)

    @property
    def index_path(self) -> Path:
        return self.dir / INDEX

    def index(self) -> str:
        try:
            return self.index_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def prompt(self) -> str:
        lines = self.index().strip().splitlines()
        shown = "\n".join(lines[:MAX_INDEX_LINES])[:MAX_INDEX_CHARS]
        if len(lines) > MAX_INDEX_LINES:
            shown += f"\n(The index has {len(lines)} lines. Only the first {MAX_INDEX_LINES} are shown.)"
        return PROMPT.format(folder=self.dir, index=shown or "(No memories yet.)")

    def _file(self, name: str) -> Path:
        name = (name or "").strip().lower()
        if not NAME_RE.match(name):
            raise MemoryError("The name must be a short kebab-case slug, for example 'user-role' or 'release-steps'.")
        return self.dir / f"{name}.md"

    def save(self, name: str, description: str, kind: str, content: str) -> str:
        path = self._file(name)
        description = " ".join((description or "").split())
        if not description:
            raise MemoryError("Give a one-line description of the memory.")
        if len(description) > MAX_DESCRIPTION:
            raise MemoryError(f"The description has more than {MAX_DESCRIPTION} characters. Make it one short line.")
        if kind not in TYPES:
            raise MemoryError(f"The type must be one of: {', '.join(TYPES)}.")
        content = (content or "").strip()
        if not content:
            raise MemoryError("Give the content of the memory.")
        if len(content) > MAX_CONTENT:
            raise MemoryError(f"The content has more than {MAX_CONTENT} characters. Keep one fact in each memory.")
        self.dir.mkdir(parents=True, exist_ok=True)
        existed = path.exists()
        path.write_text(f"---\nname: {path.stem}\ndescription: {description}\ntype: {kind}\n---\n\n{content}\n",
                        encoding="utf-8")
        self._set_index_line(path.name, f"- [{path.stem}]({path.name}) — {description}")
        return f"{'Updated' if existed else 'Saved'} the memory {path.stem}."

    def read(self, name: str) -> str:
        path = self._file(name)
        if not path.exists():
            raise MemoryError(f"No memory with the name {path.stem}. The index lists the memories.")
        return path.read_text(encoding="utf-8", errors="replace")

    def delete(self, name: str) -> str:
        path = self._file(name)
        if not path.exists():
            raise MemoryError(f"No memory with the name {path.stem}.")
        path.unlink()
        self._set_index_line(path.name, None)
        return f"Deleted the memory {path.stem}."

    def _set_index_line(self, file: str, line: str | None) -> None:
        """Replace the index line of a file, add it at the end, or remove it (line None)."""
        lines = self.index().splitlines()
        marker = f"]({file})"
        kept = [x for x in lines if marker not in x]
        if line is not None:
            at = next((i for i, x in enumerate(lines) if marker in x), None)
            if at is None:
                kept.append(line)
            else:
                kept.insert(min(at, len(kept)), line)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.index_path.write_text("\n".join(kept).strip() + "\n" if kept else "", encoding="utf-8")

    def items(self) -> list[dict[str, str]]:
        out = []
        for line in self.index().splitlines():
            m = re.match(r"^- \[([^\]]+)\]\(([^)]+)\)\s*[—-]?\s*(.*)$", line.strip())
            if m:
                out.append({"name": m.group(1), "file": m.group(2), "description": m.group(3)})
        return out
