"""The model of an ACP harness from a Harness provider: Settings > Operating Harness > "Model".

Each Harness provider (providers.json) is an OpenAI-compatible server. The user can choose a model of a
provider for some harnesses of the list. When the daemon starts the harness, it gives the harness the
server address, the API key, and the model, in the form that the harness reads. Harness does not change
the config files of the harness: it uses only the command line and the environment of the process.
The API key goes only into the environment, never into the command line (other users can see it).

The choice is in the user settings: ``"harness_models": {"<harness id>": "<provider>/<model>"}``.
No choice: the harness uses its own model settings.

The adapters (checked in the source code of each harness, November 2026):

- ``qwen-code``: the flags ``--auth-type openai --model <m> --openai-base-url <url>`` and the variable
  ``OPENAI_API_KEY``. The flags come before ~/.qwen/settings.json. Qwen Code needs a key: a server with
  no key gets the placeholder "none". (Harness never sends ACP ``authenticate``: in Qwen Code it writes
  the user settings.)
- ``goose``: ``GOOSE_PROVIDER=openai``, ``GOOSE_MODEL``, ``OPENAI_HOST`` (the URL with /v1),
  ``OPENAI_BASE_PATH=chat/completions``, ``OPENAI_API_KEY``, and ``GOOSE_CONTEXT_LIMIT``. The key is
  always set: else goose sends the OpenAI key of the user's keyring to this server. A session that
  goose loads again keeps the model that it stored.
- ``codex-acp``: ``CODEX_CONFIG`` (JSON) with a provider "harness" and the model, and the key in
  ``HARNESS_PROVIDER_API_KEY``. Codex uses only the OpenAI Responses API: the server must have
  ``/v1/responses`` (Ollama has it).
- ``opencode``: ``OPENCODE_CONFIG_CONTENT`` (JSON) with a provider "harness" (``@ai-sdk/openai-compatible``)
  and the model. The key is in ``HARNESS_PROVIDER_API_KEY``: the JSON reads it with ``{env:...}``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit

KEY_ENV = "HARNESS_PROVIDER_API_KEY"
NO_KEY = "none"  # The placeholder key for a server that needs no key.
SETTING = "harness_models"


class ModelChoiceError(Exception):
    pass


@dataclass(frozen=True)
class Target:
    """A model of a Harness provider, as the daemon can reach it now."""

    provider: str
    base_url: str  # With /v1, as in providers.json. For an SSH provider: the local end of the tunnel.
    api_key: str | None  # None: the server needs no key.
    model: str
    context: int | None  # The context length, when Harness knows it.


Launch = tuple[list[str], dict[str, str]]  # Extra arguments and extra environment variables.


def _key(target: Target) -> str:
    return target.api_key or NO_KEY


def _qwen(t: Target) -> Launch:
    return (["--auth-type", "openai", "--model", t.model, "--openai-base-url", t.base_url],
            {"OPENAI_API_KEY": _key(t)})


def _goose(t: Target) -> Launch:
    env = {"GOOSE_PROVIDER": "openai", "GOOSE_MODEL": t.model, "OPENAI_HOST": t.base_url,
           "OPENAI_BASE_PATH": "chat/completions", "OPENAI_API_KEY": _key(t)}
    if t.context:
        env["GOOSE_CONTEXT_LIMIT"] = str(t.context)
    return [], env


def _codex(t: Target) -> Launch:
    provider: dict[str, Any] = {"name": f"Harness: {t.provider}", "base_url": t.base_url, "wire_api": "responses"}
    env: dict[str, str] = {}
    if t.api_key:  # Codex stops when env_key names an empty variable.
        provider["env_key"] = KEY_ENV
        env[KEY_ENV] = t.api_key
    config = {"model": t.model, "model_provider": "harness", "model_providers": {"harness": provider}}
    env["CODEX_CONFIG"] = json.dumps(config)
    return [], env


def _opencode(t: Target) -> Launch:
    model: dict[str, Any] = {"name": t.model}
    if t.context:
        model["limit"] = {"context": t.context, "output": min(t.context // 4, 32768)}
    config = {
        "$schema": "https://opencode.ai/config.json",
        "model": f"harness/{t.model}",
        "provider": {"harness": {
            "npm": "@ai-sdk/openai-compatible",
            "name": f"Harness: {t.provider}",
            "options": {"baseURL": t.base_url, "apiKey": "{env:%s}" % KEY_ENV},
            "models": {t.model: model},
        }},
    }
    # No key: OpenCode sends no Authorization header (an unset variable is "").
    return [], {"OPENCODE_CONFIG_CONTENT": json.dumps(config), **({KEY_ENV: t.api_key} if t.api_key else {})}


ADAPTERS: dict[str, Callable[[Target], Launch]] = {
    "qwen-code": _qwen,
    "goose": _goose,
    "codex-acp": _codex,
    "opencode": _opencode,
}

# A note for the Model row of a harness: what the server must have.
NOTES: dict[str, str] = {
    "codex-acp": "Codex needs a server with the OpenAI Responses API (/v1/responses), for example Ollama.",
}


# The model id in the model menu of the harness, when it is not the model name of the provider.
SESSION_MODEL_IDS: dict[str, Callable[[Target], str]] = {
    "opencode": lambda t: f"harness/{t.model}",
}


def session_model_id(harness_id: str, target: Target) -> str:
    """The id that the model menu of the harness gives to the model of the provider."""
    make = SESSION_MODEL_IDS.get(harness_id)
    return make(target) if make else target.model


def _ipv4_localhost(url: str) -> str:
    """localhost -> 127.0.0.1. Node.js on Windows can try ::1 first, and Ollama listens on IPv4 only."""
    parts = urlsplit(url)
    if parts.hostname != "localhost":
        return url
    netloc = "127.0.0.1" + (f":{parts.port}" if parts.port else "")
    return urlunsplit(parts._replace(netloc=netloc))


def supports(harness_id: str) -> bool:
    return harness_id in ADAPTERS


def choice(settings: dict[str, Any], harness_id: str) -> str | None:
    """The chosen "<provider>/<model>" of the harness, or None."""
    models = settings.get(SETTING)
    value = models.get(harness_id) if isinstance(models, dict) else None
    return value if isinstance(value, str) and value.strip() and supports(harness_id) else None


def launch_options(harness_id: str, target: Target) -> Launch:
    return ADAPTERS[harness_id](target)


async def resolve(spec: str) -> Target:
    """The Target of "<provider>/<model>": the provider is on, its key is there, and its tunnel is open."""
    from .config import ConfigError
    from .providers import endpoint, resolve_context_length, resolve_model
    from .tunnels import TunnelError

    # The provider must exist: a bare model name would go to the first provider.
    provider_name, _, model_name = spec.partition("/")
    try:
        provider, model = resolve_model(model_name, provider_name)
    except ConfigError as e:
        raise ModelChoiceError(f"The model {spec} of the harness is not available: {e}") from None
    if provider.key_missing:
        raise ModelChoiceError(f"The provider {provider.name} has no API key. {provider.key_missing}")
    try:
        provider = await endpoint(provider)
    except TunnelError as e:
        raise ModelChoiceError(f"The SSH tunnel of the provider {provider.name} failed: {e}") from None
    context: int | None = None
    try:
        info = await resolve_context_length(provider, model, {})
        context = info.length if info.source != "default" else None
    except Exception:  # noqa: BLE001 - the harness finds the context length itself.
        context = None
    key = provider.api_key if provider.api_key and provider.api_key != NO_KEY else None
    return Target(provider=provider.name, base_url=_ipv4_localhost(provider.base_url), api_key=key, model=model,
                  context=context)


def check_choice(harness_id: str, value: Any) -> str | None:
    """The clean value for the setting, or None to remove it. Raise ValueError for a bad value."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if not supports(harness_id):
        raise ValueError("This harness cannot use a model of a Harness provider.")
    if not isinstance(value, str) or "/" not in value.strip().strip("/"):
        raise ValueError("Give the model as <provider>/<model>.")
    return value.strip()
