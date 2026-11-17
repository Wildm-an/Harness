"""The icons of the agents (Settings > Agents and the agent picker), from the ACP registry.

Each agent of the ACP registry has an ``icon``: a small SVG in one color (``currentColor``) that the agent
gives for ACP clients (Zed and T3 Code show the same icons). Harness does not ship these icons. The daemon
downloads the icon of each agent from the registry address and keeps it in ``~/.harness/harnesses/icons``.
The client gets it as a ``data:`` URL (an ``<img>`` or a CSS mask), so the SVG runs no code. A logo with a brand
color (``BRAND_COLORS``) shows in that color. A one-color logo with no brand color keeps ``currentColor``: the client
shows it in the text color of the theme, with no tile (the user asked for no white background, as T3 Code shows the
registry icons). A logo in full color shows as it is.

An agent that is not in the registry can have an icon that Harness ships (``agent_icons/<id>.svg``, for example
Hermes Agent). An icon that is not safe or too large is not kept: the client shows the initials of the agent.
"""

from __future__ import annotations

import base64
import logging
import re
from pathlib import Path
from urllib.parse import urlparse

from . import acp_install
from .config import harness_home

log = logging.getLogger("harness.acp_icons")

MAX_BYTES = 64 * 1024
_UNSAFE = re.compile(rb"<script|<foreignobject|\son[a-z]+\s*=|javascript:|<iframe|<object|<embed", re.IGNORECASE)
_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,80}$")

_cache: dict[str, str | None] = {}  # id -> data URL, or None for no icon. Cleared after a download.
_failed: set[str] = set()  # The downloads that failed in this daemon run: no new try until a restart.


def _folder() -> Path:
    return harness_home() / "harnesses" / "icons"


# The icons that Harness ships, for the agents that are not in the ACP registry (acp_harnesses.py). Each one is
# the official logo of the agent, with its source and license in THIRD_PARTY_LICENSES.md.
BUNDLED = Path(__file__).resolve().parent / "agent_icons"

# The brand color of a logo that is one color (``currentColor``). An agent that is not here keeps ``currentColor``,
# and the client shows its logo in the text color of the theme.
BRAND_COLORS = {
    "claude-acp": "#D97757",  # The Claude orange of Anthropic.
}


def safe_svg(data: bytes) -> bool:
    """True for a small SVG with no scripts, no event attributes, and no embedded documents."""
    head = data[:512].lstrip().lower()
    return (len(data) <= MAX_BYTES and (head.startswith(b"<svg") or head.startswith(b"<?xml"))
            and b"<svg" in data[:2048].lower() and not _UNSAFE.search(data))


def icon(harness_id: str) -> str | None:
    """The kept icon of an agent as a data URL, or None."""
    if harness_id in _cache:
        return _cache[harness_id]
    value = None
    if _ID.match(harness_id):
        for path in (_folder() / f"{harness_id}.svg", BUNDLED / f"{harness_id}.svg"):
            try:
                data = path.read_bytes()
            except OSError:
                continue
            if safe_svg(data):
                color = BRAND_COLORS.get(harness_id)
                if color:
                    data = data.replace(b"currentColor", color.encode("ascii"))
                value = "data:image/svg+xml;base64," + base64.b64encode(data).decode("ascii")
                break
    _cache[harness_id] = value
    return value


def missing(ids: list[str]) -> list[str]:
    """The agents of the registry that have an icon address, but no kept icon."""
    agents = acp_install.registry()
    return [i for i in ids if i in agents and isinstance(agents[i].get("icon"), str) and i not in _failed
            and _ID.match(i) and icon(i) is None]


async def download(ids: list[str]) -> bool:
    """Download the icons of the agents. True when one or more icons are new."""
    from .nethttp import async_client

    agents = acp_install.registry()
    new = False
    try:
        async with async_client(timeout=15, follow_redirects=True) as client:
            for harness_id in ids:
                url = agents.get(harness_id, {}).get("icon")
                if not isinstance(url, str) or urlparse(url).scheme != "https":
                    _failed.add(harness_id)
                    continue
                try:
                    response = await client.get(url)
                    response.raise_for_status()
                    data = response.content
                except Exception as e:  # noqa: BLE001 - no network: the initials show.
                    log.info("Could not download the icon of %s: %s", harness_id, e)
                    _failed.add(harness_id)
                    continue
                if not safe_svg(data):
                    log.info("The icon of %s is not a safe SVG: not kept", harness_id)
                    _failed.add(harness_id)
                    continue
                _folder().mkdir(parents=True, exist_ok=True)
                (_folder() / f"{harness_id}.svg").write_bytes(data)
                _cache.pop(harness_id, None)
                new = True
    except OSError as e:
        log.info("Could not keep the agent icons: %s", e)
    return new
