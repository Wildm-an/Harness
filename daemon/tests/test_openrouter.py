"""OpenRouter: the kind from the URL, the model checks from the model list, and the key check."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from harness_daemon import provider_config, providers
from harness_daemon.providers import Provider, default_kind, model_capabilities, resolve_context_length

BASE = "https://openrouter.ai/api/v1"

MODELS = [
    {"id": "anthropic/claude-sonnet", "context_length": 200000,
     "architecture": {"input_modalities": ["text", "image"]}, "supported_parameters": ["tools", "temperature"]},
    {"id": "some/text-only", "context_length": 32768,
     "architecture": {"input_modalities": ["text"]}, "supported_parameters": ["temperature"]},
    {"id": "old/model", "context_length": 4096},  # No supported_parameters: the list does not tell.
]


@pytest.fixture
def openrouter(monkeypatch):
    """A fake OpenRouter: GET /models with no key, and GET /key with the key "sk-or-good". Record the requests."""
    state: dict[str, Any] = {"requests": []}
    providers.OPENROUTER_LISTS.clear()

    def handle(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)
        if request.method == "GET" and request.url.path == "/api/v1/models":
            return httpx.Response(200, json={"data": MODELS})
        if request.method == "GET" and request.url.path == "/api/v1/key":
            if request.headers.get("Authorization") == "Bearer sk-or-good":
                return httpx.Response(200, json={"data": {"label": "sk-or-...", "limit_remaining": 5}})
            return httpx.Response(401, json={"error": {"message": "No auth credentials found", "code": 401}})
        return httpx.Response(404)

    real = httpx.AsyncClient

    def client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        return real(*args, transport=httpx.MockTransport(handle), **kwargs)

    monkeypatch.setattr(providers.httpx, "AsyncClient", client)
    yield state
    providers.OPENROUTER_LISTS.clear()


def router(api_key: str = "sk-or-good") -> Provider:
    return Provider("openrouter", BASE, api_key=api_key, kind="openrouter")


def paths(state: dict[str, Any]) -> list[str]:
    return [r.url.path for r in state["requests"]]


def test_the_kind_comes_from_the_url():
    assert default_kind(BASE) == "openrouter"
    assert default_kind("https://eu.openrouter.ai/api/v1") == "openrouter"
    assert default_kind("https://notopenrouter.ai/v1") == "openai"
    assert default_kind("http://localhost:11434/v1") == "ollama"
    assert default_kind("https://api.openai.com/v1") == "openai"
    assert providers._provider_from_entry("x", {"base_url": BASE}).kind == "openrouter"
    assert providers._provider_from_entry("x", {"base_url": BASE, "kind": "auto"}).kind == "openrouter"
    assert providers._provider_from_entry("x", {"base_url": BASE, "kind": "openai"}).kind == "openai"


def test_tool_and_image_support_come_from_the_model_list(openrouter):
    caps = lambda model: asyncio.run(model_capabilities(router(), model))  # noqa: E731
    assert caps("anthropic/claude-sonnet") == ["completion", "tools", "vision"]
    assert caps("some/text-only") == ["completion"]
    assert caps("old/model") is None  # Unknown: no warning.
    assert caps("not/listed") is None
    # The list is large: the daemon asks for it one time.
    assert paths(openrouter) == ["/api/v1/models"]


def test_the_context_length_comes_only_from_the_model_list(openrouter):
    info = asyncio.run(resolve_context_length(router(), "anthropic/claude-sonnet", {}))
    assert (info.length, info.source, info.warning) == (200000, "OpenRouter", None)
    # No requests for the probes of local servers (/props, /api/v0/models, /info).
    assert paths(openrouter) == ["/api/v1/models"]


def test_the_connection_test_checks_the_key(openrouter):
    good = asyncio.run(provider_config.list_models(router(), verify_key=True))
    assert good["ok"] is True
    assert good["models"] == sorted(m["id"] for m in MODELS)
    assert good["contexts"]["anthropic/claude-sonnet"] == {"length": 200000, "source": "OpenRouter"}

    bad = asyncio.run(provider_config.list_models(router("sk-or-bad"), verify_key=True))
    assert bad["ok"] is False
    assert "rejected the API key (HTTP 401)" in bad["error"]

    missing = asyncio.run(provider_config.list_models(router("none"), verify_key=True))
    assert missing["ok"] is False
    assert "OpenRouter needs an API key" in missing["error"]


def test_the_model_list_of_the_start_screen_does_not_check_the_key(openrouter):
    found = asyncio.run(provider_config.list_models(router("sk-or-bad"), contexts=False))
    assert found["ok"] is True
    assert "/api/v1/key" not in paths(openrouter)


def test_the_providers_screen_shows_the_resolved_kind(harness_home):
    provider_config.save_provider({"name": "openrouter", "base_url": BASE, "kind": "auto", "key": "none"})
    items, _ = provider_config.list_items()
    item = next(i for i in items if i["name"] == "openrouter")
    assert (item["kind"], item["kind_resolved"]) == ("auto", "openrouter")
    provider_config.save_provider({"name": "openrouter", "base_url": BASE, "kind": "openrouter", "key": "keep"},
                                  previous_name="openrouter")
    items, _ = provider_config.list_items()
    assert next(i for i in items if i["name"] == "openrouter")["kind"] == "openrouter"
