"""The agent and the user share the tabs of a session (PaneBrowser tabs, the preview_tabs tool)."""

from __future__ import annotations

import asyncio
from typing import Any

from harness_daemon.browser import PaneBrowser
from harness_daemon.tools.preview import PreviewTabsTool

TABS = [
    {"id": "t1", "url": "https://www.grainger.com/category/fasteners", "title": "Fasteners", "shown": True, "used": False},
    {"id": "t2", "url": None, "title": "", "shown": False, "used": True},
]


def _pane(calls: list[tuple[str, dict]]) -> PaneBrowser:
    async def call(method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
        calls.append((method, params))
        return {"tabs": TABS} if method == "Harness.listTabs" else {"id": params.get("id", "t3")}
    return PaneBrowser(call, lambda url: True)


def test_the_pane_lists_uses_and_opens_tabs():
    calls: list[tuple[str, dict]] = []
    pane = _pane(calls)

    async def main() -> None:
        assert await pane.tabs() == TABS
        await pane.use_tab("t1")
        assert pane.started  # The tab of the user has a page: snapshot works at once.
        await pane.use_tab("new")
    asyncio.run(main())
    assert [c[0] for c in calls] == ["Harness.listTabs", "Harness.useTab", "Harness.newTab"]
    assert calls[1][1] == {"id": "t1"}


def test_preview_tabs_shows_the_tabs_for_the_model():
    class Browser:
        used: str | None = None

        async def tabs(self):
            return TABS

        async def use_tab(self, tab: str) -> None:
            self.used = tab

    class Host:
        browser = Browser()

    tool = PreviewTabsTool()
    result = asyncio.run(tool.act(Host(), {}, None))  # type: ignore[arg-type]
    assert "- t1: Fasteners https://www.grainger.com/category/fasteners [shown]" in result.output
    assert "- t2: New tab (no page) [used]" in result.output
    result = asyncio.run(tool.act(Host(), {"use": "t1"}, None))  # type: ignore[arg-type]
    assert Host.browser.used == "t1" and result.output.startswith("Now in the tab t1.")


def test_the_agent_closes_tabs():
    calls: list[tuple[str, dict]] = []
    pane = _pane(calls)

    async def main() -> None:
        await pane.use_tab("t2")
        pane._tab = "t2"  # The agent works in t2.
        await pane.close_tab("t2")
    asyncio.run(main())
    assert calls[-1] == ("Harness.closeTab", {"id": "t2"})
    assert not pane.started and pane._tab is None  # The next call works in another tab.

    class Browser:
        closed: list[str] = []

        async def tabs(self):
            return TABS[:1]

        async def close_tab(self, tab: str) -> None:
            self.closed.append(tab)

    class Host:
        browser = Browser()

    tool = PreviewTabsTool()
    result = asyncio.run(tool.act(Host(), {"close": ["t2", "t3"]}, None))  # type: ignore[arg-type]
    assert Host.browser.closed == ["t2", "t3"] and result.output.startswith("Closed t2, t3. The tabs of this session:")
    result = asyncio.run(tool.act(Host(), {"close": "t1"}, None))  # type: ignore[arg-type]
    assert Host.browser.closed[-1] == "t1"
