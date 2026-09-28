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
- ``ssh``: reach the model through an SSH tunnel, for example ``"drew@gpu-box"``. The
  ``base_url`` is then the address as the SSH host sees it. See tunnels.py.
- ``key_store``: ``"client"`` means that the API key is in the keychain of the desktop
  client. The client sends the key after it connects. The daemon keeps it in memory only.
- ``enabled``: ``false`` turns the provider off. The daemon does not use it.

The order for the API key: ``api_key``, then the ``api_key_env`` variable, then the client key.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

import asyncio

import httpx
import openai
from openai import AsyncOpenAI

from .config import ConfigError, harness_home, read_json
from .tunnels import TUNNELS, SshTarget, TunnelError, parse_ssh

DEFAULT_PROVIDERS: dict[str, dict[str, Any]] = {
    "local-ollama": {"base_url": "http://localhost:11434/v1", "api_key": "ollama"},
}

# The API keys that the client sent for providers with "key_store": "client". Memory only.
CLIENT_KEYS: dict[str, str] = {}


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
    ssh: SshTarget | None = None
    key_missing: str | None = None  # Why the configured API key is not available, if it is not.

    @property
    def root_url(self) -> str:
        """The server root, without the "/v1" of the OpenAI-compatible API."""
        return self.base_url[: -len("/v1")] if self.base_url.endswith("/v1") else self.base_url


def _provider_from_entry(name: str, entry: Any) -> Provider:
    if not isinstance(entry, dict) or not isinstance(entry.get("base_url"), str):
        raise ConfigError(f"Provider '{name}' must have a 'base_url' string.")
    api_key = entry.get("api_key")
    missing = None
    if not api_key and entry.get("api_key_env"):
        api_key = os.environ.get(entry["api_key_env"])
        if not api_key:
            missing = f"The environment variable {entry['api_key_env']} of the daemon is not set."
    if not api_key and entry.get("key_store") == "client":
        api_key = CLIENT_KEYS.get(name)
        missing = None if api_key else "The desktop client did not send the key from its keychain."
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
        ssh=_ssh(name, entry.get("ssh")),
        key_missing=missing,
    )


def is_enabled(entry: Any) -> bool:
    return not (isinstance(entry, dict) and entry.get("enabled") is False)


def _ssh(name: str, value: Any) -> SshTarget | None:
    try:
        return parse_ssh(value)
    except ValueError as e:
        raise ConfigError(f"Provider '{name}': {e}") from e


async def endpoint(provider: Provider) -> Provider:
    """The provider with the address that the daemon can reach now.

    For a provider with ``ssh``, this opens the tunnel (or uses the open tunnel) and
    returns the local address of the tunnel. Raises TunnelError if the tunnel fails.
    """
    if provider.ssh is None:
        return provider
    local = await TUNNELS.local_url(provider.base_url, provider.ssh)
    return replace(provider, base_url=local.rstrip("/"), ssh=None)


def read_provider_entries() -> tuple[dict[str, Any], bool]:
    """The raw entries of providers.json, and True if the file exists. No file: the default provider."""
    data = read_json(harness_home() / "providers.json", None)
    if data is None:
        return {name: dict(entry) for name, entry in DEFAULT_PROVIDERS.items()}, False
    if not isinstance(data, dict) or not data:
        raise ConfigError("providers.json must be an object with one or more providers.")
    return data, True


def load_providers(include_disabled: bool = False) -> dict[str, Provider]:
    """The providers. A provider with "enabled": false is not in the result, unless ``include_disabled``."""
    data, _ = read_provider_entries()
    return {name: _provider_from_entry(name, entry) for name, entry in data.items()
            if include_disabled or is_enabled(entry)}


OFF_MESSAGE = "The provider {name} is off. Turn it on in the Connections screen."


