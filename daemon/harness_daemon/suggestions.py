"""Prompt suggestions: after a turn, the model predicts the next message of the user, as in Claude.

The client shows the suggestion in the empty prompt box. Tab puts it in the box. A suggestion is
optional: if the model fails or has no clear next step, the client shows no suggestion.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from .providers import ModelClient

log = logging.getLogger("harness.suggestions")

SUGGESTION_TIMEOUT = 45  # Seconds. A local model can be slow.
SUGGESTION_CHARS = 160
MESSAGE_CHARS = 1500  # The part of each message that the model sees.
RECENT_MESSAGES = 6  # The user and assistant messages at the end of the conversation.

SUGGESTION_PROMPT = (
    "You predict the next message that the user will send to a coding agent. "
    "Read the end of the conversation below. Write the one short message (at most 15 words) "
    "that the user is most likely to send next, in the words and the language of the user. "
    "The message must ask the agent to do a useful next step of the work, for example to test, "
    "fix, extend, explain, or commit something. Do not write thanks, a greeting, or a message that "
    "only ends the conversation. Write it as the user, not as the agent. If there is no clear next "
    "step, reply with NONE. Reply with the message only: no quotes, no explanation."
    "\n\nThe conversation:\n{conversation}"
)

_THINK = re.compile(r"<think>.*?(</think>|$)", re.S | re.I)
_LABEL = re.compile(r"^(user|next message|message|suggestion)\s*:\s*", re.I)


def _text(message: dict[str, Any]) -> str:
    """The text of a message: the text that the user saw, and no images."""
    content = message.get("display") or message.get("content")
    if isinstance(content, list):
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return str(content or "").strip()


def conversation_text(history: list[dict[str, Any]]) -> str:
    """The last user and assistant messages with text, as "User:" and "Agent:" lines."""
    lines: list[str] = []
    for message in reversed(history):
        role = message.get("role")
        if role not in ("user", "assistant"):
            continue
        text = _text(message)
        if not text:
            continue  # An assistant message with only tool calls.
        if len(text) > MESSAGE_CHARS:
            text = text[:MESSAGE_CHARS] + " […]"
        lines.append(f"{'User' if role == 'user' else 'Agent'}: {text}")
        if len(lines) >= RECENT_MESSAGES:
            break
    return "\n\n".join(reversed(lines))


def clean_suggestion(raw: str) -> str | None:
    """The suggestion from a model reply: one line, no reasoning block, quotes, or label."""
    text = _THINK.sub("", raw or "").strip()
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    previous = None
    while line != previous:  # Markdown, quotes, and a label can wrap each other.
        previous = line
        line = line.strip().strip("*`_\"'“”‘’ ").strip()
        line = _LABEL.sub("", line)
    if not line or line.rstrip(".").upper() == "NONE":
        return None
    if len(line) > SUGGESTION_CHARS:
        line = line[:SUGGESTION_CHARS].rsplit(" ", 1)[0].rstrip(",;:-") or line[:SUGGESTION_CHARS]
    return line


async def suggest_prompt(client: ModelClient, history: list[dict[str, Any]]) -> str | None:
    """Ask the model for the next message of the user. Return None if there is no good suggestion."""
    conversation = conversation_text(history)
    if not conversation:
        return None

    async def ignore(_: str) -> None:
        return None

    request = [{"role": "user", "content": SUGGESTION_PROMPT.format(conversation=conversation)}]
    try:
        response = await asyncio.wait_for(client.stream(request, [], ignore), SUGGESTION_TIMEOUT)
    except asyncio.CancelledError:
        raise  # A new turn started.
    except Exception as e:  # noqa: BLE001 - a suggestion is optional.
        log.info("No prompt suggestion: %s", e)
        return None
    return clean_suggestion(response.text)
