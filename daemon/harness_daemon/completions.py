"""Editor autocomplete: the model continues the code at the cursor, as GitHub Copilot does.

The client sends the text before and after the cursor while the user types in the editor. The
model writes the text to insert at the cursor. The client shows it as gray "ghost" text, and Tab
puts it in the file. A completion is optional: if the model fails or has nothing useful, the
client shows nothing.
"""

from __future__ import annotations

import asyncio
import logging
import re

from .providers import ModelClient

log = logging.getLogger("harness.completions")

COMPLETION_TIMEOUT = 20  # Seconds. A slow completion is of no use: the user typed on.
PREFIX_CHARS = 4000  # The text before the cursor that the model sees.
SUFFIX_CHARS = 1500  # The text after the cursor that the model sees.
COMPLETION_CHARS = 600
COMPLETION_LINES = 12
MAX_TOKENS = 200

CURSOR = "<CURSOR>"

COMPLETION_PROMPT = (
    "You are a code completion engine in an editor, like GitHub Copilot. Below is a file. The "
    f"cursor of the user is at {CURSOR}. Write the code that the user is most likely to type next at "
    "the cursor: finish the current line, and add at most a few more lines when the next lines are "
    "clear. Match the language, the style, and the indentation of the file. Do not repeat the text "
    "before the cursor or the text after it. Reply with the text to insert only: no explanation, no "
    "Markdown code fence. If there is nothing useful to insert, reply with NONE."
    "\n\nThe file: {path}\n\n{before}" + CURSOR + "{after}"
)

_THINK = re.compile(r"<think>.*?(</think>|$)", re.S | re.I)
_FENCE = re.compile(r"^```[\w+-]*[ \t]*\n(.*?)\n?```\s*$", re.S)


def clean_completion(raw: str, prefix: str, suffix: str) -> str | None:
    """The text to insert from a model reply. None if there is nothing useful."""
    text = _THINK.sub("", raw or "")
    text = text.strip("\n")
    fence = _FENCE.match(text.strip())
    if fence:
        text = fence.group(1)
    if not text.strip() or text.strip().rstrip(".").upper() == "NONE":
        return None
    text = text.replace(CURSOR, "")
    # A model can repeat the start of the current line. Keep only the new part.
    line_start = prefix.rsplit("\n", 1)[-1]
    if line_start.strip() and text.startswith(line_start):
        text = text[len(line_start):]
    elif line_start.strip() and text.lstrip().startswith(line_start.lstrip()):
        text = text.lstrip()[len(line_start.lstrip()):]
    # Stop where the text after the cursor starts again.
    anchor = suffix.lstrip()[:40].rstrip()
    if len(anchor) >= 4:
        at = text.find(anchor)
        if at > 0:
            text = text[:at]
    lines = text.split("\n")[:COMPLETION_LINES]
    text = "\n".join(lines)[:COMPLETION_CHARS].rstrip()
    return text or None


def completion_request(path: str, prefix: str, suffix: str) -> list[dict[str, str]]:
    """The model request: the end of the text before the cursor and the start of the text after it."""
    before = prefix[-PREFIX_CHARS:]
    after = suffix[:SUFFIX_CHARS]
    return [{"role": "user", "content": COMPLETION_PROMPT.format(path=path or "untitled", before=before, after=after)}]


async def complete_code(client: ModelClient, path: str, prefix: str, suffix: str) -> str | None:
    """Ask the model for the text at the cursor. Return None if there is no good completion."""
    if not prefix.strip() and not suffix.strip():
        return None

    async def ignore(_: str) -> None:
        return None

    request = completion_request(path, prefix, suffix)
    try:
        response = await asyncio.wait_for(
            client.stream(request, [], ignore, options={"temperature": 0.2, "max_tokens": MAX_TOKENS}),
            COMPLETION_TIMEOUT,
        )
    except asyncio.CancelledError:
        raise  # The user typed on: a newer request replaces this one.
    except Exception as e:  # noqa: BLE001 - a completion is optional.
        log.info("No completion: %s", e)
        return None
    return clean_completion(response.text, prefix, suffix)
