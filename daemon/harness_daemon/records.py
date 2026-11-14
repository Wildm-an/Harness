"""Run records: one row for each model request and each turn, in the local database (storage.py).

The rows hold no prompt text, no tool arguments, and no tool output. They hold the counts, the times, the
hashes of the system prompt and the tool list, and the stop data. Nothing is sent to a server. They let a
developer see the token use of a session, check the prompt cache prefix, and find the change that made a
regression (docs/PRIVACY.md, "Run records").
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import TYPE_CHECKING, Any, Awaitable, Callable

if TYPE_CHECKING:
    from .providers import ModelClient, ModelResponse, OnText

log = logging.getLogger(__name__)

RecordFn = Callable[[dict[str, Any]], None]
MAX_ERROR_CHARS = 500


def text_hash(text: str) -> str:
    """The first 16 hex characters of the SHA-256 of the text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def tools_hash(schemas: list[dict[str, Any]]) -> str | None:
    """The hash of the tool list. The order counts: the endpoint caches the exact bytes. The key order does not."""
    if not schemas:
        return None
    return text_hash(json.dumps(schemas, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def cached_tokens(usage: dict[str, Any] | None) -> int | None:
    """The prompt tokens that the endpoint read from its cache. None: the endpoint does not report it.

    The fields of the providers: OpenAI and most compatible servers (prompt_tokens_details.cached_tokens),
    DeepSeek (prompt_cache_hit_tokens), and the Anthropic form (cache_read_input_tokens).
    """
    if not usage:
        return None
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict) and isinstance(details.get("cached_tokens"), int):
        return details["cached_tokens"]
    for key in ("prompt_cache_hit_tokens", "cache_read_input_tokens"):
        if isinstance(usage.get(key), int):
            return usage[key]
    return None


def usage_counts(usage: dict[str, Any] | None) -> dict[str, int | None]:
    """The token counts of a usage object. None: the endpoint did not report the count. Never an estimate."""
    usage = usage or {}
    details = usage.get("completion_tokens_details")
    reasoning = details.get("reasoning_tokens") if isinstance(details, dict) else None

    def count(key: str) -> int | None:
        value = usage.get(key)
        return value if isinstance(value, int) else None

    return {
        "prompt_tokens": count("prompt_tokens"),
        "completion_tokens": count("completion_tokens"),
        "cached_tokens": cached_tokens(usage),
        "reasoning_tokens": reasoning if isinstance(reasoning, int) else None,
    }


def _system_text(messages: list[dict[str, Any]]) -> str | None:
    first = messages[0] if messages else None
    if first and first.get("role") == "system" and isinstance(first.get("content"), str):
        return first["content"]
    return None


async def recorded_stream(client: "ModelClient", messages: list[dict[str, Any]], tools: list[dict[str, Any]],
                          on_text: "OnText", *, record: RecordFn | None, purpose: str,
                          options: dict[str, Any] | None = None,
                          on_reasoning: Callable[[], Awaitable[None]] | None = None) -> "ModelResponse":
    """client.stream, and one model_requests row for the request: also for an error or a cancel.

    ``purpose``: turn, compact, classifier, title, suggestion, or side.
    A record error never stops the request.
    """
    system = _system_text(messages)
    row: dict[str, Any] = {
        "purpose": purpose,
        "provider": client.provider.name,
        "provider_kind": client.provider.kind,
        "model": client.model,
        "started_at": time.time(),
        "system_hash": text_hash(system) if system is not None else None,
        "tools_hash": tools_hash(tools),
        "message_count": len(messages),
        "tool_count": len(tools),
    }
    start = time.monotonic()
    response: "ModelResponse | None" = None
    error: str | None = None
    try:
        response = await client.stream(messages, tools, on_text, options=options, on_reasoning=on_reasoning)
        return response
    except asyncio.CancelledError:
        error = "interrupted"
        raise
    except Exception as e:
        error = str(e)[:MAX_ERROR_CHARS] or type(e).__name__
        raise
    finally:
        if record is not None:
            row["duration_ms"] = round((time.monotonic() - start) * 1000)
            row["error"] = error
            if response is not None:
                row.update(usage_counts(response.usage))
                row["finish_reason"] = response.finish_reason
                row["usage"] = json.dumps(response.usage, sort_keys=True) if response.usage else None
                row.update(response.timing or {})
            try:
                record(row)
            except Exception:  # noqa: BLE001 - a storage problem must not stop the request.
                log.exception("The model request record failed")
