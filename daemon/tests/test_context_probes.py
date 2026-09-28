"""The context length checks for each server type: llama-server, LM Studio, TGI, the model list, and Ollama."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from harness_daemon import providers
from harness_daemon.providers import Provider, model_contexts, resolve_context_length

# A server answers only its own paths. Each test gives the paths of one server type.
Routes = dict[tuple[str, str], Any]


@pytest.fixture
def server(monkeypatch):
    """Send the requests of providers.py to a fake server with the given routes. Record the requests."""
    state: dict[str, Any] = {"routes": {}, "requests": []}

    def handle(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)
        body = state["routes"].get((request.method, request.url.path))
        return httpx.Response(404) if body is None else httpx.Response(200, json=body)

    real = httpx.AsyncClient

    def client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        return real(*args, transport=httpx.MockTransport(handle), **kwargs)

    monkeypatch.setattr(providers.httpx, "AsyncClient", client)
    return state


def provider(kind: str = "openai", **fields: Any) -> Provider:
    return Provider("p", "http://box:8000/v1", kind=kind, **fields)


def resolve(p: Provider, model: str = "m") -> providers.ContextInfo:
    return asyncio.run(resolve_context_length(p, model, {}))


def test_llama_server_props(server):
    server["routes"] = {("GET", "/props"): {"default_generation_settings": {"n_ctx": 16384}}}
    info = resolve(provider())
    assert (info.length, info.source) == (16384, "llama-server")


def test_lm_studio_prefers_the_loaded_context(server):
    server["routes"] = {("GET", "/api/v0/models"): {"data": [
        {"id": "m", "state": "loaded", "max_context_length": 131072, "loaded_context_length": 32768},
        {"id": "other", "state": "not-loaded", "max_context_length": 65536},
    ]}}
    loaded = resolve(provider())
    assert (loaded.length, loaded.source, loaded.warning) == (32768, "LM Studio (loaded model)", None)
    maximum = resolve(provider(), "other")
    assert (maximum.length, maximum.source) == (65536, "LM Studio (model maximum)")
    assert "load settings" in maximum.warning


def test_text_generation_inference_info(server):
    server["routes"] = {("GET", "/info"): {"model_id": "org/model", "max_input_tokens": 8191, "max_total_tokens": 8192}}
    info = resolve(provider())
    assert (info.length, info.source) == (8192, "Text Generation Inference")


def test_model_list_fields_and_the_api_key(server):
    server["routes"] = {("GET", "/v1/models"): {"data": [
        {"id": "m", "max_model_len": 40960},  # vLLM
        {"id": "router/model", "context_length": 200000},  # OpenRouter
    ]}}
    p = provider(api_key="sk-secret")
    assert (resolve(p).length, resolve(p).source) == (40960, "model list")
    assert resolve(p, "router/model").length == 200000
    # vLLM with --api-key answers /models only with the key.
    assert all(r.headers.get("Authorization") == "Bearer sk-secret" for r in server["requests"])


def test_no_key_sends_no_authorization(server):
    resolve(provider())
    assert server["requests"] and not any("Authorization" in r.headers for r in server["requests"])


def test_contexts_of_a_model_list_use_one_request_per_source(server):
    server["routes"] = {("GET", "/api/v0/models"): {"data": [{"id": "a", "max_context_length": 4096}]}}
    listing = [{"id": "a"}, {"id": "b", "context_length": 8000}, {"id": "c"}]
    found = asyncio.run(model_contexts(provider(models={"c": {"context_length": 1234}}), ["a", "b", "c", "d"], listing))
    assert {m: (i.length, i.source) for m, i in found.items()} == {
        "a": (4096, "LM Studio (model maximum)"),
        "b": (8000, "model list"),
        "c": (1234, "providers.json"),
    }
    # The caller gave the model list, so the server gets no second /models request.
    paths = sorted(r.url.path for r in server["requests"])
    assert paths == ["/api/v0/models", "/info", "/props"]


def test_contexts_of_ollama_models(server):
    server["routes"] = {
        ("GET", "/api/ps"): {"models": [{"name": "big:latest", "context_length": 65536}]},
        ("POST", "/api/show"): {"parameters": "num_ctx 32768\ntemperature 0.2"},
    }
    found = asyncio.run(model_contexts(provider("ollama"), ["big:latest", "small:latest"]))
    assert (found["big:latest"].length, found["big:latest"].source) == (65536, "Ollama (loaded model)")
    assert (found["small:latest"].length, found["small:latest"].source) == (32768, "Ollama num_ctx")


def test_a_provider_context_length_needs_no_request(server):
    found = asyncio.run(model_contexts(provider(context_length=100000), ["a", "b"]))
    assert {i.length for i in found.values()} == {100000} and server["requests"] == []


def test_context_info_json():
    assert providers.ContextInfo(10, "settings").to_json() == {"length": 10, "source": "settings"}
    assert providers.ContextInfo(10, "x", "careful").to_json()["warning"] == "careful"
