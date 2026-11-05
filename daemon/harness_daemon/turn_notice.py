"""The short text of a turn that ended, for the "task complete" notification of the client.

The text is the first sentence of the last reply of the agent, with no Markdown. A turn that stopped
early gets a short reason. The client shows it under the session title when the user does not see the
session (docs/UI_RULES.md V10).
"""

from __future__ import annotations

import re
from typing import Any

LIMIT = 160  # Characters. A Windows notification shows about two lines.

# The text for a turn that ended for a reason other than a reply. "interrupted": the user stopped it, so the
# client shows no notification.
STOPS = {
    "max_tool_calls": "Stopped at the tool call limit of the turn.",
    "denied": "Stopped: a permission request was denied.",
    "blocked": "A hook or a plugin stopped the turn.",
}


def plain(text: str) -> str:
    """Markdown to one line of plain text."""
    text = re.sub(r"```.*?(```|$)", " ", text, flags=re.S)  # Code blocks.
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)  # Links and images: the text only.
    text = re.sub(r"^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)", "", text, flags=re.M)  # Headings, quotes, lists.
    text = re.sub(r"(\*\*|__|\*|`)", "", text)  # Bold, italics, inline code. A single "_" stays: names use it.
    text = re.sub(r"^\s*\|.*\|\s*$", " ", text, flags=re.M)  # Table rows.
    return " ".join(text.split())


def first_sentence(text: str, limit: int = LIMIT) -> str:
    match = re.search(r"(?<=[.!?])\s", text)
    sentence = text[:match.start()] if match else text
    if len(sentence) <= limit:
        return sentence
    cut = sentence[:limit - 1].rsplit(" ", 1)[0].rstrip(",;:")
    return f"{cut}…"


def last_reply(history: list[dict[str, Any]]) -> str:
    """The text of the last assistant message that has text."""
    for message in reversed(history):
        if message.get("role") != "assistant":
            continue
        content = message.get("content")
        if isinstance(content, list):  # Content parts.
            content = " ".join(str(p.get("text") or "") for p in content if isinstance(p, dict))
        if isinstance(content, str) and content.strip():
            return content
    return ""


def summary(history: list[dict[str, Any]], stop: str, error: str | None = None) -> str:
    """The short text of a turn that ended with ``stop`` (the stop reason of agent.py)."""
    if stop == "error":
        return first_sentence(f"The turn failed: {plain(error)}" if error else "The turn failed.")
    if stop in STOPS:
        return STOPS[stop]
    return first_sentence(plain(last_reply(history))) or "The agent finished the turn."
