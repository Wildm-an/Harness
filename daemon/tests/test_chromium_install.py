"""The download of Chromium on the first use of the agent browser (browser.ChromiumInstall)."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from harness_daemon.browser import AgentBrowser, BrowserError, ChromiumInstall


def script(tmp_path: Path, body: str) -> list[str]:
    path = tmp_path / "install.py"
    path.write_text(body, encoding="utf-8")
    return [sys.executable, str(path)]


def test_the_first_request_starts_one_download(tmp_path):
    gate = tmp_path / "go"
    argv = script(tmp_path, f"import pathlib, time\nwhile not pathlib.Path({str(gate)!r}).exists(): time.sleep(0.05)\n")
    install = ChromiumInstall(lambda: argv)
    assert "started the download now" in install.request()
    assert install.running
    # A second request (for example, from another session) does not start a second download.
    assert "downloads Chromium for Playwright now" in install.request()
    gate.write_text("", encoding="utf-8")
    install.wait(30)
    assert install.installed and not install.running
    # Playwright still does not find Chromium: report it, and do not download again.
    message = install.request()
    assert "does not find it" in message and "Install it with:" in message
    assert not install.running


def test_a_failed_download_is_reported_one_time(tmp_path):
    argv = script(tmp_path, "print('Error: getaddrinfo ENOTFOUND cdn.playwright.dev')\nraise SystemExit(3)\n")
    install = ChromiumInstall(lambda: argv)
    install.request()
    install.wait(30)
    assert not install.installed
    message = install.request()
    assert "failed: exit code 3" in message and "ENOTFOUND" in message
    assert "install it by hand with:" in message
    # The next request starts the download again.
    assert "started the download now" in install.request()
    install.wait(30)


def test_a_missing_installer_is_a_failure(tmp_path):
    install = ChromiumInstall(lambda: [str(tmp_path / "no-such-program")])
    install.request()
    install.wait(30)
    assert "failed" in install.request()


def test_a_missing_revision_starts_the_download(monkeypatch):
    """The launch error of Playwright for a missing revision goes to the agent as the download status."""
    async_api = pytest.importorskip("playwright.async_api")

    class Chromium:
        async def launch(self, **kwargs):
            raise Exception("BrowserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium-1254\\chrome.exe")

    class Playwright:
        chromium = Chromium()

        async def stop(self):
            pass

    class Starter:
        async def start(self):
            return Playwright()

    monkeypatch.setattr(async_api, "async_playwright", lambda: Starter())

    class Install(ChromiumInstall):
        requests = 0

        def request(self) -> str:
            Install.requests += 1
            return "STATUS"

    browser = AgentBrowser(lambda url: True, chromium=Install())

    async def run() -> None:
        try:
            with pytest.raises(BrowserError, match="^STATUS$"):
                await browser.navigate("about:blank")
        finally:
            await browser.close()

    asyncio.run(run())
    assert Install.requests == 1
