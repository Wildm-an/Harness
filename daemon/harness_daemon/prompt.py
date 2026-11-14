"""The system prompt: base rules, environment, project instructions, and the context summary."""

from __future__ import annotations

import datetime
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Collection

from .config import harness_home
from .memory import memory_dir, project_root
from .skills import claude_home
from .output_styles import prompt_section as output_style_section
from .osname import os_name
from .model_prompts import PARALLEL_TOOL_CALLS, SMALL_MODEL_TOOL_CALLS, is_small_model, model_guidance
from .tools import ToolContext

if TYPE_CHECKING:
    from .skills import Skill

# The base prompt, in named parts. docs/PROMPT_LEDGER.md records the reason of each part. The setting
# "prompt_ablate" (a list of part ids) leaves parts out, for an evaluation run.
BASE_INTRO = """\
You are a coding agent. You work in the project folder of the user. \
You use tools to find files, read files, change files, and run commands."""

BASE_RULES = """\
Rules:
- Read a file before you change it.
- Make only the changes that the user asks for.
- Keep your replies short. Do not repeat file contents in your reply.
- Write each URL as a Markdown link, [title](https://example.com), or as a bare URL. \
Do not put a URL in backticks or in a code block: the user cannot click it there. \
A command that the user must copy can stay in a code block.
- Write an equation in LaTeX: $...$ in a line of text, and $$...$$ on separate lines.
- If a tool returns an error, read the error. Then try a different approach.
- If the user denies a tool call, stop. Ask the user what to do."""

BASE_TOOLS = """\
Tools:
- Use the read tool to read a file. Use glob to find files by name. Use grep to find text in files.
- Use the edit tool to change part of an existing file. Use the write tool to create a file.
- Do not use bash commands such as cat, head, find, grep, sed, or echo for these jobs. \
The file tools give better results, and the user can review each call.
- Use bash for commands that have no tool, such as git, package managers, tests, and builds.
- Code in your reply does not change a file. Use the edit or write tool to make each change.
- Do not guess a file path or a parameter value. Find it with a tool first.
- A message that starts with [Harness: comes from the Harness, not from the user. Follow it."""

BASE_AUTHORITY = """\
Instructions and their order:
- The messages of the user in this conversation come first.
- Next are the project instructions that the user wrote in Settings, then the instruction file of the project folder.
- Last are the instructions for all projects, then your memory.
- When two instructions disagree, follow the one that is earlier in this list. It is more specific to the work that you do now."""

BASE_TASK_LIST = """\
Task list (when you have the update_plan tool):
- For a request of more than one step, call update_plan with the whole plan in your first reply, \
before the work. The user follows your work on this list.
- Keep exactly one step in_progress. When a step finishes, call update_plan at once, before you start the next step: send the whole list with that step completed and the next step in_progress. The user sees the time of each step. Do not mark many steps completed at the end.
- When the user sends a new message or changes the request, also during a turn, send update_plan again \
with the new whole list: keep the steps that still apply, add the new work, and mark the finished steps completed.
- Close the task list before you end each turn: call update_plan one last time with the whole list, with each finished step completed and no step in_progress. A step that is not done stays pending, and your final answer says why.
- At the end of a turn with work of more than one step, call wrap_up after that update_plan, then write the final answer."""

BASE_FINISH = """\
Finish the task:
- Do the full task. When you write that you will do a step, make the tool call for it in the same reply.
- The task is complete when tool output shows that the change works. \
After a code change, run the tests, the build, or the code when the project lets you.
- Do not write that a test passed or a command worked unless the tool output shows it.
- If you cannot check the change, tell the user what you did not check.
- When the task is complete, stop. Give a short summary of the changes."""

# The part ids, in order. "tool_calls" is PARALLEL_TOOL_CALLS, or SMALL_MODEL_TOOL_CALLS for a small model.
BASE_PART_IDS = ("intro", "rules", "tools", "authority", "tool_calls", "task_list", "finish")
BASE_PROMPT_TEMPLATE = "\n\n".join((BASE_INTRO, BASE_RULES, BASE_TOOLS, BASE_AUTHORITY, "{tool_calls}",
                                     BASE_TASK_LIST, BASE_FINISH))