def resolve_model(spec: str | None, provider_name: str | None = None) -> tuple[Provider, str]:
    """Find the provider and the model name for a model string.

    The model string is ``<provider>/<model>`` or ``<model>``. A bare model
    uses ``provider_name`` or the first provider in ``providers.json`` that is on.
    """
    every = load_providers(include_disabled=True)
    providers = load_providers()
    if not spec:
        raise ConfigError("No model is set. Give a model, or set 'default_model' in settings.json.")
    if provider_name:
        if provider_name not in every:
            raise ConfigError(f"Unknown provider: {provider_name}")
        if provider_name not in providers:
            raise ConfigError(OFF_MESSAGE.format(name=provider_name))
        return providers[provider_name], spec
    head, sep, rest = spec.partition("/")
    if sep and rest and head in every:
        if head not in providers:
            raise ConfigError(OFF_MESSAGE.format(name=head))
        return providers[head], rest
    if not providers:
        raise ConfigError("All providers are off. Turn one on in the Connections screen.")
    return next(iter(providers.values())), spec


async def model_capabilities(provider: Provider, model: str) -> list[str] | None:
    """The capabilities of an Ollama model, for example ["completion", "tools", "vision"].

    Return None for other providers, or if the endpoint does not tell.
    """
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
    return [str(c) for c in caps] if isinstance(caps, list) else None


async def check_tool_support(provider: Provider, model: str) -> bool | None:
    """Return True or False for Ollama models. Return None if unknown."""
    caps = await model_capabilities(provider, model)
    return None if caps is None else "tools" in caps


def image_input(provider: Provider, model: str, settings: dict[str, Any], caps: list[str] | None) -> bool:
    """True if the model accepts images, for example the screenshots of preview_screenshot.

    The order: ``image_input`` in the settings, ``image_input`` of the model in providers.json,
    then the Ollama capability "vision". The default is False: most local models have no image input.
    """
    for value in (settings.get("image_input"), (provider.models.get(model) or {}).get("image_input")):
        if isinstance(value, bool):
            return value
    return caps is not None and "vision" in caps


DEFAULT_CONTEXT_LENGTH = 8192
# Ollama uses a small context unless the model or the server sets one. See OLLAMA_CONTEXT_LENGTH.
OLLAMA_DEFAULT_CONTEXT = 4096
PROBE_TIMEOUT = 3
# The Providers screen checks the context of each model. An Ollama server needs one request for each model.
MAX_CONTEXT_PROBES = 40
PROBE_CONCURRENCY = 6


@dataclass(frozen=True)
class ContextInfo:
    length: int
    source: str
    warning: str | None = None

    def to_json(self) -> dict[str, Any]:
        body: dict[str, Any] = {"length": self.length, "source": self.source}
        if self.warning:
            body["warning"] = self.warning
        return body


def _positive_int(value: Any) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _auth_headers(provider: Provider) -> dict[str, str]:
    """Some servers need the API key for /models too, for example vLLM with --api-key."""
    if provider.api_key and provider.api_key != "none":
        return {"Authorization": f"Bearer {provider.api_key}"}
    return {}


async def _json(client: httpx.AsyncClient, method: str, url: str, **kwargs: Any) -> Any:
    try:
        r = await client.request(method, url, **kwargs)
        return r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


def _entries(data: Any) -> list[dict[str, Any]]:
    """The model entries of an OpenAI-style list: {"data": [...]}."""
    raw = data.get("data") if isinstance(data, dict) else None
    return [m for m in raw if isinstance(m, dict)] if isinstance(raw, list) else []


def configured_context(provider: Provider, model: str) -> ContextInfo | None:
    """The context length that providers.json sets for the model or for the provider."""
    n = _positive_int((provider.models.get(model) or {}).get("context_length")) or _positive_int(provider.context_length)
    return ContextInfo(n, "providers.json") if n else None


# -- Ollama -------------------------------------------------------------------------

async def _ollama_loaded(client: httpx.AsyncClient, provider: Provider) -> dict[str, int]:
    """The context of each loaded model. It is the context that the server really uses."""
    ps = await _json(client, "GET", f"{provider.root_url}/api/ps", headers=_auth_headers(provider))
    loaded: dict[str, int] = {}
    for m in (ps or {}).get("models", []) if isinstance(ps, dict) else []:
        n = _positive_int(m.get("context_length")) if isinstance(m, dict) else None
        if n:
            for key in (m.get("name"), m.get("model")):
                if key:
                    loaded[key] = n
    return loaded


