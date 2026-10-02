from __future__ import annotations

import asyncio

import pytest

from harness_daemon import update


def test_only_a_python_daemon_can_update(monkeypatch):
    update.enable(["--port", "8765", "--new-token"], sidecar=False)
    assert update.refusal() is None
    assert update._argv == ["--port", "8765"]  # A restart must not make a new token.
    update.enable(["--exit-on-stdin-eof"], sidecar=True)
    assert "cannot update itself" in update.refusal()
    monkeypatch.setattr(update.frozen, "is_frozen", lambda: True)
    assert "desktop app" in update.refusal()


@pytest.mark.parametrize("name, ok", [
    ("harness_daemon-0.1.30-py3-none-any.whl", True),
    ("harness_daemon-1.2.3+local-py3-none-any.whl", True),
    ("../harness_daemon-0.1.30-py3-none-any.whl", False),
    ("other-0.1.30-py3-none-any.whl", False),
    ("harness_daemon-0.1.30.tar.gz", False),
])
def test_wheel_names(name, ok):
    assert bool(update.WHEEL_NAME.match(name)) is ok


def test_install_refuses_another_file(harness_home):
    with pytest.raises(RuntimeError, match="Not a wheel"):
        asyncio.run(update.install("evil.whl", b"x"))
