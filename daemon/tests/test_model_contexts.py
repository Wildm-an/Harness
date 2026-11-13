"""The saved context lengths (model_contexts.py): they stay after a restart, and providers.json wins."""

from __future__ import annotations

import asyncio
import json

import pytest

from harness_daemon import model_contexts
from harness_daemon.providers import resolve_model
from harness_daemon.server import MODEL_CHECKS, Connection

from test_context import make_agent, old_turns


@pytest.mark.parametrize("message, limit", [
    ("This model's maximum context length is 131072 tokens. However, you requested 140000 tokens.", 131072),
    ("the request exceeds the available context size (4096 tokens), try increasing it", 4096),
    ("request (9000 tokens) exceeds the available context size (8192 tokens)", 8192),
    ("Trying to keep the first 5000 tokens when context the overflows. However, the model is loaded with "
     "context length of only 4096 tokens, which is not enough.", 4096),
    ("prompt is too long: 210500 tokens > 200000 maximum", 200000),
    ("Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 30000", 32768),
    ("The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).", 1048576),
    ("Prompt contains 40000 tokens, too large for model with 32768 maximum context length", 32768),
    ("This model's maximum context length is 65,536 tokens.", 65536),
    ("The model endpoint returned HTTP 500: internal error", None),
    ("max_tokens must be at most 100", None),
])
def test_the_limit_in_an_error_message(message, limit):
    assert model_contexts.limit_from_error(message) == limit


def test_save_and_lookup(harness_home):
    assert model_contexts.save("box", "http://a/v1", "m", 32768, "model list")
    assert model_contexts.lookup("box", "http://a/v1", "m") == (32768, "model list")
    assert not model_contexts.save("box", "http://a/v1", "m", 32768, "model list")  # No change.
    assert model_contexts.lookup("box", "http://b/v1", "m") is None  # The base URL changed.
    assert model_contexts.lookup("box", "http://a/v1", "other") is None
    # Values that are not measurements are not saved.
    for source in ("default", "settings", "providers.json"):
        assert not model_contexts.save("box", "http://a/v1", "n", 4096, source)
    # A saved value that goes back to the file keeps its first source.
    assert model_contexts.save("box", "http://a/v1", "m", 65536, "llama-server (saved)")
    assert model_contexts.lookup("box", "http://a/v1", "m") == (65536, "llama-server")
    entry = json.loads((harness_home / model_contexts.FILE_NAME).read_text())["box/m"]
    assert entry["base_url"] == "http://a/v1" and entry["measured_at"].endswith("Z")


def test_a_bad_file_gives_no_value(harness_home):
    (harness_home / model_contexts.FILE_NAME).write_text("{not json")
    assert model_contexts.lookup("box", "http://a/v1", "m") is None


def _set_fake(harness_home, **fields):
    data = json.loads((harness_home / "providers.json").read_text())
    data["fake"].update(fields)
    (harness_home / "providers.json").write_text(json.dumps(data))


def _checks(model="fake/m"):
    provider, name = resolve_model(model)
    return asyncio.run(Connection.model_checks(provider, name, {}))


def test_a_measured_length_stays_after_a_restart(harness_home, fake_model):
    warnings, context, _ = _checks()
    assert (context.length, context.source) == (32768, "Ollama num_ctx") and warnings == []
    provider, _ = resolve_model("fake/m")
    assert model_contexts.lookup("fake", provider.base_url, "m") == (32768, "Ollama num_ctx")

    # A restart: the memory is empty, and the endpoint gives no context length now.
    MODEL_CHECKS.clear()
    _set_fake(harness_home, kind="openai")  # No /props and no model list on the fake server.
    provider, _ = resolve_model("fake/m")
    _, opened, _, fresh = Connection.quick_model_info(provider, "m", {})
    assert (opened.length, opened.source, fresh) == (32768, "Ollama num_ctx (saved)", False)
    warnings, context, _ = _checks()
    assert (context.length, context.source) == (32768, "Ollama num_ctx (saved)")
    assert not any("is unknown" in w for w in warnings)
    assert not MODEL_CHECKS  # A saved value is not a new check: the next turn checks again.


def test_providers_json_wins_over_a_saved_value(harness_home, fake_model):
    _checks()  # Saves 32768.
    MODEL_CHECKS.clear()
    _set_fake(harness_home, models={"m": {"context_length": 65536}})
    provider, _ = resolve_model("fake/m")
    _, opened, _, _ = Connection.quick_model_info(provider, "m", {})
    assert (opened.length, opened.source) == (65536, "providers.json")
    _, context, _ = _checks()
    assert (context.length, context.source) == (65536, "providers.json")
    _, context, _ = asyncio.run(Connection.model_checks(provider, "m", {"context_length": 1000}))
    assert (context.length, context.source) == (1000, "settings")


def test_no_saved_value_gives_the_unknown_warning(harness_home, fake_model):
    _set_fake(harness_home, kind="openai")
    warnings, context, _ = _checks()
    assert context.source == "default" and any("is unknown" in w for w in warnings)


def test_a_context_error_gives_the_length_and_the_agent_compacts(harness_home, project, fake_model):
    agent, events, compactions = make_agent(project, old_turns(6))
    agent.context_length, agent.context_source = 1_000_000, "default"
    limit = int(agent.context_tokens() / 0.9)
    fake_model.script(
        {"error": f"This model's maximum context length is {limit} tokens. However, you requested 1000000 tokens.",
         "status": 400},
        {"text": "The user asked six questions."},  # The summary.
        {"text": "Done."},
    )
    assert asyncio.run(agent.run_turn("Question 6")) == "end"
    assert (agent.context_length, agent.context_source) == (limit, "error message")
    info = next(e for e in events if e["type"] == "session.model_info")
    assert (info["context_length"], info["context_source"]) == (limit, "error message")
    assert compactions and any(e["type"] == "context.compacted" for e in events)
    assert model_contexts.lookup("fake", agent.client.provider.base_url, "m") == (limit, "error message")


def test_a_context_error_does_not_change_a_providers_json_value(harness_home, project, fake_model):
    agent, events, _ = make_agent(project, [])
    agent.context_length, agent.context_source = 65536, "providers.json"
    fake_model.script({"error": "This model's maximum context length is 4096 tokens.", "status": 400})
    try:
        asyncio.run(agent.run_turn("hi"))
    except Exception:  # noqa: BLE001 - the turn fails: only the context length matters here.
        pass
    assert (agent.context_length, agent.context_source) == (65536, "providers.json")
    assert not any(e["type"] == "session.model_info" for e in events)
