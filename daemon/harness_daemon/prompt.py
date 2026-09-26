"""The system prompt: base rules, environment, project instructions, and the context summary."""

from __future__ import annotations

import datetime
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .tools import ToolContext

if TYPE_CHECKING:
    from .skills import Skill

BASE_PROMPT = """\
You are a coding agent. You work in the project folder of the user. \
You use tools to find files, read files, change files, and run commands.

Rules:
- Use glob to find files by name. Use grep to find text in files.
- Read a file before you change it.
- Make only the changes that the user asks for.
- Use the edit tool to change part of an existing file. Use the write tool to create a file.
- Keep your replies short. Do not repeat file contents in your reply.
- If a tool returns an error, read the error. Then try a different approach.
- If the user denies a tool call, stop. Ask the user what to do.
- When the task is complete, stop. Give a short summary of the changes."""

# Instruction files, in order of priority. The first file that exists is used.
INSTRUCTION_FILES = ("HARNESS.md", "CLAUDE.md")
MAX_INSTRUCTION_CHARS = 40_000
MAX_SKILL_DESCRIPTION = 300
MAX_SKILLS_IN_PROMPT = 60


@dataclass(frozen=True)
class ProjectInstructions:
    name: str
    text: str
    truncated: bool


def load_project_instructions(cwd: Path) -> ProjectInstructions | None:
    for name in INSTRUCTION_FILES:
        path = Path(cwd) / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            continue
        truncated = len(text) > MAX_INSTRUCTION_CHARS
        return ProjectInstructions(name, text[:MAX_INSTRUCTION_CHARS], truncated)
    return None


def build_system_prompt(
    ctx: ToolContext,
    model: str,
    instructions: ProjectInstructions | None = None,
    summary: str | None = None,
    skills: "list[Skill] | None" = None,
) -> str:
    parts = [BASE_PROMPT, "\n".join([
        "Environment:",
        f"- Project folder: {ctx.cwd}",
        f"- Operating system: {platform.system()} {platform.release()}",
        f"- Shell for the bash tool: {ctx.shell.name}",
        f"- Date: {datetime.date.today().isoformat()}",
        f"- Model: {model}",
    ])]
    if instructions:
        note = " The file is long. Only the first part is shown." if instructions.truncated else ""
        parts.append(
            f"# Project instructions\n\nThe user wrote these instructions in {instructions.name}. "
            f"Follow them.{note}\n\n{instructions.text}"
        )
    listed = [s for s in skills or [] if s.model_invocable][:MAX_SKILLS_IN_PROMPT]
    if listed:
        lines = []
        for s in listed:
            text = s.description if len(s.description) <= MAX_SKILL_DESCRIPTION else s.description[:MAX_SKILL_DESCRIPTION] + "..."
            lines.append(f"- {s.name}: {text}")
        parts.append(
            "# Skills\n\nA skill holds instructions for one kind of task. When a task matches a skill "
            "description, call the skill tool with the skill name before you start the task.\n\n"
            + "\n".join(lines)
        )
    if summary:
        parts.append(
            "# Summary of the earlier conversation\n\n"
            "The earlier messages were removed to save context. This summary replaces them.\n\n"
            f"{summary}"
        )
    return "\n\n".join(parts)
