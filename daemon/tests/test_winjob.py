"""A local llama-server must not keep the files of the daemon folder open after the daemon stops.

- winjob.py: the processes in the job of the daemon stop when the daemon process ends, also when
  it is killed. This includes a detached child process, as hostscript.py starts llama-server.
- hostscript.py: llama-server does not get the DLL folder of a packaged daemon.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from harness_daemon.cookbook import hostscript

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows Job Objects and DLL folders")

DAEMON_DIR = Path(__file__).resolve().parents[1]
NO_WINDOW = 0x08000000

# The host script: it starts a detached process (as llama-server), writes its pid, and ends.
HOST_SCRIPT = textwrap.dedent("""
    import subprocess, sys
    flags = subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000008 | 0x08000000  # DETACHED, NO_WINDOW
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], creationflags=flags,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(p.pid)
""")

# The daemon: it starts the host script as hosts.start_script does, and then waits until it is killed.
DAEMON_SCRIPT = textwrap.dedent("""
    import subprocess, sys, time
    from harness_daemon import winjob
    script = subprocess.Popen([sys.executable, "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              creationflags=0x08000000)
    in_job = winjob.stop_with_daemon(script)
    out, _ = script.communicate({host_script!r}.encode())
    print(in_job, out.decode().strip(), flush=True)
    time.sleep(120)
""")


def alive(pid: int) -> bool:
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32")
    kernel32.OpenProcess.restype = ctypes.c_void_p
    handle = kernel32.OpenProcess(0x00100000 | 0x1000, False, pid)  # SYNCHRONIZE, QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(ctypes.c_void_p(handle), 0) == 0x102  # WAIT_TIMEOUT: it runs.
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(handle))


def wait_until(check, timeout: float = 15) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if check():
            return True
        time.sleep(0.1)
    return check()


def test_killed_daemon_stops_the_detached_server():
    env = {**os.environ, "PYTHONPATH": str(DAEMON_DIR)}
    daemon = subprocess.Popen([sys.executable, "-c", DAEMON_SCRIPT.format(host_script=HOST_SCRIPT)],
                              stdout=subprocess.PIPE, env=env, creationflags=NO_WINDOW)
    server = 0
    try:
        in_job, pid = daemon.stdout.readline().decode().split()
        server = int(pid)
        assert in_job == "True"
        assert alive(server), "The detached server did not start."
        daemon.kill()  # TerminateProcess, as the app stops the daemon.
        daemon.wait(10)
        assert wait_until(lambda: not alive(server)), "The server continued after the daemon stopped."
    finally:
        if daemon.poll() is None:
            daemon.kill()
        if server and alive(server):
            subprocess.run(["taskkill", "/PID", str(server), "/T", "/F"], capture_output=True)


def test_stop_with_daemon_ignores_an_ended_process():
    from harness_daemon import winjob

    proc = subprocess.Popen([sys.executable, "-c", "pass"], creationflags=NO_WINDOW)
    proc.wait(10)
    assert winjob.stop_with_daemon(proc) is False


# The parent sets a DLL folder, as the PyInstaller bootloader does. A child process that loads a DLL
# from that folder shows if it got the folder.
DLL_SCRIPT = textwrap.dedent("""
    import ctypes, subprocess, sys
    sys.path.insert(0, {hostscript_dir!r})
    import hostscript
    ctypes.WinDLL("kernel32").SetDllDirectoryW({dll_dir!r})
    child = [sys.executable, "-c", "import ctypes; ctypes.WinDLL('harness_probe.dll', winmode=0)"]
    before = subprocess.run(child, capture_output=True).returncode
    cleared = hostscript.clear_inherited_dll_directory()
    after = subprocess.run(child, capture_output=True).returncode
    print(before, cleared, after)
""")


def test_llama_server_does_not_get_the_daemon_dll_folder(tmp_path):
    system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    if not (system / "vcruntime140.dll").is_file() or not (system / "vcruntime140_1.dll").is_file():
        pytest.skip("Windows has no Visual C++ runtime: the DLL folder stays.")
    dll_dir = tmp_path / "_internal"
    dll_dir.mkdir()
    shutil.copy(system / "vcruntime140.dll", dll_dir / "harness_probe.dll")
    script = DLL_SCRIPT.format(hostscript_dir=str(Path(hostscript.__file__).parent), dll_dir=str(dll_dir))
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, cwd=tmp_path,
                         timeout=60, creationflags=NO_WINDOW)
    assert out.returncode == 0, out.stderr
    before, cleared, after = out.stdout.split()
    assert before == "0", "A child process did not get the DLL folder: the test does not show the problem."
    assert cleared == "True"
    assert after != "0", "llama-server can still load DLL files from the daemon folder."


def test_clear_dll_directory_without_a_folder():
    # The test process has no DLL folder: nothing changes.
    assert hostscript.clear_inherited_dll_directory() is False


def test_start_drops_the_local_servers_that_stopped(tmp_path, monkeypatch):
    """A local server stopped with the previous daemon. The next start removes its state and provider."""
    import asyncio
    import json

    from harness_daemon.cookbook.service import Cookbook

    home = tmp_path / "home"
    serves = home / ".harness" / "cookbook" / "serves"
    serves.mkdir(parents=True)
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    ended = subprocess.Popen([sys.executable, "-c", "pass"], creationflags=NO_WINDOW)
    ended.wait(10)
    for name, port, pid in (("stopped", 8099, ended.pid), ("running", 8100, os.getpid())):
        (serves / f"{name}.json").write_text(json.dumps({"name": name, "port": port, "pid": pid}))
    providers = {"other": {"base_url": "http://127.0.0.1:1/v1"},
                 "local-llama-8099": {"base_url": "http://127.0.0.1:8099/v1", "cookbook": True},
                 "local-llama-8100": {"base_url": "http://127.0.0.1:8100/v1", "cookbook": True}}

    # A daemon with another HARNESS_HOME (a test daemon) does not change the serve folder.
    monkeypatch.setenv("HARNESS_HOME", str(tmp_path / "other-home"))
    assert asyncio.run(Cookbook().drop_stopped_local_serves()) == []
    assert (serves / "stopped.json").exists()

    monkeypatch.setenv("HARNESS_HOME", str(home / ".harness"))
    (home / ".harness" / "providers.json").write_text(json.dumps(providers))
    assert asyncio.run(Cookbook().drop_stopped_local_serves()) == ["stopped"]
    assert sorted(p.name for p in serves.glob("*.json")) == ["running.json"]
    left = json.loads((home / ".harness" / "providers.json").read_text())
    assert sorted(left) == ["local-llama-8100", "other"]
