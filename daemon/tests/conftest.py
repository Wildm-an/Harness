from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_openai import FakeModel  # noqa: E402


@pytest.fixture(scope="session")
def fake_model_server():
    server = FakeModel().start()
    yield server
    server.stop()


@pytest.fixture
def fake_model(fake_model_server):
    fake_model_server.replies.clear()
    fake_model_server.requests.clear()
    fake_model_server.title_requests.clear()
    fake_model_server.title = "Fake session title"
    fake_model_server.classifier_requests.clear()
    fake_model_server.verdicts.clear()
    fake_model_server.capabilities = ["completion", "tools"]
    fake_model_server.num_ctx = 32768
    fake_model_server.required_key = None
    yield fake_model_server
    assert not fake_model_server.replies, "Some scripted replies were not used."


@pytest.fixture
def harness_home(tmp_path, monkeypatch, fake_model_server):
    from harness_daemon.server import MODEL_CHECKS
    MODEL_CHECKS.clear()  # Each test sets its own fake model.
    home = tmp_path / "harness-home"
    home.mkdir()
    monkeypatch.setenv("HARNESS_HOME", str(home))
    # Do not load the skills of the real ~/.claude folder.
    claude = tmp_path / "claude-home"
    claude.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    (home / "providers.json").write_text(json.dumps({
        "fake": {"base_url": fake_model_server.base_url, "api_key": "test", "kind": "ollama"},
    }))
    return home


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "hello.py").write_bytes(b"def greet():\n    return 'hello'\n\nprint(greet())\n")
    return root
