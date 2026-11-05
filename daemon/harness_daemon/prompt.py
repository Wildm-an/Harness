"""The system prompt: base rules, environment, project instructions, and the context summary."""

from __future__ import annotations

import datetime
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Collection

from .model_prompts import PARALLEL_TOOL_CALLS, SMALL_MODEL_TOOL_CALLS, is_small_model, model_guidance
from .tools import ToolContext

if TYPE_CHECKING:
    from .skills import Skill

BASE_PROMPT_TEMPLATE = """\
You are a coding agent. You work in the project folder of the user. \
You use tools to find files, read files, change files, and run commands.

Rules:
- Read a file before you change it.
- Make only the changes that the user asks for.
- Keep your replies short. Do not repeat file contents in your reply.
- Write each URL as a Markdown link, [title](https://example.com), or as a bare URL. \
Do not put a URL in backticks or in a code block: the user cannot click it there. \
A command that the user must copy can stay in a code block.
- If a tool returns an error, read the error. Then try a different approach.
- If the user denies a tool call, stop. Ask the user what to do.

Tools:
- Use the read tool to read a file. Use glob to find files by name. Use grep to find text in files.
- Use the edit tool to change part of an existing file. Use the write tool to create a file.
- Do not use bash commands such as cat, head, find, grep, sed, or echo for these jobs. \
The file tools give better results, and the user can review each call.
- Use bash for commands that have no tool, such as git, package managers, tests, and builds.
- Code in your reply does not change a file. Use the edit or write tool to make each change.
- Do not guess a file path or a parameter value. Find it with a tool first.
- A message that starts with [Harness: comes from the Harness, not from the user. Follow it.

{tool_calls}

Task list (when you have the update_plan tool):
- For a request of more than one step, call update_plan with the whole plan in your first reply, \
before the work. The user follows your work on this list.
- Keep exactly one step in_progress. When a step finishes, send the whole list again with the next step in_progress.
- When the user sends a new message or changes the request, also during a turn, send update_plan again \
with the new whole list: keep the steps that still apply, add the new work, and mark the finished steps completed.
- At the end of a turn with work of more than one step, call wrap_up, then write the final answer.

Finish the task:
- Do the full task. When you write that you will do a step, make the tool call for it in the same reply.
- The task is complete when tool output shows that the change works. \
After a code change, run the tests, the build, or the code when the project lets you.
- Do not write that a test passed or a command worked unless the tool output shows it.
- If you cannot check the change, tell the user what you did not check.
- When the task is complete, stop. Give a short summary of the changes."""

BASE_PROMPT = BASE_PROMPT_TEMPLATE.format(tool_calls=PARALLEL_TOOL_CALLS)


def base_prompt(model: str) -> str:
    """The base prompt. A small model gets one tool call for each reply, in place of parallel calls."""
    return BASE_PROMPT_TEMPLATE.format(tool_calls=SMALL_MODEL_TOOL_CALLS if is_small_model(model) else PARALLEL_TOOL_CALLS)

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

# The agent instruction settings (Settings > General), with their headings in the system prompt.
USER_INSTRUCTION_SETTINGS = (
    ("instructions_thinking", "How to think"),
    ("instructions_research", "How to do research"),
    ("instructions_speaking", "How to speak"),
    ("instructions_other", "Other instructions"),
)


def user_instructions(settings: dict) -> str | None:
    """The agent instructions of the user, as one prompt section. None: the user wrote no instructions."""
    sections = []
    for key, heading in USER_INSTRUCTION_SETTINGS:
        text = settings.get(key)
        if isinstance(text, str) and text.strip():
            sections.append(f"## {heading}\n\n{text.strip()}")
    if not sections:
        return None
    return ("# User instructions\n\nThe user wrote these instructions in the Harness settings. "
            "Follow them in all projects. The project instructions can change them for one project.\n\n"
            + "\n\n".join(sections))


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
    plugin_sections: list[str] | None = None,
    user_facing: bool = True,
    tool_names: "Collection[str] | None" = None,
) -> str:
    return "\n\n".join(text for _kind, text in system_prompt_parts(ctx, model, instructions, summary, skills,
                                                                  plugin_sections, user_facing, tool_names))


def system_prompt_parts(
    ctx: ToolContext,
    model: str,
    instructions: ProjectInstructions | None = None,
    summary: str | None = None,
    skills: "list[Skill] | None" = None,
    plugin_sections: list[str] | None = None,
    user_facing: bool = True,
    tool_names: "Collection[str] | None" = None,
) -> list[tuple[str, str]]:
    """The parts of the system prompt, with their kind: system, instructions, skills, plugins, or summary.

    The context breakdown of the client shows the size of each kind. ``user_facing`` False (a subagent)
    removes the agent instructions of the user: the agent that made the subagent tells it how to act.
    ``tool_names``: the tools of the agent. The model guidance leaves out the lines about missing tools.
    """
    parts: list[tuple[str, str]] = [("system", base_prompt(model)), ("system", "\n".join([
        "Environment:",
        f"- Project folder: {ctx.cwd}",
        f"- Operating system: {platform.system()} {platform.release()}",
        f"- Shell for the bash tool: {ctx.shell.name}",
        f"- Date: {datetime.date.today().isoformat()}",
        f"- Model: {model}",
    ]))]
    parts += [("system", text) for text in model_guidance(model, tool_names)]
    personal = user_instructions(ctx.settings) if user_facing else None
    if personal:
        parts.append(("instructions", personal))
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
    for text in plugin_sections or []:
        parts.append(("plugins", text))
    if summary:
        parts.append(("summary",
                      "# Summary of the earlier conversation\n\n"
                      "The earlier messages were removed to save context. This summary replaces them.\n\n"
                      f"{summary}"))
    return parts
