"""The transcript export of a session: all messages and the run records, as one JSON object.

A developer uses it to read what the agent did, and the evaluation runner (daemon/evals) stores it with
each trial. ``content=False`` removes the message text, the tool arguments, and the tool output: that form
is safe to attach to a bug report. A full export can hold secrets that a command printed.
"""

from __future__ import annotations

import re
import time
from typing import Any

from . import __version__
from .storage import Storage

FORMAT = "harness-transcript"
VERSION = 1
_DATA_URL = re.compile(r"data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+")


def _no_images(value: Any) -> Any:
    if isinstance(value, str):
        return _DATA_URL.sub(lambda m: f"[image: {len(m.group(0))} bytes]", value)
    if isinstance(value, list):
        return [_no_images(v) for v in value]
    if isinstance(value, dict):
        return {k: _no_images(v) for k, v in value.items()}
    return value


def _size(value: Any) -> int:
    return len(value) if isinstance(value, str) else len(str(value)) if value is not None else 0


def _no_content(message: dict[str, Any]) -> dict[str, Any]:
    """Keep the role, the tool names, the ids, and the sizes. Remove the text."""
    out: dict[str, Any] = {k: v for k, v in message.items() if k in ("role", "id", "tool_call_id", "is_error", "origin")}
    out["content_chars"] = _size(message.get("content"))
    calls = message.get("tool_calls")
    if calls:
        out["tool_calls"] = [{"id": c.get("id"), "name": (c.get("function") or {}).get("name"),
                              "arguments_chars": _size((c.get("function") or {}).get("arguments"))} for c in calls]
    return out


def export_transcript(storage: Storage, session_id: str, *, content: bool = True,
                      images: bool = False) -> dict[str, Any]:
    """The session, all its messages (also those before a summary or a /clear), and its run records."""
    session = storage.get_session(session_id)
    if session is None:
        raise KeyError(session_id)
    messages = storage.all_messages(session_id)
    if not content:
        messages = [_no_content(m) for m in messages]
    elif not images:
        messages = [_no_images(m) for m in messages]
    info = {k: session[k] for k in ("id", "cwd", "provider", "model", "title", "created_at", "updated_at",
                                    "context_start") if k in session.keys()}
    if content:
        info["summary"] = session["summary"]
    return {
        "format": FORMAT,
        "version": VERSION,
        "exported_at": time.time(),
        "harness_version": __version__,
        "content": content,
        "session": info,
        "messages": messages,
        **storage.session_records(session_id),
    }
