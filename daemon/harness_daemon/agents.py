"""Agent types for the agent tool, as the subagents of Claude Code.

Built-in types:

- ``general-purpose``: all the tools of the session. The default.
- ``Explore``: a fast search agent. It reads and searches, and does not change files.
- ``Plan``: a software architect. It reads the code and returns a plan, and does not change files.

Custom types are Markdown files with frontmatter, as in Claude Code::

    ---
    name: test-runner
    description: Runs the tests and reports the failures. Use it after a code change.
    tools: Read, Grep, Glob, Bash        # Optional. No list: all the tools.
    model: inherit                       # Optional. "inherit", or <provider>/<model> of providers.json.
    ---
    You run the tests of this project ...  (the body is the system prompt of the agent)

The folders, from low to high priority (a name in a later folder replaces it):
``~/.claude/agents``, ``~/.harness/agents``, ``<project>/.claude/agents``, ``<project>/.harness/agents``.
"""

from __future__ import annotations

import fnmatch
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import harness_home
from .skills import claude_home, parse_frontmatter, split_frontmatter

log = logging.getLogger("harness.agents")

DEFAULT_TYPE = "general-purpose"
MAX_PROMPT_CHARS = 20_000
MAX_FILES = 100
NAME_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,63}$")

# The Claude Code tool names, and the Harness tools that they are.
CLAUDE_TOOLS: dict[str, tuple[str, ...]] = {
    "read": ("read",),
    "write": ("write",),
    "edit": ("edit", "office_edit"),
    "multiedit": ("edit",),
    "glob": ("glob",),
    "grep": ("grep",),
    "ls": ("glob",),
    "bash": ("bash", "task_output", "task_stop", "monitor"),
    "bashoutput": ("task_output",),
    "killshell": ("task_stop",),
    "webfetch": ("web_fetch",),
    "websearch": ("web_search",),
    "todowrite": ("update_plan",),
    "skill": ("skill",),
}

READ_ONLY_TOOLS = ("read", "glob", "grep", "bash", "task_output", "web_search", "web_fetch", "skill",
                   "preview_snapshot", "preview_console", "preview_logs", "preview_screenshot")

EXPLORE_PROMPT = """You are an Explore agent: a fast, read-only search agent.
- Find files and code with glob and grep. Read the parts that answer the task.
- Do not change files. Use bash only for commands that read, for example git log or ls.
- Search in more than one place and with more than one name, when the first search finds nothing.
- Your report goes to another agent. Give the file paths with line numbers, and short facts. No preamble."""

PLAN_PROMPT = """You are a Plan agent: a software architect. You read the code and design a plan.
- Read the code that the task touches, and the code around it. Do not change files.
- Give a plan in steps. For each step: the files, the change, and why.
- Name the risks, the trade-offs, and the tests that check the change.
- Your report goes to another agent. Make it complete, so that it can do the work with no more search."""


@dataclass
class AgentType:
    name: str
    description: str
    prompt: str = ""  # Added to the system prompt of the subagent.
    tools: tuple[str, ...] | None = None  # Harness tool names or patterns. None: all the tools.
    model: str | None = None  # <provider>/<model>. None: the model of the session.
    source: str = "built-in"  # built-in, user, or project
    path: Path | None = None

    def allows(self, tool: str) -> bool:
        if self.tools is None:
            return True
        return any(fnmatch.fnmatchcase(tool, pattern) for pattern in self.tools)

    def summary(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "source": self.source,
                "path": str(self.path) if self.path else None, "model": self.model,
                "tools": list(self.tools) if self.tools is not None else None}


BUILT_IN = (
    AgentType(DEFAULT_TYPE, "For research, code search, and tasks with many steps. It has all the tools."),
    AgentType("Explore", "A fast, read-only agent to find files and code, and to answer questions about the "
              "code. Give the search breadth in the prompt: quick, medium, or very thorough.",
              EXPLORE_PROMPT, READ_ONLY_TOOLS),
    AgentType("Plan", "A read-only software architect. It returns a plan in steps with the files to change, "
              "the risks, and the tests.", PLAN_PROMPT, READ_ONLY_TOOLS),
)


def map_tools(value: Any) -> tuple[str, ...] | None:
    """The tools of a custom agent: Claude Code names (Read, Bash) or Harness names (read, bash)."""
    if value is None:
        return None
    items = value if isinstance(value, list) else re.split(r"[,\s]+", str(value))
    out: list[str] = []
    for raw in items:
        name = str(raw).strip()
        if not name:
            continue
        if name == "*":
            return None
        name = re.sub(r"\(.*\)$", "", name)  # "Bash(git:*)": the rule part is for permissions, not here.
        if name.startswith("mcp__"):
            out.append(name)
            continue
        key = name.lower().replace("_", "")
        out.extend(CLAUDE_TOOLS.get(key, (name.lower(),)))
    return tuple(dict.fromkeys(out))


def parse_agent(path: Path, source: str) -> AgentType | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    raw, body = split_frontmatter(text)
    meta = parse_frontmatter(raw)
    name = str(meta.get("name") or path.stem).strip()
    description = str(meta.get("description") or "").strip()
    if not NAME_RE.match(name) or not description:
        log.warning("Skipped the agent file %s: it needs a name and a description.", path)
        return None
    model = str(meta.get("model") or "").strip() or None
    if model and (model == "inherit" or "/" not in model):
        model = None  # "inherit", or a Claude Code alias such as "sonnet": the model of the session.
    return AgentType(name=name, description=description[:1000], prompt=body.strip()[:MAX_PROMPT_CHARS],
                     tools=map_tools(meta.get("tools")), model=model, source=source, path=path)


def agent_folders(cwd: Path | None) -> list[tuple[Path, str]]:
    folders = [(claude_home() / "agents", "user"), (harness_home() / "agents", "user")]
    if cwd is not None:
        folders += [(cwd / ".claude" / "agents", "project"), (cwd / ".harness" / "agents", "project")]
    return folders


def discover_agents(cwd: Path | None) -> dict[str, AgentType]:
    """The agent types, by name: the built-in types, then the files. A later file replaces a name."""
    found: dict[str, AgentType] = {a.name: a for a in BUILT_IN}
    for folder, source in agent_folders(cwd):
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.md"))[:MAX_FILES]:
            agent = parse_agent(path, source)
            if agent is not None:
                found[agent.name] = agent
    return found
