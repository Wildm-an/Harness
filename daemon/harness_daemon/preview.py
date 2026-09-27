"""The preview host of a session: the servers of launch.json and the agent browser.

The ``preview_*`` tools (tools/preview.py) use this object. The daemon makes one for each
session, and closes it when the session closes.

Rules (SPEC.md section 8.7):

- The agent browser opens the URLs of the servers in launch.json with no approval.
- Another URL needs approval. After approval, the agent browser can open the pages of
  that origin until the session closes.
- After each action, the host sends a ``preview.frame`` event with a small screenshot, so
  that the Browser pane of the client can show the agent browser page.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable
from urllib.parse import urljoin, urlsplit

from .browser import FRAME_QUALITY, AgentBrowser, BrowserError, data_url
from .servers import Server, ServerManager

log = logging.getLogger("harness.preview")

Emit = Callable[[dict[str, Any]], Awaitable[None]]

LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"}
START_TIMEOUT = 60  # Seconds for preview_start to wait for the "running" state.


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def _default_port(scheme: str) -> int | None:
    return {"http": 80, "https": 443}.get(scheme)


class PreviewHost:
    def __init__(self, servers: ServerManager, emit: Emit):
        self.servers = servers
        self.emit = emit
        self.browser = AgentBrowser(self.allowed)
        self.approved: set[str] = set()  # Origins that the user approved in this session.

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
                '"ready_pattern": "Local:.*http", "default": true}]}. Or ask the user to open the Servers pane.')
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

    async def send_frame(self, action: str) -> None:
        """Send a small screenshot of the agent browser page to the client."""
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
        await self.browser.close()

    def close_now(self) -> None:
        self.browser.close_now()
