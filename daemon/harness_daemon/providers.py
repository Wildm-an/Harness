"""Model providers and the streaming model client.

Each provider is an entry in ``~/.harness/providers.json``::

    {
      "local-ollama": { "base_url": "http://localhost:11434/v1", "api_key": "ollama" }
    }

Optional provider fields:

- ``api_key_env``: read the API key from this environment variable.
- ``kind``: ``"ollama"`` or ``"openai"``. The daemon uses ``/api/show`` to check
  tool support only for Ollama. The default is ``"ollama"`` for port 11434.
- ``context_length``: the context size of the models on this provider.
- ``models``: settings for each model, for example
  ``{"qwen2.5-coder:7b": {"context_length": 32768}}``.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

import httpx
import openai
from openai import AsyncOpenAI

from .config import ConfigError, harness_home, read_json

DEFAULT_PROVIDERS: dict[str, dict[str, Any]] = {
    "local-ollama": {"base_url": "http://localhost:11434/v1", "api_key": "ollama"},
}


class ModelError(Exception):
    pass


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    api_key: str = "none"
    kind: str = "openai"
    context_length: int | None = None
    models: dict[str, dict[str, Any]] = field(default_factory=dict, hash=False, compare=False)

    @property
    def root_url(self) -> str:
        """The server root, without the "/v1" of the OpenAI-compatible API."""
        return self.base_url[: -len("/v1")] if self.base_url.endswith("/v1") else self.base_url


def _provider_from_entry(name: str, entry: Any) -> Provider:
    if not isinstance(entry, dict) or not isinstance(entry.get("base_url"), str):
        raise ConfigError(f"Provider '{name}' must have a 'base_url' string.")
    api_key = entry.get("api_key")
    if not api_key and entry.get("api_key_env"):
        api_key = os.environ.get(entry["api_key_env"])
    kind = entry.get("kind")
    if kind is None:
        kind = "ollama" if urlparse(entry["base_url"]).port == 11434 else "openai"
    return Provider(
        name=name,
        base_url=entry["base_url"].rstrip("/"),
        api_key=api_key or "none",
        kind=kind,
        context_length=entry.get("context_length"),
        models=entry.get("models") if isinstance(entry.get("models"), dict) else {},
    )


def load_providers() -> dict[str, Provider]:
    data = read_json(harness_home() / "providers.json", None)
    if data is None:
        data = DEFAULT_PROVIDERS
    if not isinstance(data, dict) or not data:
        raise ConfigError("providers.json must be an object with one or more providers.")
    return {name: _provider_from_entry(name, entry) for name, entry in data.items()}


def resolve_model(spec: str | None, provider_name: str | None = None) -> tuple[Provider, str]:
    """Find the provider and the model name for a model string.

    The model string is ``<provider>/<model>`` or ``<model>``. A bare model
    uses ``provider_name`` or the first provider in ``providers.json``.
    """
    providers = load_providers()
    if not spec:
        raise ConfigError("No model is set. Give a model, or set 'default_model' in settings.json.")
    if provider_name:
        if provider_name not in providers:
            raise ConfigError(f"Unknown provider: {provider_name}")
        return providers[provider_name], spec
    head, sep, rest = spec.partition("/")
    if sep and head in providers and rest:
        return providers[head], rest
    return next(iter(providers.values())), spec


async def check_tool_support(provider: Provider, model: str) -> bool | None:
    """Return True or False for Ollama models. Return None if unknown."""
    if provider.kind != "ollama":
        return None
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.post(f"{provider.root_url}/api/show", json={"model": model})
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    try:
        caps = r.json().get("capabilities")
    except ValueError:
        return None
    if not isinstance(caps, list):
        return None
    return "tools" in caps


DEFAULT_CONTEXT_LENGTH = 8192
# Ollama uses a small context unless the model or the server sets one. See OLLAMA_CONTEXT_LENGTH.
OLLAMA_DEFAULT_CONTEXT = 4096
PROBE_TIMEOUT = 3


@dataclass(frozen=True)
class ContextInfo:
    length: int
    source: str
    warning: str | None = None


def _positive_int(value: Any) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


async def _json(client: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> Any:
    try:
        r = await client.request(method, url, **kwargs)
        return r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


async def _probe_ollama(client: httpx.AsyncClient, provider: Provider, model: str) -> ContextInfo | None:
    # A loaded model reports the context that the server really uses.
    ps = await _json(client, "GET", f"{provider.root_url}/api/ps")
    for m in (ps or {}).get("models", []) if isinstance(ps, dict) else []:
        if m.get("name") == model or m.get("model") == model:
            n = _positive_int(m.get("context_length"))
            if n:
                return ContextInfo(n, "Ollama (loaded model)")
    show = await _json(client, "POST", f"{provider.root_url}/api/show", json={"model": model})
    if not isinstance(show, dict):
        return None
    for line in str(show.get("parameters") or "").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == "num_ctx" and _positive_int(parts[1]):
            return ContextInfo(int(parts[1]), "Ollama num_ctx")
    info = show.get("model_info") or {}
    trained = next((_positive_int(v) for k, v in info.items() if k.endswith(".context_length")), None)
    length = min(trained or OLLAMA_DEFAULT_CONTEXT, OLLAMA_DEFAULT_CONTEXT)
    return ContextInfo(length, "Ollama default", (
        f"Ollama runs {model} with its default context ({length} tokens) unless you set a larger one. "
        "Set OLLAMA_CONTEXT_LENGTH for the Ollama server, or set context_length in providers.json."
    ))


async def _probe_openai(client: httpx.AsyncClient, provider: Provider, model: str) -> ContextInfo | None:
    props = await _json(client, "GET", f"{provider.root_url}/props")  # llama-server
    if isinstance(props, dict):
        settings = props.get("default_generation_settings") or {}
        n = _positive_int(settings.get("n_ctx") or props.get("n_ctx"))
        if n:
            return ContextInfo(n, "llama-server")
    models = await _json(client, "GET", f"{provider.base_url}/models")  # vLLM and others
    for m in (models or {}).get("data", []) if isinstance(models, dict) else []:
        if m.get("id") == model:
            meta = m.get("meta") or {}
            n = _positive_int(m.get("max_model_len") or m.get("context_length") or meta.get("n_ctx"))
            if n:
                return ContextInfo(n, "model list")
    return None


async def resolve_context_length(provider: Provider, model: str, settings: dict[str, Any]) -> ContextInfo:
    """Find the context length: settings, then provider settings, then the endpoint."""
    n = _positive_int(settings.get("context_length"))
    if n:
        return ContextInfo(n, "settings")
    n = _positive_int((provider.models.get(model) or {}).get("context_length")) or _positive_int(provider.context_length)
    if n:
        return ContextInfo(n, "providers.json")
    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
        probe = _probe_ollama if provider.kind == "ollama" else _probe_openai
        found = await probe(client, provider, model)
    if found:
        return found
    return ContextInfo(DEFAULT_CONTEXT_LENGTH, "default", (
        f"The context length of {model} is unknown. The harness uses {DEFAULT_CONTEXT_LENGTH} tokens. "
        "Set context_length in providers.json for this model."
    ))


@dataclass
class ModelResponse:
    text: str
    tool_calls: list[dict[str, str]] = field(default_factory=list)
    usage: dict[str, int] | None = None
    finish_reason: str | None = None


OnText = Callable[[str], Awaitable[None]]


class ModelClient:
    """Streams chat completions from an OpenAI-compatible endpoint."""

    def __init__(self, provider: Provider, model: str):
        self.provider = provider
        self.model = model
        self._client = AsyncOpenAI(
            base_url=provider.base_url,
            api_key=provider.api_key,
            max_retries=1,
            timeout=httpx.Timeout(600, connect=10),
        )
        self._send_stream_options = True

    @property
    def label(self) -> str:
        return f"{self.provider.name}/{self.model}"

    async def stream(self, messages: list[dict], tools: list[dict], on_text: OnText) -> ModelResponse:
        kwargs: dict[str, Any] = {"model": self.model, "messages": messages, "stream": True}
        if tools:
            kwargs["tools"] = tools
        if self._send_stream_options:
            kwargs["stream_options"] = {"include_usage": True}
        try:
            stream = await self._client.chat.completions.create(**kwargs)
        except openai.BadRequestError as e:
            # Some servers reject stream_options. Try once more without it.
            if self._send_stream_options and "stream_options" in str(e):
                self._send_stream_options = False
                return await self.stream(messages, tools, on_text)
            raise ModelError(f"The model endpoint rejected the request: {e}") from e
        except openai.APIConnectionError as e:
            raise ModelError(f"Cannot connect to the model endpoint at {self.provider.base_url}.") from e
        except openai.APIStatusError as e:
            raise ModelError(f"The model endpoint returned HTTP {e.status_code}: {e.message}") from e

        text_parts: list[str] = []
        slots: dict[int, dict[str, str]] = {}
        index_map: dict[int, int] = {}
        usage: dict[str, int] | None = None
        finish: str | None = None
        try:
            async for chunk in stream:
                if getattr(chunk, "usage", None):
                    usage = chunk.usage.model_dump(exclude_none=True)
                for choice in chunk.choices or []:
                    if choice.finish_reason:
                        finish = choice.finish_reason
                    delta = choice.delta
                    if delta is None:
                        continue
                    if delta.content:
                        text_parts.append(delta.content)
                        await on_text(delta.content)
                    for tc in delta.tool_calls or []:
                        _merge_tool_call_delta(slots, index_map, tc)
        except openai.APIError as e:
            raise ModelError(f"The model stream failed: {e}") from e
        finally:
            await stream.close()

        calls = []
        for key in sorted(slots):
            slot = slots[key]
            if not slot["name"]:
                continue
            calls.append({
                "id": slot["id"] or f"call_{uuid.uuid4().hex[:12]}",
                "name": slot["name"],
                "arguments": slot["arguments"],
            })
        return ModelResponse("".join(text_parts), calls, usage, finish)


def _merge_tool_call_delta(slots: dict[int, dict[str, str]], index_map: dict[int, int], tc: Any) -> None:
    raw_index = tc.index if tc.index is not None else len(slots)
    key = index_map.get(raw_index, raw_index)
    slot = slots.get(key)
    # Some servers send each complete call with index 0. A new id means a new call.
    if slot is not None and tc.id and slot["id"] and tc.id != slot["id"]:
        key = max(slots) + 1
        index_map[raw_index] = key
        slot = None
    if slot is None:
        slot = slots[key] = {"id": "", "name": "", "arguments": ""}
    if tc.id:
        slot["id"] = tc.id
    fn = tc.function
    if fn is not None:
        if fn.name and not slot["name"]:
            slot["name"] = fn.name
        if fn.arguments:
            slot["arguments"] += fn.arguments
