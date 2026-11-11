"""Output styles: how the agent structures and writes its replies (Settings > Your Harness > "Output style").

The user setting ``output_style`` holds the id of the style. The built-in styles are in ``BUILTIN``. A custom style
is a Markdown file in ``~/.harness/output-styles/<id>.md``: the frontmatter has ``name`` and ``description``, and
the body is the text that goes into the system prompt::

    ---
    name: Short answers
    description: Short answers first, then detail.
    ---
    Give the answer in the first sentence. Then give the detail.

"New output style…" asks a model to write the body from the description of the user (``draft``). The user can
edit or delete the files by hand. Only the agent that the user talks to gets the style, not a subagent.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .config import harness_home

log = logging.getLogger("harness.output_styles")

DEFAULT = "default"
SUFFIX = ".md"
MAX_DESCRIPTION = 2000  # Characters of the description that the user types.
MAX_NAME = 40
MAX_PROMPT = 6000  # Characters of the text of a custom style in the system prompt.
DRAFT_TIMEOUT = 90  # Seconds. A local model can be slow.


@dataclass(frozen=True)
class Style:
    id: str
    name: str
    description: str
    prompt: str  # The text for the system prompt. Empty: no section (the default style).
    custom: bool = False


BUILTIN: dict[str, Style] = {s.id: s for s in (
    Style(DEFAULT, "Default", "The usual replies of the agent.", ""),
    Style("concise", "Concise", "Short, direct replies that lead with the result.",
          "Keep your replies short and direct.\n"
          "- Lead with the result: the first sentence says what happened or gives the answer.\n"
          "- Do not narrate each step, and do not restate the request or the plan.\n"
          "- Do not add a summary of what you already said.\n"
          "- Use a list or a table only when the content has a real structure.\n"
          "- Give full detail when the user asks for it. Keep error output and warnings complete."),
    Style("explanatory", "Explanatory", "Replies that explain the choices and the code base as the agent works.",
          "Explain your work so that the user learns the project.\n"
          "- Before a change, say in one or two sentences why you chose this approach.\n"
          "- After a change, add a short \"Insight\" note: a pattern of the code base, a trade-off, or a fact "
          "about a library that the change used.\n"
          "- Keep each note specific to this code. Do not explain general programming concepts."),
    Style("learning", "Learning", "The agent teaches, and asks the user to write small parts of the code.",
          "Help the user learn by doing.\n"
          "- Explain the concepts that the task needs, as you work.\n"
          "- For a small part of the code that teaches something (5 to 10 lines, for example a decision or a "
          "key function), do not write it. Add a TODO(human) comment at that place, tell the user what to write "
          "and why it matters, and stop. Continue after the user writes it.\n"
          "- Write the rest of the code yourself: the boilerplate, the setup, and the repeated parts."),
    Style("proactive", "Proactive", "The agent continues with clear next steps and fixes problems that it finds.",
          "Take the initiative.\n"
          "- When the next step is clear and in the scope of the task, do it. Do not stop to ask for a go-ahead.\n"
          "- Fix the problems that you find on the way when they are part of the task. Tell the user about "
          "the problems outside the task.\n"
          "- Run the checks and the tests yourself, and fix what fails.\n"
          "- Ask the user only for decisions that are theirs: a choice between approaches, or an action that "
          "is hard to undo.")
)}


def styles_dir() -> Path:
    return harness_home() / "output-styles"


def _split(text: str) -> tuple[dict[str, Any], str]:
    text = text.lstrip("﻿")
    if text.startswith("---"):
        lines = text.splitlines(keepends=True)
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                try:
                    meta = yaml.safe_load("".join(lines[1:i])) or {}
                except yaml.YAMLError:
                    meta = {}
                return (meta if isinstance(meta, dict) else {}), "".join(lines[i + 1:])
    return {}, text


def _read(path: Path) -> Style | None:
    try:
        meta, body = _split(path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return None
    name = str(meta.get("name") or path.stem).strip()[:MAX_NAME] or path.stem
    return Style(path.stem, name, str(meta.get("description") or "").strip(), body.strip()[:MAX_PROMPT], custom=True)


def custom_styles() -> list[Style]:
    folder = styles_dir()
    if not folder.is_dir():
        return []
    found = [_read(p) for p in sorted(folder.glob(f"*{SUFFIX}"))]
    return [s for s in found if s is not None and s.id not in BUILTIN]


def all_styles() -> list[Style]:
    return [*BUILTIN.values(), *custom_styles()]


def find(style_id: str | None) -> Style | None:
    if not style_id:
        return None
    if style_id in BUILTIN:
        return BUILTIN[style_id]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", style_id):
        return None
    return _read(styles_dir() / f"{style_id}{SUFFIX}") if (styles_dir() / f"{style_id}{SUFFIX}").is_file() else None


def prompt_section(style_id: str | None) -> str | None:
    """The output style part of the system prompt, or None for the default style or an unknown style."""
    style = find(style_id)
    if style is None or not style.prompt:
        return None
    return (f"# Output style: {style.name}\n\nThe user chose this output style in the Harness settings. It sets how "
            f"you structure and write your replies. Follow it in all your replies.\n\n{style.prompt}")


def slug(name: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48].strip("-")
    return text or "style"


def save(name: str, description: str, prompt: str) -> Style:
    """Write a new custom style. The id comes from the name, and does not replace a style."""
    name = " ".join(name.split())[:MAX_NAME] or "Custom style"
    taken = set(BUILTIN) | {s.id for s in custom_styles()}
    base = slug(name)
    style_id, n = base, 2
    while style_id in taken:
        style_id, n = f"{base}-{n}", n + 1
    folder = styles_dir()
    folder.mkdir(parents=True, exist_ok=True)
    meta = yaml.safe_dump({"name": name, "description": " ".join(description.split())[:200]},
                          allow_unicode=True, sort_keys=False, width=1000)
    path = folder / f"{style_id}{SUFFIX}"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(f"---\n{meta}---\n{prompt.strip()[:MAX_PROMPT]}\n", encoding="utf-8")
    tmp.replace(path)
    return Style(style_id, name, " ".join(description.split())[:200], prompt.strip()[:MAX_PROMPT], custom=True)


def items() -> list[dict[str, Any]]:
    return [{"id": s.id, "name": s.name, "description": s.description, "custom": s.custom} for s in all_styles()]


# -- the draft of a new style -------------------------------------------------------------------------------

DRAFT_SYSTEM = """You write output styles for a coding agent. An output style is a short text in the system prompt of the agent. It sets how the agent structures and writes its replies to the user, for example their length, their order, their format, and their tone.

