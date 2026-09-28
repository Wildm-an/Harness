"""The packaged daemon helpers (harness_daemon/frozen.py) and the sidecar smoke test."""

from __future__ import annotations

import io
import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest

from harness_daemon import frozen
from harness_daemon.__main__ import main
from harness_daemon.cookbook.hosts import Host

SIDECAR = Path(__file__).resolve().parent.parent / "build" / "sidecar" / "dist" / (
    "harness-daemon.exe" if os.name == "nt" else "harness-daemon")


@pytest.fixture
def as_frozen(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", "/app/harness-daemon")
    # The repair adds variables. monkeypatch restores only the variables that it changed, so
    # restore the full environment: a PLAYWRIGHT_BROWSERS_PATH that stays breaks the other tests.
    with mock.patch.dict(os.environ):
        os.environ.pop(frozen.REPAIRED_ENV, None)
        yield


def test_python_commands_in_the_dev_layout():
    assert frozen.python_stdin_argv() == [sys.executable, "-"]
    assert frozen.install_browser_argv() == [sys.executable, "-m", "playwright", "install", "chromium"]


def test_python_commands_in_the_frozen_daemon(as_frozen):
    assert frozen.python_stdin_argv() == ["/app/harness-daemon", "--python-stdin"]
    assert frozen.install_browser_argv() == ["/app/harness-daemon", "--install-browser"]
    # The local Cookbook host runs its script with the daemon executable.
    assert Host("local").argv() == ["/app/harness-daemon", "--python-stdin"]
    # A Python that the user sets is used as before.
    assert Host("local", python="python3").argv() == ["python3", "-"]


def test_python_stdin_runs_the_script_as_main(monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO("if __name__ == '__main__':\n    print('ran', 6 * 7)\n"))
    main(["--python-stdin"])
    assert capsys.readouterr().out == "ran 42\n"


def test_the_marked_path_ignores_other_profile_output():
    marker = frozen.PATH_MARKER
    out = f"Welcome!\nPATH=/wrong\n{marker}\nHOME=/home/me\nPATH=/opt/homebrew/bin:/usr/bin\n{marker}\n"
    assert frozen.parse_marked_path(out) == "/opt/homebrew/bin:/usr/bin"
    assert frozen.parse_marked_path("PATH=/usr/bin") is None
    assert frozen.parse_marked_path(f"{marker}\nHOME=/home/me\n{marker}") is None


def test_repair_environment_restores_the_library_path(as_frozen, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(frozen, "login_shell_path", lambda: "/home/me/.local/bin:/usr/bin")
    monkeypatch.setenv("LD_LIBRARY_PATH", "/tmp/_MEI123")
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/opt/lib")
    monkeypatch.setenv("DYLD_LIBRARY_PATH", "/tmp/_MEI123")
    monkeypatch.delenv("DYLD_LIBRARY_PATH_ORIG", raising=False)
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.setenv("XDG_CACHE_HOME", "/home/me/.cache")
    frozen.repair_environment()
    assert os.environ["PLAYWRIGHT_BROWSERS_PATH"] == os.path.join("/home/me/.cache", "ms-playwright")
    assert os.environ["LD_LIBRARY_PATH"] == "/opt/lib"
    assert "LD_LIBRARY_PATH_ORIG" not in os.environ
    assert "DYLD_LIBRARY_PATH" not in os.environ
    assert os.environ["PATH"] == "/home/me/.local/bin:/usr/bin"
    # A child process of the daemon does not repeat the repair.
    monkeypatch.setattr(frozen, "login_shell_path", lambda: pytest.fail("the repair ran two times"))
    frozen.repair_environment()


def test_a_browsers_path_of_the_user_stays(as_frozen, monkeypatch):
    monkeypatch.setattr(frozen, "login_shell_path", lambda: None)
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", "/opt/browsers")
    frozen.repair_environment()
    assert os.environ["PLAYWRIGHT_BROWSERS_PATH"] == "/opt/browsers"


def test_repair_environment_does_nothing_in_the_dev_layout(monkeypatch):
    monkeypatch.setenv("LD_LIBRARY_PATH_ORIG", "/opt/lib")
    frozen.repair_environment()
    assert os.environ["LD_LIBRARY_PATH_ORIG"] == "/opt/lib"


@pytest.mark.skipif(not SIDECAR.exists(), reason="Build the sidecar first: python scripts/build_sidecar.py")
def test_the_built_sidecar_passes_the_smoke_test():
    script = Path(__file__).resolve().parent.parent / "scripts" / "smoke_sidecar.py"
    result = subprocess.run([sys.executable, str(script), str(SIDECAR)], capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