async def _probe_ollama(client: httpx.AsyncClient, provider: Provider, model: str,
                        loaded: dict[str, int] | None = None) -> ContextInfo | None:
    if loaded is None:
        loaded = await _ollama_loaded(client, provider)
    if model in loaded:
        return ContextInfo(loaded[model], "Ollama (loaded model)")
    show = await _json(client, "POST", f"{provider.root_url}/api/show", json={"model": model},
                       headers=_auth_headers(provider))
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


# -- OpenAI-compatible servers ------------------------------------------------------

def context_from_entry(entry: dict[str, Any]) -> int | None:
    """The context length in one entry of GET /models: vLLM, OpenRouter, llama-server, and others."""
    meta = entry.get("meta") if isinstance(entry.get("meta"), dict) else {}
    return _positive_int(entry.get("max_model_len") or entry.get("context_length") or entry.get("context_window")
                         or meta.get("n_ctx") or meta.get("n_ctx_train"))


@dataclass
class OpenAIContextSources:
    """The context information of an OpenAI-compatible server. One request to each source."""

    llama_server: int | None = None  # GET /props: n_ctx.
    lmstudio: dict[str, dict[str, Any]] = field(default_factory=dict)  # GET /api/v0/models: model id -> entry.
    tgi: int | None = None  # GET /info of Text Generation Inference: max_total_tokens.
    listing: dict[str, int] = field(default_factory=dict)  # GET /models: model id -> context.

    def lookup(self, model: str) -> ContextInfo | None:
        if self.llama_server:
            return ContextInfo(self.llama_server, "llama-server")
        entry = self.lmstudio.get(model)
        if entry:
            loaded = _positive_int(entry.get("loaded_context_length"))
            if loaded:
                return ContextInfo(loaded, "LM Studio (loaded model)")
            maximum = _positive_int(entry.get("max_context_length"))
            if maximum:
                return ContextInfo(maximum, "LM Studio (model maximum)", (
                    f"LM Studio loads {model} with the context length of its load settings, which can be "
                    f"smaller than the maximum ({maximum} tokens) that the harness uses. Load the model in "
                    "LM Studio with a large context, or set context_length in providers.json."
                ))
        if self.tgi:
            return ContextInfo(self.tgi, "Text Generation Inference")
        if model in self.listing:
            return ContextInfo(self.listing[model], "model list")
        return None


async def openai_context_sources(client: httpx.AsyncClient, provider: Provider,
                                 listing: list[dict[str, Any]] | None = None) -> OpenAIContextSources:
    """Ask each source at the same time. A server answers only its own requests; the others fail."""
    headers = _auth_headers(provider)

    async def models() -> Any:
        return {"data": listing} if listing is not None else await _json(
            client, "GET", f"{provider.base_url}/models", headers=headers)

    props, lmstudio, info, listed = await asyncio.gather(
        _json(client, "GET", f"{provider.root_url}/props", headers=headers),
        _json(client, "GET", f"{provider.root_url}/api/v0/models", headers=headers),
        _json(client, "GET", f"{provider.root_url}/info", headers=headers),
        models(),
    )
    sources = OpenAIContextSources()
    if isinstance(props, dict):
        defaults = props.get("default_generation_settings")
        sources.llama_server = _positive_int((defaults.get("n_ctx") if isinstance(defaults, dict) else None)
                                             or props.get("n_ctx"))
    sources.lmstudio = {str(m["id"]): m for m in _entries(lmstudio) if m.get("id")}
    if isinstance(info, dict) and (info.get("model_id") or info.get("max_total_tokens")):
        sources.tgi = _positive_int(info.get("max_total_tokens") or info.get("max_input_tokens")
                                    or info.get("max_input_length"))
    for m in _entries(listed):
        n = context_from_entry(m)
        if n and m.get("id"):
            sources.listing[str(m["id"])] = n
    return sources


