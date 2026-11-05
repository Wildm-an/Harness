"""Tests for the agent tab of the Browser pane (PaneBrowser).

The client runs each DevTools protocol call in a WebView2 tab. Here a CDP session of a real
Chromium page takes the place of the client, so the same calls run in a real browser.
"""

from __future__ import annotations

import asyncio
import subprocess
from typing import Any

import pytest

from harness_daemon.browser import BrowserError, PaneBrowser

from test_preview import PREVIEW_APP, chromium  # noqa: F401 - the chromium fixture
from test_servers import PYTHON, free_port


@pytest.fixture
def app_url():
    port = free_port()
    proc = subprocess.Popen([PYTHON, PREVIEW_APP, str(port)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        assert proc.stdout is not None
        for _ in range(50):  # The app writes "Local:" when it is ready.
            if b"Local:" in proc.stdout.readline():
                break
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.kill()
        proc.wait()


def run_with_tab(test, allow=lambda url: "127.0.0.1" in url):
    """Run ``test(browser, page)`` with a PaneBrowser that works in a real Chromium page."""
    async def main() -> None:
        from playwright.async_api import async_playwright

        async with async_playwright() as pw:
            chrome = await pw.chromium.launch(headless=True)
            page = await chrome.new_page(viewport={"width": 1000, "height": 700})
            session = await page.context.new_cdp_session(page)
            calls: list[str] = []

            async def call(method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
                calls.append(method)
                try:
                    result = await asyncio.wait_for(session.send(method, params), timeout)
                except asyncio.TimeoutError:
                    raise BrowserError(f"The Browser pane did not answer {method} in time.") from None
                except Exception as e:  # noqa: BLE001 - the client sends the error text.
                    raise BrowserError(str(e)) from None
                return {**result, "__tab": "t1"}

            try:
                await test(PaneBrowser(call, allow), page, calls)
            finally:
                await chrome.close()
    asyncio.run(main())


def test_the_agent_works_in_the_tab(app_url, chromium):
    async def test(browser: PaneBrowser, page, calls) -> None:
        with pytest.raises(BrowserError, match="No page is open"):
            await browser.snapshot()
        info = await browser.navigate(app_url + "/")
        assert info == {"url": app_url + "/", "title": "Test app", "status": 200}
        assert page.url == app_url + "/"  # The same page: the user sees it.
        assert calls.count("Page.addScriptToEvaluateOnNewDocument") == 1

        # The console hook runs before the scripts of the page.
        errors = [e["text"] for e in await browser.console_messages() if e["level"] == "error"]
        assert errors == ["an error at load"]

        snap = await browser.snapshot()
        text = "\n".join(snap["lines"])
        assert 'button "Add one"' in text and "Secret hidden text" not in text
        add = next(line for line in snap["lines"] if 'button "Add one"' in line).split("[ref=")[1].split("]")[0]
        name = next(line for line in snap["lines"] if 'textbox "Name"' in line).split("[ref=")[1].split("]")[0]
        color = next(line for line in snap["lines"] if 'combobox "Color"' in line).split("[ref=")[1].split("]")[0]

        # A real mouse click.
        result = await browser.click(add)
        assert result == {"url": app_url + "/", "navigated": False, "blocked": [], "errors": []}
        assert await page.text_content("#count") == "Count: 1"
        assert "Input.dispatchMouseEvent" in calls

        # Typed text replaces the value.
        await browser.fill(name, "first")
        await browser.fill(name, "Ada")
        assert await page.input_value("#name") == "Ada"
        await browser.fill(name, "")
        assert await page.input_value("#name") == ""
        await browser.fill(color, "Blue")
        assert await page.input_value("#color") == "Blue"
        with pytest.raises(BrowserError, match="no option"):
            await browser.fill(color, "Green")

        # A new error after an action.
        boom = next(line for line in snap["lines"] if 'button "Break"' in line).split("[ref=")[1].split("]")[0]
        result = await browser.click(boom)
        assert any("boom from the page" in e for e in result["errors"])

        # A link to an allowed page.
        about = next(line for line in snap["lines"] if 'link "About"' in line).split("[ref=")[1].split("]")[0]
        result = await browser.click(about)
        assert result["navigated"] and result["url"] == app_url + "/about"
        assert (await browser.page_info()) == {"url": app_url + "/about", "title": "About"}
        with pytest.raises(BrowserError, match="not on the page"):
            await browser.click(add)  # A reference of the old page.

        image = await browser.screenshot()
        assert image[:2] == b"\xff\xd8"  # JPEG
        full = await browser.screenshot(full_page=True)
        assert full[:2] == b"\xff\xd8"
    run_with_tab(test)


def test_a_link_to_a_site_that_is_not_allowed_goes_back(app_url, chromium):
    async def test(browser: PaneBrowser, page, calls) -> None:
        await browser.navigate(app_url + "/")
        # The page goes to a site that the agent cannot open. The tab goes back.
        await page.evaluate("""() => {
            const a = document.createElement("a");
            a.href = "/about?x=1"; a.textContent = "Away"; a.id = "away";
            document.body.prepend(a);
        }""")
        snap = await browser.snapshot()
        away = next(line for line in snap["lines"] if 'link "Away"' in line).split("[ref=")[1].split("]")[0]
        result = await browser.click(away)
        assert result["blocked"] == [app_url + "/about?x=1"]
        assert result["url"] == app_url + "/" and not result["navigated"]
    run_with_tab(test, allow=lambda url: "/about" not in url)
