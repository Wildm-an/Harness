"""The preview host of a session: the servers of launch.json and the agent browser.

The ``preview_*`` tools (tools/preview.py) use this object. The daemon makes one for each
session, and closes it when the session closes.

Rules (SPEC.md section 8.7):

- The agent browser opens the URLs of the servers in launch.json with no approval.
- Another URL needs approval. After approval, the agent browser can open the pages of
  that origin until the session closes.
- The agent works in its tab of the Browser pane of the user when the client can host it
  (``PaneRelay``). The user sees the same page, live, and can use it too.
- Else the agent uses a headless browser. It sends live ``preview.frame`` events with small
  pictures of its page, so that the client can show what the agent does.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import Any, Awaitable, Callable, Protocol
from urllib.parse import urljoin, urlsplit

from .browser import FRAME_QUALITY, AgentBrowser, BrowserError, PaneBrowser, data_url
from .servers import Server, ServerManager

log = logging.getLogger("harness.preview")

Emit = Callable[[dict[str, Any]], Awaitable[None]]

LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"}
START_TIMEOUT = 60  # Seconds for preview_start to wait for the "running" state.
LIVE_IDLE = 30  # Seconds with no agent action before the live frames of the headless browser stop.
PANE_GONE = (
    "The Browser pane of this session is not available now (the user shows another session, or the "
    "app closed). Open the page again with preview_navigate. It opens in a headless browser.")


class PaneRelay(Protocol):
    """The client that hosts the agent tab in its Browser pane (server.py)."""

    def available(self) -> bool: ...

    async def call(self, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]: ...


class SessionBrowser:
    """The browser of the agent: its tab of the Browser pane when the client can host it, else a
    headless browser. Each preview_navigate chooses again. The other actions use the browser of
    the last page."""

    def __init__(self, host: "PreviewHost", relay: PaneRelay | None):
        self.host = host
        self.relay = relay
        self.headless = AgentBrowser(host.allowed)
        self.pane = PaneBrowser(self._pane_call, host.allowed) if relay is not None else None
        self.current: AgentBrowser | PaneBrowser = self.headless

    @property
    def in_pane(self) -> bool:
        return self.current is self.pane

    async def _pane_call(self, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
        if self.relay is None or not self.relay.available():
            raise BrowserError(PANE_GONE)
        return await self.relay.call(method, params, timeout)

    def _active(self) -> AgentBrowser | PaneBrowser:
        if self.current is self.pane and (self.relay is None or not self.relay.available()):
            raise BrowserError(PANE_GONE)
        return self.current

    async def navigate(self, url: str) -> dict[str, Any]:
        if self.pane is not None and self.relay is not None and self.relay.available():
            self.current = self.pane
        else:
            self.current = self.headless
        self.host.touch()
        return await self.current.navigate(url)

    async def snapshot(self) -> dict[str, Any]:
        return await self._active().snapshot()

    async def click(self, ref: str) -> dict[str, Any]:
        self.host.touch()
        return await self._active().click(ref)

    async def fill(self, ref: str, text: str, submit: bool = False) -> dict[str, Any]:
        self.host.touch()
        return await self._active().fill(ref, text, submit)

    async def console_messages(self) -> list[dict[str, Any]]:
        return await self._active().console_messages()

    async def screenshot(self, full_page: bool = False, quality: int = 70) -> bytes:
        return await self._active().screenshot(full_page=full_page, quality=quality)

    async def page_info(self) -> dict[str, Any] | None:
        if self.current is self.pane and (self.relay is None or not self.relay.available()):
            return None
        return await self.current.page_info()

    async def close(self) -> None:
        if self.pane is not None:
            await self.pane.close()
        await self.headless.close()

    def close_now(self) -> None:
        self.headless.close_now()


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def _default_port(scheme: str) -> int | None:
    return {"http": 80, "https": 443}.get(scheme)


class PreviewHost:
    def __init__(self, servers: ServerManager, emit: Emit, relay: PaneRelay | None = None):
        self.servers = servers
        self.emit = emit
        self.approved: set[str] = set()  # Origins that the user approved in this session.
        self.browser = SessionBrowser(self, relay)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._live_until = 0.0  # The live frames of the headless browser stop at this time (monotonic).
        self._live_task: asyncio.Task | None = None

    # -- URLs --------------------------------------------------------------------------

    def server_ports(self) -> set[int]:
        ports: set[int] = set()
        for server in list(self.servers.servers.values()):
            for port in (server.port, server.config.port):
                if port:
                    ports.add(port)
        return ports

    def is_server_url(self, url: str) -> bool:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or (parts.hostname or "").lower() not in LOCAL_HOSTS:
            return False
        try:
            port = parts.port or _default_port(parts.scheme)
        except ValueError:
            return False
        return port in self.server_ports()

    def allowed(self, url: str) -> bool:
        """True if the agent browser can open the URL with no approval. Runs in the browser thread too."""
        if self.is_server_url(url):
            return True
        return urlsplit(url).scheme in ("http", "https") and origin_of(url) in self.approved

    def approve(self, url: str) -> None:
        self.approved.add(origin_of(url))

    def server_url(self, server: Server) -> str | None:
        if server.url:
            return server.url
        port = server.port or server.config.port
        return f"http://localhost:{port}/" if port else None

    async def resolve_url(self, url: str | None, server_name: str | None) -> str:
        """The full URL for preview_navigate.

        - A full URL stays the same.
        - A path (for example "/about") goes on the URL of ``server_name``, of the current
          page, or of the running server.
        """
        url = (url or "").strip()
        if url.lower().startswith(("http://", "https://", "about:", "data:")):
            return url
        if url and "://" in url:
            raise BrowserError(f"The agent browser opens only http and https URLs, not {url}.")
        if url and not url.startswith("/") and "." in url.split("/")[0]:
            raise BrowserError(f"Give a full URL with http:// or https://, not {url}.")
        base: str | None = None
        if server_name:
            self.servers.reload()
            server = self.servers.servers.get(server_name)
            if server is None:
                raise BrowserError(f"Unknown server: {server_name}. The servers are: {self.server_names()}.")
            if server.state != "running":
                raise BrowserError(f"The server {server_name} is {server.state}. Start it with preview_start.")
            base = self.server_url(server)
        if base is None:
            page = await self.browser.page_info()
            if page and page["url"].startswith("http"):
                base = page["url"]
        if base is None:
            running = [s for s in self.servers.servers.values() if s.state == "running"]
            default = self.servers.default()
            server = default if default in running else (running[0] if running else None)
            if server is None:
                raise BrowserError("No server is running. Start one with preview_start, or give a full URL.")
            base = self.server_url(server)
        if base is None:
            raise BrowserError("The server has no port. Give a full URL.")
        return urljoin(base, url or "/")

    def server_names(self) -> str:
        return ", ".join(self.servers.servers) or "none (there is no .harness/launch.json)"

    # -- servers ---------------------------------------------------------------------------

    def find_server(self, name: str | None) -> Server:
        exists = self.servers.reload()
        if self.servers.config_error:
            raise BrowserError(f".harness/launch.json has an error: {self.servers.config_error}")
        if not exists or not self.servers.servers:
            raise BrowserError(
                "There is no server configuration. Create .harness/launch.json with the write tool, "
                'for example {"servers": [{"name": "web", "command": "npm run dev", "port": 5173, '
                '"ready_pattern": "Local:.*http", "default": true}]}. Or ask the user to add a server from an empty tab of the Browser pane.')
        if not name:
            server = self.servers.default()
            assert server is not None
            return server
        server = self.servers.servers.get(name)
        if server is None:
            raise BrowserError(f"Unknown server: {name}. The servers are: {self.server_names()}.")
        return server

    async def wait_started(self, server: Server, timeout: float = START_TIMEOUT) -> None:
        """Wait until the server leaves the "starting" state, or until the timeout."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while server.state == "starting" and loop.time() < deadline:
            await asyncio.sleep(0.1)

    # -- the Browser pane --------------------------------------------------------------------

    def touch(self) -> None:
        """An agent action: the headless browser sends live frames until LIVE_IDLE seconds after it."""
        self._live_until = time.monotonic() + LIVE_IDLE
        if self._live_task is None or self._live_task.done():
            self._loop = asyncio.get_running_loop()
            self._live_task = asyncio.create_task(self._live())

    async def _live(self) -> None:
        browser = self.browser.headless
        loop = asyncio.get_running_loop()

        def on_frame(url: str, image: bytes) -> None:  # The browser thread.
            if self.browser.in_pane:
                return
            event = {"type": "preview.frame", "url": url, "title": "", "action": "live", "image": data_url(image)}
            asyncio.run_coroutine_threadsafe(self.emit(event), loop)

        try:
            await browser.set_live(on_frame)
            while time.monotonic() < self._live_until:
                await asyncio.sleep(1)
        except Exception as e:  # noqa: BLE001 - the frames are only for the user.
            log.debug("The live frames stopped: %s", e)
        finally:
            try:
                await browser.set_live(None)
            except Exception:  # noqa: BLE001
                pass

    async def send_frame(self, action: str) -> None:
        """Send a small screenshot of the headless page after an action. The pane shows its own tab live."""
        if self.browser.in_pane:
            return
        try:
            info = await self.browser.page_info()
            if info is None:
                return
            image = await self.browser.screenshot(quality=FRAME_QUALITY)
        except Exception as e:  # noqa: BLE001 - the frame is only for the user.
            log.debug("No frame: %s", e)
            return
        await self.emit({"type": "preview.frame", "url": info["url"], "title": info["title"],
                         "action": action, "image": data_url(image)})

    async def close(self) -> None:
        if self._live_task is not None:
            self._live_task.cancel()
        await self.browser.close()

    def close_now(self) -> None:
        self.browser.close_now()
