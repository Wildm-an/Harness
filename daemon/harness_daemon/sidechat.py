"""Side chat: quick questions about a session, as the side chat of Claude Code (Ctrl+;).

The model sees the full context of the session: the system prompt, the messages, and the tools
(the same start as the main thread, so a local server can use its prompt cache). The questions
and the answers are not added to the session. The client keeps them and sends them with each
question.
"""

from __future__ import annotations

from typing import Any

MAX_SIDE_MESSAGES = 40  # The questions and answers of the side chat that go to the model.
MAX_SIDE_CHARS = 8000  # For each question or answer.

SIDE_NOTE = (
    "[Side chat] The user asks a quick question beside the main task. Answer it from the context "
    "above, in short. Do not call tools, and do not continue the main task. This question and "
    "your answer are not part of the session."
)

NO_TOOLS_REPLY = "The side chat cannot run tools. Ask this in the main chat, so that the agent can do it."


def complete_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The messages without tool calls that have no result yet.

    During a turn, the last assistant message can have tool calls that still run. A model server
    rejects a tool call with no result, so the side chat leaves out that message and its results.
    """
    out: list[dict[str, Any]] = []
    i = 0
    while i < len(messages):
        m = messages[i]
        calls = m.get("tool_calls") if m.get("role") == "assistant" else None
        if not calls:
            if m.get("role") != "tool":  # A tool result with no call is not valid either.
                out.append(m)
            i += 1
            continue
        results = []
        j = i + 1
        while j < len(messages) and messages[j].get("role") == "tool":
            results.append(messages[j])
            j += 1
        wanted = {c.get("id") for c in calls}
        if wanted <= {r.get("tool_call_id") for r in results}:
            out.append(m)
            out.extend(r for r in results if r.get("tool_call_id") in wanted)
        elif m.get("content"):
            out.append({"role": "assistant", "content": m["content"]})  # Keep the text of the message.
        i = j
    return out


def clean_side_history(value: Any) -> list[dict[str, str]]:
    """The earlier questions and answers from the client: user and assistant text only, the newest last."""
    if not isinstance(value, list):
        return []
    out = []
    for item in value[-MAX_SIDE_MESSAGES:]:
        if not isinstance(item, dict) or item.get("role") not in ("user", "assistant"):
            continue
        content = item.get("content")
        if isinstance(content, str) and content.strip():
            out.append({"role": item["role"], "content": content[:MAX_SIDE_CHARS]})
    return out


def side_messages(session_messages: list[dict[str, Any]], side_history: list[dict[str, str]],
                  question: str) -> list[dict[str, Any]]:
    """The request for a side question: the session, then the side chat, then the question."""
    messages = complete_history(session_messages)
    side = list(side_history)
    if side:
        side[0] = {**side[0], "content": f"{SIDE_NOTE}\n\n{side[0]['content']}"}
        return [*messages, *side, {"role": "user", "content": question[:MAX_SIDE_CHARS]}]
    return [*messages, {"role": "user", "content": f"{SIDE_NOTE}\n\n{question[:MAX_SIDE_CHARS]}"}]
