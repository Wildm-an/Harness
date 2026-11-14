"""Model providers and the streaming model client.

Each provider is an entry in ``~/.harness/providers.json``::

    {
      "local-ollama": { "base_url": "http://localhost:11434/v1", "api_key": "ollama" }
    }

Optional provider fields:

- ``api_key_env``: read the API key from this environment variable.
- ``kind``: ``"ollama"``, ``"openrouter"``, or ``"openai"``. The daemon checks tool support only for
  Ollama (``/api/show``) and OpenRouter (the model list). It checks image support for each kind:
  ``"openai"`` servers tell it in some model lists (see openai_image_input). The default is
  ``"ollama"`` for port 11434, ``"openrouter"`` for openrouter.ai, and ``"openai"`` for other URLs.
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

import logging
import os
import time
import uuid
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Awaitable, Callable
from urllib.parse import quote, urlparse

import asyncio

import httpx

from .nethttp import async_client

# The openai package loads at the first model request, not when the daemon starts: its import takes
# about 1 second, and the client waits for the daemon at each start of the app.
if TYPE_CHECKING:
    from openai import AsyncOpenAI

from .config import ConfigError, harness_home, read_json
from .tunnels import TUNNELS, SshTarget, TunnelError, parse_ssh

DEFAULT_PROVIDERS: dict[str, dict[str, Any]] = {
    "local-ollama": {"base_url": "http://localhost:11434/v1", "api_key": "ollama"},
}

# The API keys that the client sent for providers with "key_store": "client". Memory only.
CLIENT_KEYS: dict[str, str] = {}

# The providers that plugins registered: name -> the entries, newest last. A providers.json entry wins.
PLUGIN_PROVIDERS: dict[str, list[dict[str, Any]]] = {}


def register_plugin_provider(name: str, entry: dict[str, Any]) -> Callable[[], None]:
    """Add a provider of a plugin. Return a function that removes it."""
    item = dict(entry)
    PLUGIN_PROVIDERS.setdefault(name, []).append(item)

    def remove() -> None:
        stack = PLUGIN_PROVIDERS.get(name, [])
        if item in stack:
            stack.remove(item)
        if not stack:
            PLUGIN_PROVIDERS.pop(name, None)
    return remove


class ModelError(Exception):
    def __init__(self, message: str, *, reconnect: bool = False) -> None:
        super().__init__(message)
        # True: the endpoint did not answer, or a gateway in front of it did not reach the model server.
        # The agent tries the request again some times (agent.MAX_CONNECT_RETRIES).
        self.reconnect = reconnect


# HTTP codes of a gateway or proxy that did not reach the model server: the server can come back.
GATEWAY_CODES = {502, 503, 504}


OPENROUTER_HOST = "openrouter.ai"


def default_kind(base_url: str) -> str:
    """The kind for a provider with no "kind" (or "auto"): from the URL."""
    parsed = urlparse(base_url)
    host = (parsed.hostname or "").lower()
    if host == OPENROUTER_HOST or host.endswith("." + OPENROUTER_HOST):
        return "openrouter"
    return "ollama" if parsed.port == 11434 else "openai"


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
    # Why the provider cannot run, for a stored session whose provider is gone or off. Each request fails with it.
    unavailable: str | None = None

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
    if kind in (None, "auto"):
        kind = default_kind(entry["base_url"])
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
    for name, stack in PLUGIN_PROVIDERS.items():
        if stack and name not in data:
            data[name] = stack[-1]
    return {name: _provider_from_entry(name, entry) for name, entry in data.items()
            if include_disabled or is_enabled(entry)}


OFF_MESSAGE = "The provider {name} is off. Turn it on in Settings > Providers."


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
        raise ConfigError("All providers are off. Turn one on in Settings > Providers.")
    return next(iter(providers.values())), spec


def stored_model(spec: str, provider_name: str | None) -> tuple[Provider, str]:
    """The provider and the model of a stored session. If the provider is gone or off, a placeholder
    provider with the same name keeps the model label: the session opens, and its requests fail."""
    try:
        return resolve_model(spec, provider_name)
    except ConfigError as e:
        if not provider_name:
            raise
        return Provider(name=provider_name, base_url="", unavailable=str(e)), spec


async def model_capabilities(provider: Provider, model: str) -> list[str] | None:
    """The capabilities of an Ollama or OpenRouter model, for example ["completion", "tools", "vision"].

    Return None for other providers, or if the endpoint does not tell.
    """
    if provider.kind == "openrouter":
        async with async_client(timeout=5) as client:
            entry = (await openrouter_models(client, provider)).get(model)
        return openrouter_capabilities(entry) if entry else None
    if provider.kind != "ollama":
        return None
    try:
        async with async_client(timeout=5) as client:
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


def image_input(provider: Provider, model: str, settings: dict[str, Any], caps: list[str] | None,
                listed: bool | None = None) -> bool | None:
    """True if the model accepts images, False if it does not, None if the daemon cannot tell.

    The order: ``image_input`` in the settings, ``image_input`` of the model in providers.json,
    the capability "vision" of Ollama or OpenRouter (``caps``), then the model list of an
    OpenAI-compatible server (``listed``, see openai_image_input).

    Only True gives the agent the image tools (preview_screenshot). With None, the agent sends the
    images that the user attached, and sends a note in place of them if the endpoint rejects them.
    """
    for value in (settings.get("image_input"), (provider.models.get(model) or {}).get("image_input")):
        if isinstance(value, bool):
            return value
    if caps is not None:
        return "vision" in caps
    return listed


def _image_modalities(value: Any) -> bool | None:
    """True if a list of input modalities has "image". ``value`` can be {"input": [...]}."""
    if isinstance(value, dict):
        value = value.get("input")
    if isinstance(value, list):
        return any(str(m).lower() in ("image", "images", "vision") for m in value)
    return None


def image_input_from_entry(entry: dict[str, Any]) -> bool | None:
    """The image input in one entry of GET /models, or None if the entry does not tell.

    Servers use different fields: ``architecture.input_modalities`` (OpenRouter and the servers that
    copy its format), ``input_modalities``, ``modalities``, ``capabilities`` (a list or a dict), and
    ``supports_vision`` (LiteLLM).
    """
    architecture = entry.get("architecture") if isinstance(entry.get("architecture"), dict) else {}
    for value in (architecture.get("input_modalities"), entry.get("input_modalities"), entry.get("modalities")):
        found = _image_modalities(value)
        if found is not None:
            return found
    caps = entry.get("capabilities")
    if isinstance(caps, list):
        return any(str(c).lower() in ("vision", "image", "image_input") for c in caps)
    if isinstance(caps, dict):
        for key in ("vision", "image_input"):
            if isinstance(caps.get(key), bool):
                return caps[key]
    info = entry.get("model_info") if isinstance(entry.get("model_info"), dict) else {}
    for value in (entry.get("supports_vision"), info.get("supports_vision")):
        if isinstance(value, bool):
            return value
    return None


async def openai_image_input(provider: Provider, model: str) -> bool | None:
    """The image input of a model on an OpenAI-compatible server, or None if the server does not tell.

    The sources: the entry of the model in GET /models, the model type of LM Studio ("vlm"), and the
    modalities of llama-server (GET /props).
    """
    headers = _auth_headers(provider)
    async with async_client(timeout=PROBE_TIMEOUT) as client:
        listed, lmstudio, props = await asyncio.gather(
            _json(client, "GET", f"{provider.base_url}/models", headers=headers),
            _json(client, "GET", f"{provider.root_url}/api/v0/models", headers=headers),
            _json(client, "GET", f"{provider.root_url}/props", headers=headers),
        )
    entry = next((m for m in _entries(listed) if str(m.get("id")) == model), None)
    found = image_input_from_entry(entry) if entry else None
    if found is not None:
        return found
    studio = next((m for m in _entries(lmstudio) if str(m.get("id")) == model), None)
    if studio and studio.get("type") in ("vlm", "llm"):
        return studio["type"] == "vlm"
    modalities = props.get("modalities") if isinstance(props, dict) else None
    if isinstance(modalities, dict) and isinstance(modalities.get("vision"), bool):
        return modalities["vision"]
    return None


DEFAULT_CONTEXT_LENGTH = 8192
# Ollama uses a small context unless the model or the server sets one. See OLLAMA_CONTEXT_LENGTH.
OLLAMA_DEFAULT_CONTEXT = 4096
# A remote server can answer GET /models slowly while it generates or loads a model.
PROBE_TIMEOUT = 10
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


# -- OpenRouter ---------------------------------------------------------------------

# GET /models of OpenRouter has hundreds of models. Keep each list for some minutes: base URL -> (time, id -> entry).
OPENROUTER_LIST_TTL = 600
OPENROUTER_LISTS: dict[str, tuple[float, dict[str, dict[str, Any]]]] = {}


async def openrouter_models(client: httpx.AsyncClient, provider: Provider,
                            listing: list[dict[str, Any]] | None = None) -> dict[str, dict[str, Any]]:
    """The entries of the OpenRouter model list, by model id. ``listing``: a GET /models reply that the caller has."""
    if listing is None:
        saved = OPENROUTER_LISTS.get(provider.base_url)
        if saved and time.monotonic() - saved[0] < OPENROUTER_LIST_TTL:
            return saved[1]
        listing = _entries(await _json(client, "GET", f"{provider.base_url}/models", headers=_auth_headers(provider)))
    models = {str(m["id"]): m for m in listing if m.get("id")}
    if models:
        OPENROUTER_LISTS[provider.base_url] = (time.monotonic(), models)
    return models


def openrouter_capabilities(entry: dict[str, Any]) -> list[str] | None:
    """The capabilities of an OpenRouter model: "tools" from supported_parameters, and "vision" from
    the image input in architecture.input_modalities. None if the entry does not tell."""
    params = entry.get("supported_parameters")
    if not isinstance(params, list):
        return None
    caps = ["completion"]
    if "tools" in params:
        caps.append("tools")
    architecture = entry.get("architecture") if isinstance(entry.get("architecture"), dict) else {}
    modalities = architecture.get("input_modalities")
    if isinstance(modalities, list) and "image" in modalities:
        caps.append("vision")
    return caps


# -- OpenAI-compatible servers ------------------------------------------------------

def context_from_entry(entry: dict[str, Any]) -> int | None:
    """The context length in one entry of GET /models: vLLM, OpenRouter, llama-server, and others."""
    meta = entry.get("meta") if isinstance(entry.get("meta"), dict) else {}
    top = entry.get("top_provider") if isinstance(entry.get("top_provider"), dict) else {}  # OpenRouter.
    metadata = entry.get("metadata") if isinstance(entry.get("metadata"), dict) else {}  # DeepInfra.
    return _positive_int(entry.get("max_model_len") or entry.get("context_length") or entry.get("context_window")
                         or entry.get("max_context_length")  # Mistral.
                         or entry.get("max_input_tokens") or entry.get("context_size") or entry.get("max_seq_len")
                         or top.get("context_length") or metadata.get("context_length")
                         or meta.get("n_ctx") or meta.get("n_ctx_train"))


def _litellm_contexts(data: Any) -> dict[str, int]:
    """GET /model/info of a LiteLLM proxy: {"data": [{"model_name", "model_info": {"max_input_tokens"}}]}."""
    found: dict[str, int] = {}
    for m in _entries(data):
        info = m.get("model_info") if isinstance(m.get("model_info"), dict) else {}
        n = _positive_int(info.get("max_input_tokens"))  # Not max_tokens: often the output limit.
        if n and m.get("model_name"):
            found.setdefault(str(m["model_name"]), n)
    return found


@dataclass
class OpenAIContextSources:
    """The context information of an OpenAI-compatible server. One request to each source."""

    llama_server: int | None = None  # GET /props: n_ctx.
    lmstudio: dict[str, dict[str, Any]] = field(default_factory=dict)  # GET /api/v0/models: model id -> entry.
    tgi: int | None = None  # GET /info of Text Generation Inference: max_total_tokens.
    listing: dict[str, int] = field(default_factory=dict)  # GET /models: model id -> context.
    listing_source: str = "model list"
    litellm: dict[str, int] = field(default_factory=dict)  # GET /model/info of LiteLLM: model name -> context.

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
            return ContextInfo(self.listing[model], self.listing_source)
        if model in self.litellm:
            return ContextInfo(self.litellm[model], "LiteLLM model info")
        return None


async def openai_context_sources(client: httpx.AsyncClient, provider: Provider,
                                 listing: list[dict[str, Any]] | None = None) -> OpenAIContextSources:
    """Ask each source at the same time. A server answers only its own requests; the others fail."""
    headers = _auth_headers(provider)
    if provider.kind == "openrouter":  # Only the model list: the other sources are for local servers.
        models = await openrouter_models(client, provider, listing)
        return OpenAIContextSources(
            listing={model: n for model, entry in models.items() if (n := context_from_entry(entry))},
            listing_source="OpenRouter")

    async def models() -> Any:
        return {"data": listing} if listing is not None else await _json(
            client, "GET", f"{provider.base_url}/models", headers=headers)

    props, lmstudio, info, listed, litellm = await asyncio.gather(
        _json(client, "GET", f"{provider.root_url}/props", headers=headers),
        _json(client, "GET", f"{provider.root_url}/api/v0/models", headers=headers),
        _json(client, "GET", f"{provider.root_url}/info", headers=headers),
        models(),
        _json(client, "GET", f"{provider.base_url}/model/info", headers=headers),
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
    sources.litellm = _litellm_contexts(litellm)
    return sources


async def _probe_openai(client: httpx.AsyncClient, provider: Provider, model: str) -> ContextInfo | None:
    found = (await openai_context_sources(client, provider)).lookup(model)
    if found or provider.kind == "openrouter":
        return found
    # GET /models/{id}: some servers give more fields for one model than in the list.
    entry = await _json(client, "GET", f"{provider.base_url}/models/{quote(model, safe='')}",
                        headers=_auth_headers(provider))
    n = context_from_entry(entry) if isinstance(entry, dict) else None
    return ContextInfo(n, "model entry") if n else None


async def resolve_context_length(provider: Provider, model: str, settings: dict[str, Any]) -> ContextInfo:
    """Find the context length: settings, then provider settings, then the endpoint."""
    n = _positive_int(settings.get("context_length"))
    if n:
        return ContextInfo(n, "settings")
    configured = configured_context(provider, model)
    if configured:
        return configured
    async with async_client(timeout=PROBE_TIMEOUT) as client:
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
    async with async_client(timeout=PROBE_TIMEOUT) as client:
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
    # The usage of the endpoint. Counts are int. Some fields are objects, for example prompt_tokens_details.
    usage: dict[str, Any] | None = None
    finish_reason: str | None = None
    reasoning: str | None = None  # The reasoning_content of the reply (DeepSeek thinking mode).


OnText = Callable[[str], Awaitable[None]]


log = logging.getLogger(__name__)
# One INFO line for each model request in the daemon log: the size, and the time to the first byte, the first
# reasoning, the first answer, and the end. A slow model server then shows in the log.
timing = logging.getLogger("harness.timing")
timing.setLevel(logging.INFO)

# The effort levels of the model menu (setting "effort"), and the reasoning_effort value of the API.
# The OpenAI API has no level above "xhigh": "max" sends "xhigh" too.
EFFORT_API = {"low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "xhigh"}
DEFAULT_EFFORT = "high"  # The level with no "effort" setting, as in the Claude app.


class ModelClient:
    """Streams chat completions from an OpenAI-compatible endpoint."""

    def __init__(self, provider: Provider, model: str):
        self.provider = provider
        self.model = model
        self._base_url: str | None = None
        self._client: AsyncOpenAI | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._send_stream_options = True
        # False after the endpoint rejected a request with reasoning_effort: the model has no effort levels.
        self._send_effort = True

    async def _openai(self) -> AsyncOpenAI:
        """The API client for the current address and event loop.

        A new tunnel can have a new local port. The pooled connections of a client belong to the
        event loop that opened them, so a new loop (for example a new asyncio.run) gets a new client.
        """
        if self.provider.unavailable:
            reason = self.provider.unavailable.rstrip(".")
            raise ModelError(f"{reason}. Select an available model under the prompt box.")
        try:
            current = await endpoint(self.provider)
        except TunnelError as e:
            raise ModelError(str(e)) from e
        loop = asyncio.get_running_loop()
        if self._client is None or current.base_url != self._base_url or loop is not self._loop:
            from openai import AsyncOpenAI, DefaultAsyncHttpxClient

            from .nethttp import ssl_context

            self._base_url = current.base_url
            self._loop = loop
            self._client = AsyncOpenAI(
                base_url=current.base_url,
                api_key=current.api_key,
                max_retries=1,
                timeout=httpx.Timeout(600, connect=10),
                # The shared SSL context: a new context blocks the event loop for about 300 ms.
                http_client=DefaultAsyncHttpxClient(verify=ssl_context(), timeout=httpx.Timeout(600, connect=10)),
            )
        return self._client

    @property
    def label(self) -> str:
        return f"{self.provider.name}/{self.model}"

    @property
    def replays_reasoning(self) -> bool:
        """True: the history sends the reasoning_content of each reply back to the model.

        DeepSeek in thinking mode needs the reasoning of each earlier reply when the request has
        tools, or the API returns HTTP 400. Other servers can reject the unknown field.
        """
        return "deepseek" in (self.provider.base_url or "").lower() or "deepseek" in self.model.lower()

    async def stream(self, messages: list[dict], tools: list[dict], on_text: OnText,
                     _retry_tunnel: bool = True, options: dict[str, Any] | None = None,
                     on_reasoning: Callable[[], Awaitable[None]] | None = None) -> ModelResponse:
        """Stream one completion. ``options``: ``temperature``, ``max_tokens``, and ``stop`` from plugins, and
        ``reasoning_effort`` (the effort setting, or a plugin)."""
        import openai  # Loaded by _openai() already: this import only gives the name.

        started = time.monotonic()
        client = await self._openai()
        kwargs: dict[str, Any] = {"model": self.model, "messages": messages, "stream": True}
        for key in ("temperature", "max_tokens", "stop"):
            if options and options.get(key) is not None:
                kwargs[key] = options[key]
        effort = options.get("reasoning_effort") if options else None
        if effort and self._send_effort:
            kwargs["reasoning_effort"] = effort
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
                return await self.stream(messages, tools, on_text, options=options, on_reasoning=on_reasoning)
            # A model with no effort levels can reject reasoning_effort. Try once more without it.
            # Not for a request that is too long: the agent uses the limit in the error (agent.py).
            from .model_contexts import limit_from_error
            if "reasoning_effort" in kwargs and not limit_from_error(str(e)):
                log.info("%s rejected reasoning_effort=%s: %s", self.label, effort, e)
                self._send_effort = False
                return await self.stream(messages, tools, on_text, options=options, on_reasoning=on_reasoning)
            raise ModelError(f"The model endpoint rejected the request: {e}") from e
        except openai.APIConnectionError as e:
            if self.provider.ssh is not None and _retry_tunnel:
                # The tunnel can stop between two requests. The next call opens a new one.
                await asyncio.sleep(0.5)
                return await self.stream(messages, tools, on_text, _retry_tunnel=False, options=options,
                                         on_reasoning=on_reasoning)
            where = f"{self.provider.base_url} through SSH {self.provider.ssh.label}" if self.provider.ssh else self.provider.base_url
            log.warning("%s: no connection to %s: %r", self.label, where, e.__cause__ or e)
            raise ModelError(f"Cannot connect to the model endpoint at {where}.", reconnect=True) from e
        except openai.APIStatusError as e:
            raise ModelError(f"The model endpoint returned HTTP {e.status_code}: {e.message}",
                             reconnect=e.status_code in GATEWAY_CODES) from e

        opened = time.monotonic()
        first_reasoning: float | None = None
        first_answer: float | None = None
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        slots: dict[int, dict[str, str]] = {}
        index_map: dict[int, int] = {}
        usage: dict[str, Any] | None = None
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
                    # The thinking of the model: "reasoning_content" (DeepSeek, vLLM, llama.cpp) or
                    # "reasoning" (Ollama, OpenRouter). The client shows "Thinking…" (on_reasoning).
                    reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                    if isinstance(reasoning, str) and reasoning:
                        if first_reasoning is None:
                            first_reasoning = time.monotonic()
                        if not reasoning_parts and on_reasoning is not None:
                            await on_reasoning()
                        reasoning_parts.append(reasoning)
                    if first_answer is None and (delta.content or delta.tool_calls):
                        first_answer = time.monotonic()
                    if delta.content:
                        text_parts.append(delta.content)
                        await on_text(delta.content)
                    for tc in delta.tool_calls or []:
                        _merge_tool_call_delta(slots, index_map, tc)
        except openai.APIError as e:
            raise ModelError(f"The model stream failed: {e}") from e
        finally:
            await stream.close()
            since = lambda t: f"{t - started:.2f}s" if t is not None else "-"  # noqa: E731
            timing.info("model %s: %d messages, %d tools | first byte %s, first reasoning %s, first answer %s, end %s | "
                        "prompt %s, completion %s tokens", self.label, len(messages), len(tools), since(opened),
                        since(first_reasoning), since(first_answer), since(time.monotonic()),
                        (usage or {}).get("prompt_tokens", "?"), (usage or {}).get("completion_tokens", "?"))

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
        return ModelResponse("".join(text_parts), calls, usage, finish, "".join(reasoning_parts) or None)


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