async def _probe_openai(client: httpx.AsyncClient, provider: Provider, model: str) -> ContextInfo | None:
    return (await openai_context_sources(client, provider)).lookup(model)


async def resolve_context_length(provider: Provider, model: str, settings: dict[str, Any]) -> ContextInfo:
    """Find the context length: settings, then provider settings, then the endpoint."""
    n = _positive_int(settings.get("context_length"))
    if n:
        return ContextInfo(n, "settings")
    configured = configured_context(provider, model)
    if configured:
        return configured
    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
        probe = _probe_ollama if provider.kind == "ollama" else _probe_openai
        found = await probe(client, provider, model)
    if found:
        return found
    return ContextInfo(DEFAULT_CONTEXT_LENGTH, "default", (
        f"The context length of {model} is unknown. The harness uses {DEFAULT_CONTEXT_LENGTH} tokens. "
        "Set context_length in providers.json for this model."
    ))


async def model_contexts(provider: Provider, models: list[str],
                         listing: list[dict[str, Any]] | None = None) -> dict[str, ContextInfo]:
    """The context length of each model, for the Providers screen. A model with no answer is not in the result.

    ``listing`` is the GET /models reply that the caller has, so that the server gets no second request.
    Ollama needs one request for each model, so only the first MAX_CONTEXT_PROBES models get a check.
    """
    found: dict[str, ContextInfo] = {}
    unknown = []
    for model in models:
        configured = configured_context(provider, model)
        if configured:
            found[model] = configured
        else:
            unknown.append(model)
    if not unknown:
        return found
    async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
        if provider.kind == "ollama":
            loaded = await _ollama_loaded(client, provider)
            limit = asyncio.Semaphore(PROBE_CONCURRENCY)

            async def one(model: str) -> None:
                async with limit:
                    info = await _probe_ollama(client, provider, model, loaded)
                if info:
                    found[model] = info

            await asyncio.gather(*(one(m) for m in unknown[:MAX_CONTEXT_PROBES]))
        else:
            sources = await openai_context_sources(client, provider, listing)
            for model in unknown:
                info = sources.lookup(model)
                if info:
                    found[model] = info
    return found


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
        self._base_url: str | None = None
        self._client: AsyncOpenAI | None = None
        self._send_stream_options = True

    async def _openai(self) -> AsyncOpenAI:
        """The API client for the current address. A new tunnel can have a new local port."""
        try:
            current = await endpoint(self.provider)
        except TunnelError as e:
            raise ModelError(str(e)) from e
        if self._client is None or current.base_url != self._base_url:
            self._base_url = current.base_url
            self._client = AsyncOpenAI(
                base_url=current.base_url,
                api_key=current.api_key,
                max_retries=1,
                timeout=httpx.Timeout(600, connect=10),
            )
        return self._client

    @property
    def label(self) -> str:
        return f"{self.provider.name}/{self.model}"

    async def stream(self, messages: list[dict], tools: list[dict], on_text: OnText,
                     _retry_tunnel: bool = True) -> ModelResponse:
        client = await self._openai()
        kwargs: dict[str, Any] = {"model": self.model, "messages": messages, "stream": True}
        if tools:
            kwargs["tools"] = tools
        if self._send_stream_options:
            kwargs["stream_options"] = {"include_usage": True}
        try:
            stream = await client.chat.completions.create(**kwargs)
        except openai.BadRequestError as e:
            # Some servers reject stream_options. Try once more without it.
            if self._send_stream_options and "stream_options" in str(e):
                self._send_stream_options = False
                return await self.stream(messages, tools, on_text)
            raise ModelError(f"The model endpoint rejected the request: {e}") from e
        except openai.APIConnectionError as e:
            if self.provider.ssh is not None and _retry_tunnel:
                # The tunnel can stop between two requests. The next call opens a new one.
                await asyncio.sleep(0.5)
                return await self.stream(messages, tools, on_text, _retry_tunnel=False)
            where = f"{self.provider.base_url} through SSH {self.provider.ssh.label}" if self.provider.ssh else self.provider.base_url
            raise ModelError(f"Cannot connect to the model endpoint at {where}.") from e
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