BASE_PROMPT = BASE_PROMPT_TEMPLATE.format(tool_calls=PARALLEL_TOOL_CALLS)


def base_prompt(model: str, ablate: Collection[str] = ()) -> str:
    """The base prompt. A small model gets one tool call for each reply, in place of parallel calls.

    ``ablate``: part ids (BASE_PART_IDS) to leave out, for an evaluation run.
    """
    calls = SMALL_MODEL_TOOL_CALLS if is_small_model(model) else PARALLEL_TOOL_CALLS
    parts = dict(zip(BASE_PART_IDS, (BASE_INTRO, BASE_RULES, BASE_TOOLS, BASE_AUTHORITY, calls, BASE_TASK_LIST,
                                     BASE_FINISH)))
    return "\n\n".join(text for part, text in parts.items() if part not in ablate)


def prompt_ablate(settings: dict) -> tuple[str, ...]:
    """The setting "prompt_ablate": prompt part and block ids to leave out. Only the evaluation runner sets it."""
    value = settings.get("prompt_ablate")
    return tuple(v for v in value if isinstance(v, str)) if isinstance(value, list) else ()

PREVIEW_PROMPT = """\
# Preview

The preview tools start the servers of .harness/launch.json and operate the browser. In the desktop \
app, you and the user share the tabs of the Browser pane of this session. Use the tools to check \
changes to a web app, and for web tasks:
1. preview_servers lists the servers. Use a running server when it serves what you need. Else \
preview_start starts one. Do not start servers with bash.
2. preview_tabs lists the tabs. If the user opened a tab for the task, continue in it. Else \
preview_navigate with tab "new" opens the page in a new tab.
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
# The project instruction files, in order. The first file that exists wins: many projects keep the same
# text in two files, and a join would send it two times. AGENTS.md is the cross-tool standard (agents.md).
INSTRUCTION_FILES = ("HARNESS.md", "AGENTS.md", "CLAUDE.md")
MAX_INSTRUCTION_CHARS = 40_000
MAX_USER_FILE_CHARS = 10_000
MAX_SKILL_DESCRIPTION = 300
MAX_SKILLS_IN_PROMPT = 60


@dataclass(frozen=True)
class ProjectInstructions:
    name: str
    text: str
    truncated: bool


def _first_file(paths: list[Path], limit: int, name: str | None = None) -> ProjectInstructions | None:
    for path in paths:
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace").strip()
        if not text:
            continue
        return ProjectInstructions(name or path.name, text[:limit], len(text) > limit)
    return None


def load_project_instructions(cwd: Path) -> ProjectInstructions | None:
    """The instruction file of the project folder. A worktree with no file uses the file of its project:
    an untracked HARNESS.md of the main checkout is not in the worktree."""
    folders = [Path(cwd)]
    root = project_root(Path(cwd))
    if root != Path(cwd):
        folders.append(root)
    for folder in folders:
        found = _first_file([folder / name for name in INSTRUCTION_FILES], MAX_INSTRUCTION_CHARS)
        if found:
            return found
    return None


def load_user_instructions() -> ProjectInstructions | None:
    """The instruction file of the user for all projects: ~/.harness/HARNESS.md, ~/.harness/AGENTS.md, or
    ~/.claude/CLAUDE.md (the file of Claude Code). The first file that exists wins."""
    paths = [harness_home() / "HARNESS.md", harness_home() / "AGENTS.md", claude_home() / "CLAUDE.md"]
    for path in paths:
        found = _first_file([path], MAX_USER_FILE_CHARS, name=str(path))
        if found:
            return found
    return None


# The project instructions of the settings (Settings > Your Harness > "Project instructions"). The user
# writes them in the app, one text for each project. They are not in the project folder: the file is
# next to the memory of the project, so a worktree uses the text of its project.
PROJECT_NOTE_FILE = "instructions.md"
MAX_PROJECT_NOTE_CHARS = 10_000


def project_note_path(cwd: Path) -> Path:
    return memory_dir(Path(cwd)).parent / PROJECT_NOTE_FILE


def load_project_note(cwd: Path) -> str | None:
    """The project instructions of the settings. None: the user wrote no instructions for the project."""
    try:
        text = project_note_path(cwd).read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    return text[:MAX_PROJECT_NOTE_CHARS] or None


def save_project_note(cwd: Path, text: str) -> str | None:
    """Write the project instructions of the settings. An empty text removes the file. Return the saved text."""
    path = project_note_path(cwd)
    text = text.strip()
    if not text:
        path.unlink(missing_ok=True)
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text + "\n", encoding="utf-8")
    tmp.replace(path)
    return text


def build_system_prompt(
    ctx: ToolContext,
    model: str,
    instructions: ProjectInstructions | None = None,
    summary: str | None = None,
    skills: "list[Skill] | None" = None,
    plugin_sections: list[str] | None = None,
    user_facing: bool = True,
    tool_names: "Collection[str] | None" = None,
    project_note: str | None = None,
    family: str | None = None,
    user_file: ProjectInstructions | None = None,
) -> str:
    return "\n\n".join(text for _kind, text in system_prompt_parts(ctx, model, instructions, summary, skills,
                                                                  plugin_sections, user_facing, tool_names,
                                                                  project_note, family, user_file))


def system_prompt_parts(
    ctx: ToolContext,
    model: str,
    instructions: ProjectInstructions | None = None,
    summary: str | None = None,
    skills: "list[Skill] | None" = None,
    plugin_sections: list[str] | None = None,
    user_facing: bool = True,
    tool_names: "Collection[str] | None" = None,
    project_note: str | None = None,
    family: str | None = None,
    user_file: ProjectInstructions | None = None,
) -> list[tuple[str, str]]:
    """The parts of the system prompt, with their kind: system, instructions, skills, plugins, or summary.

    The context breakdown of the client shows the size of each kind. ``user_facing`` False (a subagent)
    removes the agent instructions of the user: the agent that made the subagent tells it how to act.
    ``tool_names``: the tools of the agent. The model guidance leaves out the lines about missing tools.
    ``project_note``: the project instructions of the settings. All agents of the project get them, as
    they get the instruction file of the project.
    ``family``: the model family from providers.json, in place of the match of the model name.
    ``user_file``: the instruction file of the user for all projects. All agents get it, also a subagent:
    a rule such as "do not push" must hold for each agent.
    """
    ablate = prompt_ablate(ctx.settings)
    parts: list[tuple[str, str]] = [("system", base_prompt(model, ablate)), ("system", "\n".join([
        "Environment:",
        f"- Project folder: {ctx.cwd}",
        f"- Operating system: {os_name()}",
        f"- Shell for the bash tool: {ctx.shell.name}",
        f"- Date: {datetime.date.today().isoformat()}",
        f"- Model: {model}",
    ]))]
    parts += [("system", text) for text in model_guidance(model, tool_names, family, ablate)]
    personal = user_instructions(ctx.settings) if user_facing else None
    if personal:
        parts.append(("instructions", personal))
    if user_file:
        note = " The file is long. Only the first part is shown." if user_file.truncated else ""
        parts.append(("instructions",
                      f"# User instruction file\n\nThe user wrote these instructions in {user_file.name}. They apply "
                      f"to all projects. The project instructions can change them for one project.{note}\n\n"
                      f"{user_file.text}"))
    style = output_style_section(ctx.settings.get("output_style")) if user_facing else None
    if style:
        parts.append(("instructions", style))
    if project_note and project_note.strip():
        parts.append(("instructions",
                      "# Project instructions from the settings\n\nThe user wrote these instructions in the "
                      "Harness settings for this project. Follow them in this project. When they disagree with "
                      f"the user instructions for all projects, follow these instructions.\n\n{project_note.strip()}"))
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
