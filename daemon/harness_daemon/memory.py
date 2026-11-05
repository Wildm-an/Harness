"""Auto memory: notes that the agent keeps between sessions, as the auto memory of Claude Code.

Each project has a folder ``~/.harness/projects/<project>/memory``. Each memory is one Markdown file
with frontmatter (name, description, type), and ``MEMORY.md`` is the index: one line for each memory.
The system prompt of the agent that the user talks to includes the index. The agent saves, reads,
and deletes memories with the memory tool (tools/memory.py). The setting ``auto_memory`` off removes
both. A worktree session uses the memory of its project.
"""

from __future__ import annotations

import base64
import io
import re
import zipfile
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
{sensitive}

MEMORY.md:
{index}"""


# The setting "memory_sensitive" (Settings > Your Harness > "Include sensitive topics in memory").
SENSITIVE_OFF = """- Do not save sensitive topics: health conditions, religious or political beliefs, sexual
  orientation, ethnic origin, union membership, or criminal records. Save one only when the user
  asks you to remember it."""
SENSITIVE_ON = "- You can save sensitive topics, for example health conditions, when they will help in a later session."

# The prompt for "Import memory from other AI providers": the user gives it to the other assistant,
# and pastes the reply in Harness. parse_import reads the reply.
IMPORT_PROMPT = """List everything that you remember about me from our past conversations: my work, my projects, my preferences, how I want you to answer, and the tools and resources that I use.

Write one fact on each line, in this format, with no other text:
[type] fact

Use one of these types:
- user: who I am (role, knowledge, preferences)
- feedback: how I want you to work or to answer
- project: my projects, goals, and decisions
- reference: links and outside resources that I use

Write each fact as one or two complete sentences. Give dates as absolute dates. Do not include sensitive topics, for example health conditions, unless I told you to remember them."""

_IMPORT_LINE = re.compile(r"^\s*(?:[-*•]|\d+[.)])?\s*\[?\s*(user|feedback|project|reference)\s*[\]:]\s*(.+)$", re.I)


def parse_import(text: str) -> list[dict[str, str]]:
    """The facts of an import reply: one "[type] fact" line each. A line with no type is a "user" fact."""
    out: list[dict[str, str]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("```"):
            continue
        m = _IMPORT_LINE.match(line)
        kind, fact = (m.group(1).lower(), m.group(2)) if m else ("user", re.sub(r"^(?:[-*•]|\d+[.)])\s*", "", line))
        fact = " ".join(fact.split())
        if fact:
            out.append({"type": kind, "content": fact[:MAX_CONTENT]})
    return out


def slug(text: str) -> str:
    """A kebab-case memory name from the first words of a text."""
    words = re.findall(r"[a-z0-9]+", text.lower())[:6]
    name = "-".join(words)[:48].strip("-")
    return name or "memory"


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

    def prompt(self, sensitive: bool = False) -> str:
        lines = self.index().strip().splitlines()
        shown = "\n".join(lines[:MAX_INDEX_LINES])[:MAX_INDEX_CHARS]
        if len(lines) > MAX_INDEX_LINES:
            shown += f"\n(The index has {len(lines)} lines. Only the first {MAX_INDEX_LINES} are shown.)"
        return PROMPT.format(folder=self.dir, index=shown or "(No memories yet.)",
                             sensitive=SENSITIVE_ON if sensitive else SENSITIVE_OFF)

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

    def entries(self) -> list[dict[str, str]]:
        """Each memory of the index with its type and content, for Settings > Your Harness > Manage."""
        out = []
        for item in self.items():
            path = self.dir / item["file"]
            if path.parent != self.dir or path.suffix != ".md":
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            kind, content = "user", text.strip()
            m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?(.*)$", text, re.S)
            if m:
                content = m.group(2).strip()
                t = re.search(r"^type:\s*(\S+)", m.group(1), re.M)
                if t and t.group(1) in TYPES:
                    kind = t.group(1)
            out.append({"name": path.stem, "description": item["description"], "type": kind, "content": content})
        return out

    def import_facts(self, facts: list[dict[str, str]]) -> int:
        """Save each fact as a new memory with a name from its first words. Return the count."""
        taken = {p.stem for p in self.dir.glob("*.md")} if self.dir.is_dir() else set()
        count = 0
        for fact in facts:
            content = " ".join(str(fact.get("content") or "").split())
            kind = fact.get("type") if fact.get("type") in TYPES else "user"
            if not content:
                continue
            base = slug(content)
            name, n = base, 2
            while name in taken:
                name, n = f"{base}-{n}", n + 1
            description = content if len(content) <= MAX_DESCRIPTION else content[:MAX_DESCRIPTION - 1].rstrip() + "…"
            self.save(name, description, str(kind), content)
            taken.add(name)
            count += 1
        return count

    def export_zip(self) -> str:
        """The memory files and MEMORY.md in a .zip, as base64."""
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
            if self.dir.is_dir():
                for path in sorted(self.dir.glob("*.md")):
                    z.write(path, f"memory/{path.name}")
        return base64.b64encode(buffer.getvalue()).decode("ascii")
