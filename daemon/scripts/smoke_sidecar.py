"""Smoke test for a built daemon sidecar (the PyInstaller executable).

    python scripts/smoke_sidecar.py build/sidecar/dist/harness-daemon.exe

The test starts the executable as the desktop client does, and checks:

1. The ready line, and the time to it.
2. The auth step and a Cookbook hardware request (the host script runs with --python-stdin).
3. The Playwright driver in the bundle, and a Chromium start if Chromium is installed.
4. The stop when stdin closes.

The daemon uses a temporary HARNESS_HOME, so the test does not change ~/.harness.
Exit code 0 means that all checks passed.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time

import websockets

READY_TIMEOUT = 60
REPLY_TIMEOUT = 60
STOP_TIMEOUT = 10

DRIVER_CHECK = """
import os
from playwright._impl._driver import compute_driver_executable
node, cli = compute_driver_executable()
print("driver", os.path.exists(node) and os.path.exists(cli))
import asyncio
from playwright.async_api import async_playwright  # The daemon uses the async API only.

async def launch():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        await browser.close()

try:
    asyncio.run(launch())
    print("chromium ok")
except Exception as e:
    print("chromium missing" if "Executable doesn't exist" in str(e) else f"chromium error {e}")
"""


def check(ok: bool, what: str) -> None:
    print(("PASS " if ok else "FAIL ") + what, flush=True)
    if not ok:
        sys.exit(1)


async def talk(port: int, token: str) -> None:
    async with websockets.connect(f"ws://127.0.0.1:{port}/ws", max_size=None) as ws:
        await ws.send(json.dumps({"type": "auth", "token": token}))
        first = json.loads(await asyncio.wait_for(ws.recv(), REPLY_TIMEOUT))
        check(first.get("type") == "auth.ok", f"auth ({first.get('type')}, version {first.get('version')})")
        await ws.send(json.dumps({"type": "cookbook.hardware", "refresh": True}))
        deadline = time.monotonic() + REPLY_TIMEOUT
        while True:
            left = deadline - time.monotonic()
            check(left > 0, "a reply to cookbook.hardware")
            msg = json.loads(await asyncio.wait_for(ws.recv(), left))
            if msg.get("type") == "hardware":
                info = msg.get("info") or {}
                check(bool(info), f"hardware detection with --python-stdin ({len(info)} fields)")
                return
            if msg.get("type") == "error":
                check(False, f"hardware detection: {msg.get('message')}")


def run_script(exe: str, env: dict[str, str], source: str) -> str:
    result = subprocess.run([exe, "--python-stdin"], input=source, capture_output=True, text=True,
                            env=env, timeout=REPLY_TIMEOUT)
    return result.stdout + result.stderr


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    exe = os.path.abspath(sys.argv[1])
    check(os.path.isfile(exe), f"the executable exists: {exe}")
    token = secrets.token_hex(32)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as home:
        env = {**os.environ, "HARNESS_TOKEN": token, "HARNESS_HOME": home}
        version = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=REPLY_TIMEOUT)
        check(version.stdout.startswith("harness-daemon "), f"--version ({version.stdout.strip()})")

        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        start = time.monotonic()
        proc = subprocess.Popen([exe, "--host", "127.0.0.1", "--port", "0", "--exit-on-stdin-eof"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, creationflags=flags)
        try:
            line = proc.stdout.readline().decode("utf-8", errors="replace")
            ready = json.loads(line) if line.strip() else {}
            check(ready.get("event") == "ready", f"ready line in {time.monotonic() - start:.1f} s")
            check("token" not in ready, "the ready line has no token (the token came from HARNESS_TOKEN)")
            asyncio.run(talk(int(ready["port"]), token))

            out = run_script(exe, env, DRIVER_CHECK)
            check("driver True" in out, "the Playwright driver is in the bundle")
            if "chromium ok" in out:
                print("PASS Chromium starts")
            elif "chromium missing" in out:
                print("SKIP Chromium is not installed (harness-daemon --install-browser)")
            else:
                check(False, f"Chromium start: {out.strip()}")

            proc.stdin.close()
            try:
                proc.wait(STOP_TIMEOUT)
                check(True, f"stop on stdin EOF (exit code {proc.returncode})")
            except subprocess.TimeoutExpired:
                check(False, f"stop on stdin EOF in {STOP_TIMEOUT} s")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    main()
