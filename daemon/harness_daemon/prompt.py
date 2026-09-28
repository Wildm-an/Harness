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

PREVIEW_PROMPT = """\
# Preview

The preview tools start the servers of .harness/launch.json and operate a headless browser. \
Use them to check changes to a web app:
1. preview_start starts the server. Do not start servers with bash.
2. preview_navigate opens a page.
3. preview_snapshot reads the page. preview_click and preview_fill use its element references.
4. preview_console shows the browser errors. preview_logs shows the server output."""

AUTO_VERIFY_PROMPT = """

The user set "Auto-verify". After each change to the user interface, check the app with the \
preview tools before you stop. Fix the errors that you find. Tell the user the result of the check."""

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
    return "\n\n".join(text for _kind, text in system_prompt_parts(ctx, model, instructions, summary, skills))


def system_prompt_parts(
    ctx: ToolContext,
    model: str,
    instructions: ProjectInstructions | None = None,
    summary: str | None = None,
    skills: "list[Skill] | None" = None,
) -> list[tuple[str, str]]:
    """The parts of the system prompt, with their kind: system, instructions, skills, or summary.

    The context breakdown of the client shows the size of each kind.
    """
    parts: list[tuple[str, str]] = [("system", BASE_PROMPT), ("system", "\n".join([
        "Environment:",
        f"- Project folder: {ctx.cwd}",
        f"- Operating system: {platform.system()} {platform.release()}",
        f"- Shell for the bash tool: {ctx.shell.name}",
        f"- Date: {datetime.date.today().isoformat()}",
        f"- Model: {model}",
    ]))]
    if instructions:
        note = " The file is long. Only the first part is shown." if instructions.truncated else ""
        parts.append(("instructions",
                      f"# Project instructions\n\nThe user wrote these instructions in {instructions.name}. "
                      f"Follow them.{note}\n\n{instructions.text}"))
    if ctx.preview is not None:
        parts.append(("system", PREVIEW_PROMPT + (AUTO_VERIFY_PROMPT if ctx.settings.get("auto_verify") else "")))
    listed = [s for s in skills or [] if s.model_invocable][:MAX_SKILLS_IN_PROMPT]
    if listed:
        lines = []
        for s in listed:
            text = s.description if len(s.description) <= MAX_SKILL_DESCRIPTION else s.description[:MAX_SKILL_DESCRIPTION] + "..."
            lines.append(f"- {s.name}: {text}")
        parts.append(("skills",
                      "# Skills\n\nA skill holds instructions for one kind of task. When a task matches a skill "
                      "description, call the skill tool with the skill name before you start the task.\n\n"
                      + "\n".join(lines)))
    if summary:
        parts.append(("summary",
                      "# Summary of the earlier conversation\n\n"
                      "The earlier messages were removed to save context. This summary replaces them.\n\n"
                      f"{summary}"))
    return parts
