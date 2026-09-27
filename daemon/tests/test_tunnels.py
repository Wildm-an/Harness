"""Tests for SSH tunnels to model endpoints. A fake ssh program forwards the port to the fake model."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from harness_daemon import tunnels
from harness_daemon.config import ConfigError
from harness_daemon.providers import ModelClient, ModelError, load_providers, resolve_model
from harness_daemon.tunnels import SshTarget, parse_ssh

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

# The base interpreter, not the venv launcher: a kill of the launcher leaves its child process alive.
FAKE_SSH = [getattr(sys, "_base_executable", sys.executable), str(Path(__file__).with_name("fake_ssh.py"))]


@pytest.mark.parametrize("value,expected", [
    ("gpu-box", SshTarget("gpu-box")),
    ("drew@gpu-box", SshTarget("gpu-box", "drew")),
    ("drew@gpu-box:2222", SshTarget("gpu-box", "drew", 2222)),
    ({"host": "gpu", "user": "d", "port": "22", "identity_file": "~/.ssh/k"}, SshTarget("gpu", "d", 22, "~/.ssh/k")),
    (None, None),
])
def test_parse_ssh(value, expected):
    assert parse_ssh(value) == expected


@pytest.mark.parametrize("value", ["-oProxyCommand=calc", "drew@-oProxyCommand=calc", "a b", {"host": ""}, 42])
def test_parse_ssh_rejects_bad_values(value):
    with pytest.raises(ValueError):
        parse_ssh(value)


def write_provider(home, fake_model, ssh="drew@gpu-box"):
    # The base_url is the model address as the SSH host sees it.
    (home / "providers.json").write_text(json.dumps({
        "gpu": {"base_url": fake_model.base_url, "api_key": "x", "kind": "ollama", "ssh": ssh},
    }))


@pytest.fixture
def fake_ssh(monkeypatch, tmp_path):
    log = tmp_path / "ssh.log"
    monkeypatch.setattr(tunnels, "SSH_COMMAND", FAKE_SSH)
    monkeypatch.setenv("FAKE_SSH_LOG", str(log))
    monkeypatch.delenv("FAKE_SSH_FAIL", raising=False)
    yield log
    tunnels.TUNNELS.close_all()


def test_a_bad_ssh_value_is_a_config_error(harness_home, fake_model):
    write_provider(harness_home, fake_model, ssh="-oProxyCommand=calc")
    with pytest.raises(ConfigError, match="not valid"):
        load_providers()


def test_model_calls_go_through_the_tunnel(harness_home, fake_model, fake_ssh):
    write_provider(harness_home, fake_model)
    fake_model.script({"text": "one"}, {"text": "two"}, {"text": "three"})
    client = ModelClient(*resolve_model("gpu/m"))

    async def ignore(_):
        return None

    async def scenario():
        first = await client.stream([{"role": "user", "content": "hi"}], [], ignore)
        second = await client.stream([{"role": "user", "content": "hi"}], [], ignore)
        # ssh stops (for example, the network drops). The next call opens a new tunnel.
        for t in tunnels.TUNNELS._tunnels.values():
            t.proc.kill()
            t.proc.wait()
        third = await client.stream([{"role": "user", "content": "hi"}], [], ignore)
        return first.text, second.text, third.text

    assert asyncio.run(scenario()) == ("one", "two", "three")
    calls = [json.loads(line) for line in fake_ssh.read_text().splitlines()]
    assert len(calls) == 2  # One tunnel for two calls, then one new tunnel.
    args = calls[0]
    assert args[args.index("-L") + 1].endswith(f":127.0.0.1:{fake_model.port}")
    assert "BatchMode=yes" in args and args[-2:] == ["--", "drew@gpu-box"]
    assert client._base_url.startswith("http://127.0.0.1:") and client._base_url.endswith("/v1")
    assert str(fake_model.port) not in client._base_url  # The local port of the tunnel, not the model port.


def test_a_failed_tunnel_is_a_model_error(harness_home, fake_model, fake_ssh, monkeypatch):
    write_provider(harness_home, fake_model)
    monkeypatch.setenv("FAKE_SSH_FAIL", "drew@gpu-box: Permission denied (publickey).")
    client = ModelClient(*resolve_model("gpu/m"))

    async def ignore(_):
        return None

    with pytest.raises(ModelError, match=r"SSH tunnel to drew@gpu-box failed: .*Permission denied"):
        asyncio.run(client.stream([{"role": "user", "content": "hi"}], [], ignore))


def test_real_ssh_failure_message(harness_home, fake_model, monkeypatch):
    """The real ssh client with no SSH server: the error message comes back to the user."""
    monkeypatch.setattr(tunnels, "SSH_COMMAND", ["ssh"])
    write_provider(harness_home, fake_model, ssh="nobody@127.0.0.1:1")
    client = ModelClient(*resolve_model("gpu/m"))

    async def ignore(_):
        return None

    try:
        with pytest.raises(ModelError, match="SSH tunnel to nobody@127.0.0.1:1 failed"):
            asyncio.run(client.stream([{"role": "user", "content": "hi"}], [], ignore))
    finally:
        tunnels.TUNNELS.close_all()


def test_session_through_a_tunnel(daemon, harness_home, project, fake_model, fake_ssh):  # noqa: F811
    write_provider(harness_home, fake_model)
    fake_model.script({"text": "Hello through SSH."})
    c = Client(daemon)
    ready = c.new_session(project, model="gpu/m")
    assert ready["warnings"] == [] and ready["context_length"] == 32768  # The probes also use the tunnel.
    c.send({"type": "prompt", "text": "hi"})
    end, seen = c.until("turn.end")
    assert "".join(m["text"] for m in seen if m["type"] == "token") == "Hello through SSH."
    c.close()


def test_session_warns_when_the_tunnel_fails(daemon, harness_home, project, fake_model, fake_ssh, monkeypatch):  # noqa: F811
    write_provider(harness_home, fake_model)
    monkeypatch.setenv("FAKE_SSH_FAIL", "ssh: Could not resolve hostname gpu-box")
    c = Client(daemon)
    ready = c.new_session(project, model="gpu/m")
    assert "Could not resolve hostname" in ready["warnings"][0]
    c.close()