You get the description of the user. Write the output style from it.

Reply in this format and with nothing else:
Name: <a name of 1 to 3 words>

<the instructions>

Rules for the instructions:
- Write them to the agent, in the second person, as short rules ("Give the answer first.").
- Use 3 to 10 lines. A list with "- " is good.
- Keep each wish of the user. Do not add rules that the user did not ask for.
- Do not change how the agent does its work, its tools, or its permissions. Only its replies.
- Use the language of the description."""

DRAFT_USER = "The description of the user:\n\n<description>\n{text}\n</description>"

_THINK = re.compile(r"<think>.*?(</think>|$)", re.S | re.I)


def parse_draft(raw: str) -> tuple[str | None, str]:
    """The name and the instructions of a model reply. No name line: (None, the text)."""
    text = _THINK.sub("", raw or "").strip()
    text = re.sub(r"^```[a-z]*\n|\n```$", "", text).strip()
    match = re.match(r"^\**name\**\s*:\s*(.+?)\s*$", text.splitlines()[0] if text else "", re.I)
    if not match:
        return None, text
    name = match.group(1).strip("*\"'`“” ")
    return (name[:MAX_NAME] or None), "\n".join(text.splitlines()[1:]).strip()


async def draft(client: Any, description: str) -> tuple[str | None, str] | None:
    """Ask the model for a style. None: the model failed or gave no text."""
    async def ignore(_: str) -> None:
        return None

    messages = [{"role": "system", "content": DRAFT_SYSTEM},
                {"role": "user", "content": DRAFT_USER.format(text=description.strip()[:MAX_DESCRIPTION])}]
    try:
        response = await asyncio.wait_for(client.stream(messages, [], ignore), DRAFT_TIMEOUT)
    except Exception as e:  # noqa: BLE001 - the text of the user is the style then.
        log.info("The output style was not drafted with %s: %s", getattr(client, "label", "the model"), e)
        return None
    name, prompt = parse_draft(response.text)
    return (name, prompt) if prompt else None


def fallback_name(description: str) -> str:
    words = re.findall(r"[A-Za-z0-9']+", description)[:3]
    return " ".join(words).capitalize() if words else "Custom style"
