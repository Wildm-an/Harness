"""The model of an ACP harness from a Harness provider (acp_models.py)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from harness_daemon import acp_models
from harness_daemon.acp_models import KEY_ENV, Target
from test_server import Client, daemon  # noqa: F401 - the daemon fixture

FAKE = Path(__file__).resolve().parent / "fake_acp_agent.py"


def target(key: str | None = "sk-1", context: int | None = 32768) -> Target:
    return Target(provider="local", base_url="http://127.0.0.1:11434/v1", api_key=key, model="qwen3-coder:30b",
                  context=context)


def test_qwen_code_gets_flags_and_the_key_in_the_environment():
    args, env = acp_models.launch_options("qwen-code", target())
    assert args == ["--auth-type", "openai", "--model", "qwen3-coder:30b", "--openai-base-url", "http://127.0.0.1:11434/v1"]
    assert env == {"OPENAI_API_KEY": "sk-1"}
    assert "sk-1" not in args  # Never in the command line.
    assert acp_models.launch_options("qwen-code", target(key=None))[1] == {"OPENAI_API_KEY": "none"}


def test_goose_gets_environment_variables():
    args, env = acp_models.launch_options("goose", target())
    assert args == []
    assert env == {"GOOSE_PROVIDER": "openai", "GOOSE_MODEL": "qwen3-coder:30b", "OPENAI_HOST": "http://127.0.0.1:11434/v1",
                   "OPENAI_BASE_PATH": "chat/completions", "OPENAI_API_KEY": "sk-1", "GOOSE_CONTEXT_LIMIT": "32768"}
    # No key: a placeholder, so goose does not send the OpenAI key of the user's keyring.
    env = acp_models.launch_options("goose", target(key=None, context=None))[1]
    assert env["OPENAI_API_KEY"] == "none" and "GOOSE_CONTEXT_LIMIT" not in env


def test_codex_gets_a_provider_in_codex_config():
    args, env = acp_models.launch_options("codex-acp", target())
    config = json.loads(env["CODEX_CONFIG"])
    assert args == [] and env[KEY_ENV] == "sk-1" and "sk-1" not in env["CODEX_CONFIG"]
    assert config["model"] == "qwen3-coder:30b" and config["model_provider"] == "harness"
    assert config["model_providers"]["harness"]["wire_api"] == "responses"
    assert config["model_providers"]["harness"]["env_key"] == KEY_ENV
    # No key: no env_key (Codex stops when the variable is empty).
    env = acp_models.launch_options("codex-acp", target(key=None))[1]
    assert "env_key" not in json.loads(env["CODEX_CONFIG"])["model_providers"]["harness"] and KEY_ENV not in env


def test_opencode_gets_an_inline_config():
    args, env = acp_models.launch_options("opencode", target())
    config = json.loads(env["OPENCODE_CONFIG_CONTENT"])
    assert args == [] and env[KEY_ENV] == "sk-1" and "sk-1" not in env["OPENCODE_CONFIG_CONTENT"]
    assert config["model"] == "harness/qwen3-coder:30b"
    provider = config["provider"]["harness"]
    assert provider["npm"] == "@ai-sdk/openai-compatible"
    assert provider["options"] == {"baseURL": "http://127.0.0.1:11434/v1", "apiKey": "{env:%s}" % KEY_ENV}
    assert provider["models"]["qwen3-coder:30b"]["limit"]["context"] == 32768
    assert KEY_ENV not in acp_models.launch_options("opencode", target(key=None))[1]
    assert acp_models.session_model_id("opencode", target()) == "harness/qwen3-coder:30b"
    assert acp_models.session_model_id("goose", target()) == "qwen3-coder:30b"


def test_the_setting():
    assert acp_models.supports("goose") and not acp_models.supports("gemini")
    settings = {"harness_models": {"goose": "local/qwen", "gemini": "local/qwen"}}
    assert acp_models.choice(settings, "goose") == "local/qwen"
    assert acp_models.choice(settings, "gemini") is None
    assert acp_models.choice({}, "goose") is None
    assert acp_models.check_choice("goose", " local/qwen ") == "local/qwen"
    assert acp_models.check_choice("goose", None) is None and acp_models.check_choice("goose", "") is None
    with pytest.raises(ValueError):
        acp_models.check_choice("goose", "qwen")
    with pytest.raises(ValueError):
        acp_models.check_choice("gemini", "local/qwen")
    assert acp_models._ipv4_localhost("http://localhost:11434/v1") == "http://127.0.0.1:11434/v1"
    assert acp_models._ipv4_localhost("https://example.com/v1") == "https://example.com/v1"


@pytest.fixture
def fake_goose(harness_home):
    """The fake ACP agent as the downloaded "goose", and goose as the operating harness."""
    root = harness_home / "harnesses" / "goose"
    root.mkdir(parents=True)
    (root / "install.json").write_text(json.dumps({"version": "1.0.0", "kind": "binary",
                                                   "argv": [sys.executable, str(FAKE)], "env": {}, "dir": str(root)}))
    settings = harness_home / "settings.json"
    data = json.loads(settings.read_text()) if settings.exists() else {}
    data["operating_harness"] = "goose"
    settings.write_text(json.dumps(data))
    return harness_home


def test_the_daemon_gives_the_provider_model_to_the_harness(daemon, project, fake_goose):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "harnesses.list"})
    goose = next(i for i in c.until("harnesses")[0]["items"] if i["id"] == "goose")
    assert goose["provider_models"] is True and goose["provider_model"] is None
    c.send({"type": "harnesses.model", "id": "goose", "model": "fake/smart"})
    goose = next(i for i in c.until("harnesses")[0]["items"] if i["id"] == "goose")
    assert goose["provider_model"] == "fake/smart"
    c.send({"type": "harnesses.model", "id": "gemini", "model": "fake/smart"})
    assert "cannot use a model" in c.until("error")[0]["message"]
    c.close()

    c = Client(daemon)
    c.new_session(project)
    # The harness lists "smart": the new ACP session changes to it.
    state = c.until("acp.state", timeout=30)[0]
    while state["harness"].get("model") != "smart":
        state = c.until("acp.state", timeout=30)[0]
    c.send({"type": "prompt", "text": "env"})
    _, seen = c.until("turn.end", timeout=30)
    reply = json.loads("".join(m["text"] for m in seen if m["type"] == "token"))
    env = reply["env"]
    assert env["GOOSE_PROVIDER"] == "openai" and env["GOOSE_MODEL"] == "smart"
    assert env["OPENAI_HOST"].startswith("http://127.0.0.1:") and env["OPENAI_HOST"].endswith("/v1")
    assert env["OPENAI_BASE_PATH"] == "chat/completions" and env["OPENAI_API_KEY"] == "test"
    c.close()

    # A provider that is gone: the turn gives an error that names the setting.
    settings = fake_goose / "settings.json"
    data = json.loads(settings.read_text())
    data["harness_models"] = {"goose": "gone/model"}
    settings.write_text(json.dumps(data))
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "env"})
    error, _ = c.until("error", timeout=30)
    assert "Settings > Operating Harness" in error["message"]
    c.close()
