"""Tests for the Providers screen: providers.json changes, client keys, and the connection test."""

from __future__ import annotations

import asyncio
import json

import pytest

from harness_daemon import provider_config
from harness_daemon.config import ConfigError
from harness_daemon.providers import CLIENT_KEYS, load_providers, resolve_model

from test_server import Client, daemon  # noqa: F401 - the daemon fixture


@pytest.fixture(autouse=True)
def no_client_keys():
    CLIENT_KEYS.clear()
    yield
    CLIENT_KEYS.clear()


def read_file(home) -> dict:
    return json.loads((home / "providers.json").read_text())


def openai_fields(**changes) -> dict:
    return {"name": "openai", "base_url": "https://api.openai.com/v1/", "kind": "auto", "key": "client", **changes}


def test_a_new_key_goes_to_the_client_not_to_the_file(harness_home):
    provider_config.save_provider(openai_fields())
    entry = read_file(harness_home)["openai"]
    assert entry == {"base_url": "https://api.openai.com/v1", "key_store": "client"}
    assert list(read_file(harness_home)) == ["fake", "openai"]  # The first provider stays the default.

    item = next(i for i in provider_config.list_items()[0] if i["name"] == "openai")
    assert item["key"] == {"source": "client", "set": False} and item["kind_resolved"] == "openai"
    assert load_providers()["openai"].key_missing

    assert provider_config.set_client_keys({"openai": "sk-test"}) == ["openai"]
    provider, model = resolve_model("openai/gpt-5")
    assert (provider.api_key, model, provider.key_missing) == ("sk-test", "gpt-5", None)
    assert "sk-test" not in (harness_home / "providers.json").read_text()


def test_key_sources_and_plain_text_keys(harness_home, monkeypatch):
    (harness_home / "providers.json").write_text(json.dumps({
        "a": {"base_url": "http://x/v1", "api_key": "plain"},
        "b": {"base_url": "http://x/v1", "api_key_env": "HARNESS_TEST_KEY"},
    }))
    monkeypatch.delenv("HARNESS_TEST_KEY", raising=False)
    items = {i["name"]: i["key"] for i in provider_config.list_items()[0]}
    assert items == {"a": {"source": "file", "set": True},
                     "b": {"source": "env", "env": "HARNESS_TEST_KEY", "set": False}}
    # A new key from the screen removes the plain-text key from the file.
    provider_config.save_provider({"name": "a", "base_url": "http://x/v1", "key": "client"}, previous_name="a")
    assert "api_key" not in read_file(harness_home)["a"]
    # "keep" changes nothing about the key.
    provider_config.save_provider({"name": "b", "base_url": "http://y/v1", "key": "keep"}, previous_name="b")
    assert read_file(harness_home)["b"] == {"base_url": "http://y/v1", "api_key_env": "HARNESS_TEST_KEY"}


def test_rename_keeps_the_position_the_other_fields_and_the_key(harness_home):
    (harness_home / "providers.json").write_text(json.dumps({
        "first": {"base_url": "http://a/v1", "models": {"m": {"context_length": 1000}}, "key_store": "client"},
        "second": {"base_url": "http://b/v1"},
    }))
    CLIENT_KEYS["first"] = "k"
    provider_config.save_provider({"name": "renamed", "base_url": "http://a/v1", "context_length": "32768"},
                                  previous_name="first")
    data = read_file(harness_home)
    assert list(data) == ["renamed", "second"]
    assert data["renamed"] == {"base_url": "http://a/v1", "models": {"m": {"context_length": 1000}},
                               "key_store": "client", "context_length": 32768}
    assert CLIENT_KEYS == {"renamed": "k"}
    with pytest.raises(ConfigError, match="exists"):
        provider_config.save_provider({"name": "second", "base_url": "http://a/v1"}, previous_name="renamed")


@pytest.mark.parametrize("fields,message", [
    ({"name": "bad name", "base_url": "http://x/v1"}, "name"),
    ({"name": "a", "base_url": "ftp://x"}, "http://"),
    ({"name": "a", "base_url": "http://x/v1", "kind": "other"}, "kind"),
    ({"name": "a", "base_url": "http://x/v1", "context_length": "-5"}, "context length"),
    ({"name": "a", "base_url": "http://x/v1", "ssh": "-oProxyCommand=x"}, "SSH"),
    ({"name": "a", "base_url": "http://x/v1", "key": "env", "api_key_env": "1BAD"}, "environment variable"),
])
def test_bad_fields(harness_home, fields, message):
    with pytest.raises(ConfigError, match=message):
        provider_config.save_provider(fields)


