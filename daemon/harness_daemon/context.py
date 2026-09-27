"""Context control (SPEC.md section 5.5).

When the context reaches 80% of the limit, the model summarizes the old turns.
The agent keeps the system prompt, the summary, and the last 4 turns. A turn starts
at a user message and holds all the messages until the next user message.
"""

from __future__ import annotations

import json
from typing import Any

from .providers import ModelClient

COMPACT_AT = 0.8
KEEP_TURNS = 4
CHARS_PER_TOKEN = 3.5  # A careful estimate: code has more tokens for each character than prose.
TOOL_OUTPUT_IN_TRANSCRIPT = 1500
IMAGE_TOKENS = 1000  # An estimate for one screenshot. The real count depends on the model.
TRIMMED = "[The output was removed to save context. Run the tool again if you need it.]"

SUMMARY_PROMPT = """\
You summarize a conversation between a user and a coding agent. The agent will continue the work \
with only your summary and the last few messages. Write the summary in plain sentences and lists.

Include:
- The goal of the user and each request.
- The decisions and the reasons for them.
- The files that the agent read, created, or changed, with the important details.
- The commands that the agent ran and the important results or errors.
- The work that is complete and the work that is not complete.

Do not add information that is not in the conversation. Keep the summary under 600 words."""


def _message_chars(m: dict[str, Any]) -> float:
    """The size of a message. An image counts as IMAGE_TOKENS, not as the length of its data URL."""
    extra = 0.0
    if "image" in m:  # A stored screenshot. Only the newest one goes to the model.
        m = {k: v for k, v in m.items() if k != "image"}
    content = m.get("content")
    if isinstance(content, list):
        parts = [p for p in content if not (isinstance(p, dict) and p.get("type") == "image_url")]
        extra = (len(content) - len(parts)) * IMAGE_TOKENS * CHARS_PER_TOKEN
        m = {**m, "content": parts}
    return len(json.dumps(m, ensure_ascii=False)) + extra


def estimate_tokens(messages: list[dict[str, Any]]) -> int:
    chars = sum(_message_chars(m) for m in messages)
    return int(chars / CHARS_PER_TOKEN) + 1


def split_turns(history: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    turns: list[list[dict[str, Any]]] = []
    for message in history:
        if message.get("role") == "user" or not turns:
            turns.append([])
        turns[-1].append(message)
    return turns


def render_transcript(messages: list[dict[str, Any]]) -> str:
    """Show the messages as plain text. Some chat templates reject tool messages in odd places."""
    lines: list[str] = []
    for m in messages:
        role = m.get("role")
        if role == "user":
            lines.append(f"USER: {m.get('content') or ''}")
        elif role == "assistant":
            if m.get("content"):
                lines.append(f"AGENT: {m['content']}")
            for call in m.get("tool_calls") or []:
                fn = call.get("function", {})
                lines.append(f"AGENT CALLS TOOL {fn.get('name')}: {fn.get('arguments')}")
        elif role == "tool":
            output = m.get("content") or ""
            if len(output) > TOOL_OUTPUT_IN_TRANSCRIPT:
                output = output[:TOOL_OUTPUT_IN_TRANSCRIPT] + " [...]"
            lines.append(f"TOOL RESULT: {output}")
    return "\n\n".join(lines)


async def summarize(client: ModelClient, previous: str | None, messages: list[dict[str, Any]],
                    context_length: int) -> str:
    transcript = render_transcript(messages)
    # The request must fit in the context. Keep the newest part of a long transcript.
    budget = int(context_length * 0.6 * CHARS_PER_TOKEN)
    if len(transcript) > budget:
        transcript = "[The start of the conversation is not shown.]\n\n" + transcript[-budget:]
    parts = []
    if previous:
        parts.append(f"A summary of the conversation before this part:\n\n{previous}")
    parts.append(f"The conversation:\n\n{transcript}")
    parts.append("Write the summary now.")
    request = [
        {"role": "system", "content": SUMMARY_PROMPT},
        {"role": "user", "content": "\n\n---\n\n".join(parts)},
    ]

    async def ignore(_: str) -> None:
        return None

    response = await client.stream(request, [], ignore)
    return response.text.strip()


def trim_tool_outputs(history: list[dict[str, Any]], keep_from: int) -> int:
    """Replace the tool outputs before index ``keep_from``. Return the number of trimmed messages."""
    count = 0
    for m in history[:keep_from]:
        if m.get("role") == "tool" and m.get("content") != TRIMMED and len(m.get("content") or "") > len(TRIMMED):
            m["content"] = TRIMMED
            m.pop("diff", None)
            m.pop("image", None)
            count += 1
    return count
