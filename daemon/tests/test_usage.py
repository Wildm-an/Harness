"""The cached prompt tokens of a model reply (providers.cached_tokens)."""

from __future__ import annotations

import asyncio

from harness_daemon.providers import ModelClient, cached_tokens, resolve_model


def test_cached_tokens_shapes():
    assert cached_tokens({"prompt_tokens_details": {"cached_tokens": 64}}) == 64
    assert cached_tokens({"prompt_cache_hit_tokens": 12}) == 12
    assert cached_tokens({"cache_read_input_tokens": 5}) == 5
    assert cached_tokens({"prompt_tokens": 100}) is None and cached_tokens(None) is None


def test_the_model_response_has_the_cached_tokens(harness_home, fake_model, caplog):
    provider, model = resolve_model("fake/test-model")
    client = ModelClient(provider, model)

    async def on_text(_):
        pass

    fake_model.script({"text": "hi", "cached_tokens": 64}, {"text": "again"})
    with caplog.at_level("INFO", logger="harness.timing"):
        first = asyncio.run(client.stream([{"role": "user", "content": "x"}], [], on_text))
    second = asyncio.run(client.stream([{"role": "user", "content": "x"}], [], on_text))
    assert first.cached_tokens == 64 and second.cached_tokens is None
    assert "prompt 100 (cached 64)" in caplog.text
