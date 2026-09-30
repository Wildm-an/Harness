"""Session titles: the model summarizes the first prompt of a session into a short title.

The first line of the prompt is the title until the summary is ready. If the model fails, that
title stays.
"""

from __future__ import annotations

import asyncio
import logging
import re

from .providers import ModelClient

log = logging.getLogger("harness.titles")

TITLE_CHARS = 60
TITLE_TIMEOUT = 60  # Seconds. A local model can be slow while it also runs the turn.
MAX_PROMPT_CHARS = 2000

TITLE_PROMPT = (
    "Write a short title for the task below, in 3 to 6 words, in the language of the task. "
    "Reply with the title only: no quotes, no period, no explanation.\n\nThe task:\n{text}"
)

_THINK = re.compile(r"<think>.*?(</think>|$)", re.S | re.I)


def clean_title(raw: str) -> str | None:
    """The title from a model reply: no reasoning block, no quotes or Markdown, one line."""
    text = _THINK.sub("", raw or "").strip()
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    previous = None
    while line != previous:  # Markdown, quotes, a period, and "Title:" can wrap each other.
        previous = line
        line = line.strip().strip("#*`_\"'“”‘’ ").rstrip(".").strip()
        line = re.sub(r"^title\s*:\s*", "", line, flags=re.I)
    if not line:
        return None
    if len(line) > TITLE_CHARS:
        line = line[:TITLE_CHARS].rsplit(" ", 1)[0].rstrip(",;:-") or line[:TITLE_CHARS]
    return line


async def summarize_title(client: ModelClient, prompt: str) -> str | None:
    """Ask the model for a title. Return None if the model fails or gives no text."""
    async def ignore(_: str) -> None:
        return None

    request = [{"role": "user", "content": TITLE_PROMPT.format(text=prompt.strip()[:MAX_PROMPT_CHARS])}]
    try:
        response = await asyncio.wait_for(client.stream(request, [], ignore), TITLE_TIMEOUT)
    except Exception as e:  # noqa: BLE001 - a title is optional. The first line stays.
        log.info("The session title was not made: %s", e)
        return None
    return clean_title(response.text)
