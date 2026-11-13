"""The measured context lengths of the models, in ``~/.harness/model-contexts.json``.

The daemon finds the context length of a model at the endpoint (providers.resolve_context_length), or in
an error message of the endpoint that gives the limit. It writes each measured value to this file, so that
the value stays after a restart of the daemon. The daemon uses a saved value when the endpoint gives
no value, for example when the endpoint is slow or the API key is not available yet.

A value in the settings or in ``providers.json`` wins over a saved value: the daemon does not read this
file for such a model. A change to the ``base_url`` of a provider makes its saved values not apply.

The file: ``{"<provider>/<model>": {"base_url", "length", "source", "measured_at"}}``.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from pathlib import Path
from typing import Any

from .config import ConfigError, harness_home, read_json, write_json

log = logging.getLogger("harness.contexts")

FILE_NAME = "model-contexts.json"
SAVED_SUFFIX = " (saved)"
ERROR_SOURCE = "error message"
# Sources that are not a measurement: the user set them, or the daemon used its default.
NOT_MEASURED = {"settings", "providers.json", "default"}
_LOCK = threading.Lock()


def path() -> Path:
    return harness_home() / FILE_NAME


def _key(provider_name: str, model: str) -> str:
    return f"{provider_name}/{model}"


def _read() -> dict[str, Any]:
    try:
        data = read_json(path(), {})
    except (ConfigError, OSError) as e:
        log.warning("The saved context lengths are not available: %s", e)
        return {}
    return data if isinstance(data, dict) else {}


def lookup(provider_name: str, base_url: str, model: str) -> tuple[int, str] | None:
    """The saved length and source of a model, or None. The base URL must be the same."""
    entry = _read().get(_key(provider_name, model))
    if not isinstance(entry, dict) or entry.get("base_url") != base_url:
        return None
    try:
        length = int(entry.get("length"))
    except (TypeError, ValueError):
        return None
    source = entry.get("source")
    return (length, str(source) if source else "endpoint") if length > 0 else None


def save(provider_name: str, base_url: str, model: str, length: int, source: str) -> bool:
    """Write a measured value. Return True if the file changed. A source in NOT_MEASURED is not written."""
    source = unsaved_source(source)
    if source in NOT_MEASURED or length <= 0:
        return False
    with _LOCK:
        data = _read()
        key = _key(provider_name, model)
        old = data.get(key)
        if isinstance(old, dict) and (old.get("base_url"), old.get("length"), old.get("source")) == (base_url, length, source):
            return False
        data[key] = {"base_url": base_url, "length": length, "source": source,
                     "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        try:
            write_json(path(), data)
        except OSError as e:
            log.warning("The daemon cannot save the context length of %s: %s", key, e)
            return False
    return True


def saved_source(source: str) -> str:
    """The source of a saved value, as the client shows it: "model list (saved)"."""
    return source if source.endswith(SAVED_SUFFIX) else source + SAVED_SUFFIX


def unsaved_source(source: str) -> str:
    return source[: -len(SAVED_SUFFIX)] if source.endswith(SAVED_SUFFIX) else source


# -- The limit in an error message -------------------------------------------------------

def _number(text: str) -> int | None:
    try:
        n = int(text.replace(",", "").replace("_", ""))
    except ValueError:
        return None
    return n if n >= 256 else None  # A smaller number is not a context length.


_NUM = r"(\d[\d,_]*)"
# Each pattern has one group: the context length. The text is in lower case.
_ERROR_PATTERNS = [
    re.compile(r"maximum context length is " + _NUM),  # OpenAI, vLLM, DeepSeek, Groq, Together.
    re.compile(r"available context size \(" + _NUM + r" tokens?\)"),  # llama-server.
    re.compile(r"loaded with (?:a )?context length of (?:only )?" + _NUM),  # LM Studio.
    re.compile(r"\d[\d,_]* tokens? > " + _NUM + r" maximum"),  # Anthropic: "prompt is too long".
    re.compile(r"`inputs` tokens \+ `max_new_tokens` must be <= " + _NUM),  # Text Generation Inference.
    re.compile(r"maximum number of tokens allowed \(" + _NUM + r"\)"),  # Gemini.
    re.compile(r"too large for model with " + _NUM + r" maximum context length"),  # Mistral.
    re.compile(r"context (?:length|window|size) (?:limit )?(?:is|of) " + _NUM + r" tokens"),
    re.compile(r"max_model_len\D{0,20}" + _NUM),
]


def limit_from_error(message: str) -> int | None:
    """The context length that an error message of an endpoint gives, or None."""
    text = message.lower()
    for pattern in _ERROR_PATTERNS:
        match = pattern.search(text)
        if match:
            n = _number(match.group(1))
            if n:
                return n
    return None
