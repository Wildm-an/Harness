"""Changes to ``~/.harness/providers.json`` from the Providers screen, and the connection test.

API keys (SPEC.md section 9):

- The Providers screen keeps a new key in the keychain of the client computer. The entry
  gets ``"key_store": "client"``, and the client sends the key after it connects
  (``providers.keys``). The daemon keeps the key in memory only.
- An entry can also read the key from an environment variable of the daemon (``api_key_env``).
- An old entry can have ``api_key`` in plain text. The screen shows a warning for it. A new
  key from the screen removes it from the file.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from .config import ConfigError, harness_home, write_json
from .providers import CLIENT_KEYS, Provider, _provider_from_entry, endpoint, is_enabled, read_provider_entries
from .tunnels import TunnelError, parse_ssh

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$")
ENV_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
KINDS = ("auto", "ollama", "openai")
KEY_MODES = ("keep", "client", "env", "none")
TEST_TIMEOUT = 10
LIST_TIMEOUT = 6
MAX_MODELS = 500


def providers_path():
    return harness_home() / "providers.json"


def _ssh_label(value: Any) -> str | None:
    try:
        target = parse_ssh(value)
    except ValueError:
        return str(value)
    return target.label if target else None


def key_info(name: str, entry: dict[str, Any]) -> dict[str, Any]:
    """Where the API key of an entry comes from, and if the daemon has it now. Never the key."""
    if entry.get("api_key"):
        return {"source": "file", "set": True}
    env = entry.get("api_key_env")
    if env:
        return {"source": "env", "env": env, "set": bool(os.environ.get(env))}
    if entry.get("key_store") == "client":
        return {"source": "client", "set": bool(CLIENT_KEYS.get(name))}
    return {"source": "none", "set": False}


def list_items() -> tuple[list[dict[str, Any]], bool]:
    """The providers for the client, and True if providers.json exists."""
    entries, exists = read_provider_entries()
    items = []
    for name, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        base_url = str(entry.get("base_url") or "")
        kind = entry.get("kind") or "auto"
        items.append({
            "name": name,
            "base_url": base_url,
            "kind": kind,
            # The kind that the daemon uses: "auto" is "ollama" for port 11434.
            "kind_resolved": kind if kind != "auto" else ("ollama" if urlparse(base_url).port == 11434 else "openai"),
            "enabled": is_enabled(entry),
            "context_length": entry.get("context_length"),
            "ssh": _ssh_label(entry.get("ssh")),
            "models": sorted(entry.get("models") or {}) if isinstance(entry.get("models"), dict) else [],
            "key": key_info(name, entry),
        })
    return items, exists


def _check_fields(fields: dict[str, Any]) -> dict[str, Any]:
    """Check the form fields of a provider. Return the clean values."""
    name = str(fields.get("name") or "").strip()
    if not NAME_RE.match(name):
        raise ConfigError("The name must start with a letter or a digit, and have only letters, digits, '.', '_', or '-'.")
    base_url = str(fields.get("base_url") or "").strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ConfigError("The URL must start with http:// or https://, for example https://api.openai.com/v1.")
    kind = str(fields.get("kind") or "auto")
    if kind not in KINDS:
        raise ConfigError(f"The kind must be one of: {', '.join(KINDS)}.")
    context = fields.get("context_length")
    if context in (None, ""):
        context = None
    else:
        try:
            context = int(context)
        except (TypeError, ValueError):
            context = 0
        if context <= 0:
            raise ConfigError("The context length must be a positive number of tokens.")
    ssh = str(fields.get("ssh") or "").strip() or None
    if ssh:
        try:
            parse_ssh(ssh)
        except ValueError as e:
            raise ConfigError(f"SSH: {e}") from None
    key_mode = str(fields.get("key") or "keep")
    if key_mode not in KEY_MODES:
        raise ConfigError(f"The key setting must be one of: {', '.join(KEY_MODES)}.")
    env = str(fields.get("api_key_env") or "").strip()
    if key_mode == "env" and not ENV_RE.match(env):
        raise ConfigError("Give the name of an environment variable, for example OPENAI_API_KEY.")
    return {"name": name, "base_url": base_url, "kind": kind, "context_length": context, "ssh": ssh,
            "key": key_mode, "api_key_env": env}


def _apply(entry: dict[str, Any], clean: dict[str, Any]) -> dict[str, Any]:
    """The entry with the form values. Other fields (for example "models") stay the same."""
    entry = dict(entry)
    entry["base_url"] = clean["base_url"]
    for field_name, value in (("kind", None if clean["kind"] == "auto" else clean["kind"]),
                              ("context_length", clean["context_length"])):
        if value is None:
            entry.pop(field_name, None)
        else:
            entry[field_name] = value
    if clean["ssh"] is None:
        entry.pop("ssh", None)
    elif _ssh_label(entry.get("ssh")) != clean["ssh"]:
        entry["ssh"] = clean["ssh"]  # Keep an object form (with an identity file) that did not change.
    mode = clean["key"]
    if mode != "keep":
        for field_name in ("api_key", "api_key_env", "key_store"):
            entry.pop(field_name, None)
        if mode == "client":
            entry["key_store"] = "client"
        elif mode == "env":
            entry["api_key_env"] = clean["api_key_env"]
    return entry


def save_provider(fields: dict[str, Any], previous_name: str | None = None) -> str:
    """Add a provider, or change the provider ``previous_name``. Return the name."""
    clean = _check_fields(fields)
    name = clean["name"]
    entries, _ = read_provider_entries()
    if previous_name is not None and previous_name not in entries:
        raise ConfigError(f"Unknown provider: {previous_name}")
    if name in entries and name != previous_name:
        raise ConfigError(f"A provider with the name {name} exists. Use another name.")
    old = entries.get(previous_name) if previous_name else None
    entry = _apply(old if isinstance(old, dict) else {}, clean)
    if previous_name and previous_name != name:
        # Keep the position of the provider: the first provider is the default for a bare model name.
        entries = {(name if key == previous_name else key): (entry if key == previous_name else value)
                   for key, value in entries.items()}
        if previous_name in CLIENT_KEYS:
            CLIENT_KEYS[name] = CLIENT_KEYS.pop(previous_name)
    else:
        entries[name] = entry
    write_json(providers_path(), entries)
    return name


def delete_provider(name: str) -> None:
    entries, _ = read_provider_entries()
    if name not in entries:
        raise ConfigError(f"Unknown provider: {name}")
    if len(entries) == 1:
        raise ConfigError("The last provider cannot be deleted. Turn it off, or add another provider first.")
    del entries[name]
    CLIENT_KEYS.pop(name, None)
    write_json(providers_path(), entries)


def set_enabled(name: str, enabled: bool) -> None:
    entries, _ = read_provider_entries()
    entry = entries.get(name)
    if not isinstance(entry, dict):
        raise ConfigError(f"Unknown provider: {name}")
    if enabled:
        entry.pop("enabled", None)
    else:
        entry["enabled"] = False
    write_json(providers_path(), entries)


def set_client_keys(keys: dict[str, Any]) -> list[str]:
    """Keep the keys that the client sent. A null value removes a key. Return the changed names."""
    changed = []
    for name, key in keys.items():
        if not isinstance(name, str):
            continue
        if isinstance(key, str) and key.strip():
            if CLIENT_KEYS.get(name) != key.strip():
                CLIENT_KEYS[name] = key.strip()
                changed.append(name)
        elif key is None and name in CLIENT_KEYS:
            del CLIENT_KEYS[name]
            changed.append(name)
    return changed


def provider_for_test(fields: dict[str, Any], api_key: str | None) -> Provider:
    """A provider from the form values, before a save. With no new key, it uses the saved key."""
    clean = _check_fields({**fields, "key": "keep"})
    entries, _ = read_provider_entries()
    previous = fields.get("previous_name") or clean["name"]
    old = entries.get(previous)
    entry = _apply(old if isinstance(old, dict) else {}, clean)
    if api_key:
        entry = {k: v for k, v in entry.items() if k not in ("api_key_env", "key_store")}
        entry["api_key"] = api_key
    # The saved client key is under the saved name, also for a rename that is not saved yet.
    return _provider_from_entry(previous if previous in entries else clean["name"], entry)


async def list_models(provider: Provider, timeout: float = TEST_TIMEOUT) -> dict[str, Any]:
    """Ask the endpoint for its models (GET <base_url>/models). Return ok, models, error, and ms."""
    start = time.monotonic()

    def result(ok: bool, **fields: Any) -> dict[str, Any]:
        return {"ok": ok, "ms": int((time.monotonic() - start) * 1000), **fields}

    try:
        reachable = await endpoint(provider)
    except TunnelError as e:
        return result(False, error=str(e))
    headers = {}
    if provider.api_key and provider.api_key != "none":
        headers["Authorization"] = f"Bearer {provider.api_key}"
    url = f"{reachable.base_url}/models"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url, headers=headers)
    except httpx.TimeoutException:
        return result(False, error=f"No answer from {provider.base_url} in {timeout:g} seconds.")
    except httpx.HTTPError as e:
        return result(False, error=f"Cannot connect to {provider.base_url}: {e}")
    if response.status_code in (401, 403):
        hint = f" {provider.key_missing}" if provider.key_missing else ""
        return result(False, error=f"The endpoint rejected the API key (HTTP {response.status_code}).{hint}")
    if response.status_code != 200:
        return result(False, error=f"The endpoint returned HTTP {response.status_code} for {url}: {response.text[:200]}")
    try:
        data = response.json()
    except ValueError:
        return result(False, error=f"{url} did not return JSON. Check that the URL ends with /v1.")
    raw = data.get("data") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return result(False, error=f"{url} did not return a model list. Check that the URL ends with /v1.")
    models = sorted({str(m.get("id")) for m in raw if isinstance(m, dict) and m.get("id")})
    return result(True, models=models[:MAX_MODELS], truncated=len(models) > MAX_MODELS)


async def all_models() -> dict[str, Any]:
    """The models of each provider that is on, for the model field of the start screen."""
    entries, _ = read_provider_entries()
    providers = []
    errors = []
    for name, entry in entries.items():
        if not is_enabled(entry):
            continue
        try:
            providers.append(_provider_from_entry(name, entry))
        except ConfigError as e:
            errors.append({"provider": name, "message": str(e)})
    results = await asyncio.gather(*(list_models(p, LIST_TIMEOUT) for p in providers))
    items = []
    for provider, found in zip(providers, results):
        if found["ok"]:
            items.extend({"provider": provider.name, "model": m} for m in found["models"])
        else:
            errors.append({"provider": provider.name, "message": found["error"]})
    return {"items": items, "errors": errors}
