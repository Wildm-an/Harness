"""The packaged daemon: a PyInstaller executable (SPEC.md section 10, phase 13).

A frozen daemon has no ``python`` command. These functions replace the parts of the daemon
that use ``sys.executable`` as a Python interpreter, and they repair the environment that
the operating system gives to a desktop app.
"""

from __future__ import annotations

import os
import subprocess
import sys

PYTHON_STDIN_FLAG = "--python-stdin"
REPAIRED_ENV = "HARNESS_ENV_REPAIRED"  # The child processes of a repaired daemon do not repeat the repair.
PATH_MARKER = "__HARNESS_PATH__"
SHELL_TIMEOUT = 5


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def python_stdin_argv() -> list[str]:
    """The command that runs a Python script from stdin with the Python of this daemon."""
    if is_frozen():
        return [sys.executable, PYTHON_STDIN_FLAG]
    return [sys.executable, "-"]


def run_python_stdin() -> None:
    """Run the Python script on stdin, as ``python -`` does. The frozen daemon uses this."""
    source = sys.stdin.read()
    sys.argv = ["-"]
    exec(compile(source, "<stdin>", "exec"), {"__name__": "__main__", "__builtins__": __builtins__})


def install_browser_argv() -> list[str]:
    """The command that installs Chromium for Playwright."""
    if is_frozen():
        return [sys.executable, "--install-browser"]
    return [sys.executable, "-m", "playwright", "install", "chromium"]


def install_browser() -> int:
    """Install Chromium for Playwright with the Playwright driver in the bundle. Return the exit code."""
    from playwright._impl._driver import compute_driver_executable, get_driver_env

    node, cli = compute_driver_executable()
    return subprocess.call([node, cli, "install", "chromium"], env=get_driver_env())


def repair_environment() -> None:
    """Repair the environment of a frozen daemon. Call this one time, at the start."""
    if not is_frozen() or os.environ.get(REPAIRED_ENV):
        return
    os.environ[REPAIRED_ENV] = "1"
    # The PyInstaller bootloader changes LD_LIBRARY_PATH for the daemon. The child processes
    # (bash, servers, llama-server) must get the original value.
    for name in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
        original = os.environ.pop(f"{name}_ORIG", None)
        if original is not None:
            os.environ[name] = original
        elif name in os.environ and sys.platform != "win32":
            del os.environ[name]
    # A frozen Playwright looks for Chromium in the bundle (PLAYWRIGHT_BROWSERS_PATH=0). The bundle
    # has no Chromium, and the installer replaces the bundle folder at each update. Use the cache
    # of the user, the same folder as "python -m playwright install".
    os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", playwright_cache())
    if sys.platform in ("darwin", "linux"):
        path = login_shell_path()
        if path:
            os.environ["PATH"] = path


def playwright_cache() -> str:
    """The default browser folder of Playwright on this operating system."""
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    elif sys.platform == "darwin":
        base = os.path.join(home, "Library", "Caches")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.join(home, ".cache")
    return os.path.join(base, "ms-playwright")


def login_shell_path() -> str | None:
    """The PATH of the login shell of the user.

    A desktop app on macOS gets only the system PATH, so the tools of Homebrew, nvm, and
    others are not found. The login shell reads the profile files of the user.
    """
    shell = os.environ.get("SHELL") or "/bin/sh"
    # env prints PATH with ":" in all shells. fish keeps $PATH as a list.
    command = f"echo {PATH_MARKER}; env; echo {PATH_MARKER}"
    try:
        out = subprocess.run([shell, "-l", "-i", "-c", command], capture_output=True, text=True,
                             timeout=SHELL_TIMEOUT, stdin=subprocess.DEVNULL).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_marked_path(out)


def parse_marked_path(output: str) -> str | None:
    """The PATH line of the env output between the two markers. A profile file can print other text."""
    parts = output.split(PATH_MARKER)
    if len(parts) < 3:
        return None
    for line in parts[1].splitlines():
        if line.startswith("PATH=") and line[5:].strip():
            return line[5:]
    return None