def test_off_providers_and_delete(harness_home):
    (harness_home / "providers.json").write_text(json.dumps({
        "first": {"base_url": "http://a/v1"}, "second": {"base_url": "http://b/v1"}}))
    provider_config.set_enabled("first", False)
    assert read_file(harness_home)["first"]["enabled"] is False
    assert list(load_providers()) == ["second"]
    assert resolve_model("some-model")[0].name == "second"  # A bare model uses the first provider that is on.
    with pytest.raises(ConfigError, match="is off"):
        resolve_model("first/some-model")
    provider_config.set_enabled("first", True)
    assert "enabled" not in read_file(harness_home)["first"]

    provider_config.delete_provider("first")
    with pytest.raises(ConfigError, match="last provider"):
        provider_config.delete_provider("second")


def test_no_file_starts_from_the_default_provider(harness_home):
    (harness_home / "providers.json").unlink()
    items, exists = provider_config.list_items()
    assert not exists and [i["name"] for i in items] == ["local-ollama"]
    assert items[0]["kind_resolved"] == "ollama"
    provider_config.save_provider(openai_fields())
    assert list(read_file(harness_home)) == ["local-ollama", "openai"]


def test_connection_test(harness_home, fake_model):
    fake_model.required_key = "sk-right"
    base = fake_model.base_url
    fields = {"name": "fake", "base_url": base}

    async def main() -> None:
        found = await provider_config.list_models(provider_config.provider_for_test(fields, None))
        assert not found["ok"] and "rejected the API key (HTTP 401)" in found["error"]
        found = await provider_config.list_models(provider_config.provider_for_test(fields, "sk-right"))
        assert found["ok"] and found["models"] == ["other-model", "test-model"]
        bad = await provider_config.list_models(provider_config.provider_for_test(
            {"name": "x", "base_url": "http://127.0.0.1:9/v1"}, None), timeout=2)
        # Windows can wait for a closed port until the timeout. Other systems refuse at once.
        assert not bad["ok"] and ("Cannot connect" in bad["error"] or "No answer" in bad["error"])

    asyncio.run(main())


def test_providers_through_the_protocol(daemon, harness_home, project, fake_model):  # noqa: F811
    fake_model.required_key = "sk-right"
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "providers.list"})
    listing = c.until("providers")[0]
    assert listing["exists"] and [i["name"] for i in listing["items"]] == ["fake"]

    c.send({"type": "providers.save", "previous_name": "fake", "name": "fake", "base_url": fake_model.base_url,
            "kind": "ollama", "key": "client"})
    item = c.until("providers")[0]["items"][0]
    assert item["key"] == {"source": "client", "set": False}

    # With no key, the session starts with a warning.
    c.send({"type": "session.new", "cwd": str(project), "model": "fake/test-model"})
    ready = c.until("session.ready")[0]
    assert any("has no API key" in w for w in ready["warnings"])

    c.send({"type": "providers.test", "ref": "form", "name": "fake", "base_url": fake_model.base_url,
            "api_key": "sk-right"})
    result = c.until("providers.test")[0]
    assert result["ok"] and result["ref"] == "form" and "test-model" in result["models"]

    # The client sends the key from its keychain. The session uses it in the next model call.
    c.send({"type": "providers.keys", "keys": {"fake": "sk-right"}})
    assert c.until("providers")[0]["items"][0]["key"]["set"] is True
    c.send({"type": "models.list"})
    models = c.until("models")[0]
    assert {"provider": "fake", "model": "test-model"} in models["items"] and models["errors"] == []

    c.send({"type": "providers.enable", "name": "fake", "enabled": False})
    assert c.until("providers")[0]["items"][0]["enabled"] is False
    c.send({"type": "command", "name": "providers", "args": ""})
    assert c.until("command.result")[0]["panel"] == "providers"
    c.close()
