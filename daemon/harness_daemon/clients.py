"""The report of the client connections on stdout (``--report-connections``).

The desktop app starts a daemon for other computers (Settings > Computers). That daemon prints one
JSON line on stdout when a client connects, and one when it disconnects:

    {"event": "connection.open", "id": 1, "peer": "127.0.0.1:52144", "name": "laptop", "app": "0.1.73", "since": 1731350000000}
    {"event": "connection.close", "id": 1}

``name`` and ``app`` come from the ``client`` object of the auth message. They are null for a client
that does not send them. ``since`` is in milliseconds since 1970. The app reads the lines and shows
the connected computers.
"""

from __future__ import annotations

import itertools
import json
import sys
import time
from typing import Any

_enabled = False
_ids = itertools.count(1)

NAME_MAX = 100
APP_MAX = 40


def enable() -> None:
    """Called by main for ``--report-connections``."""
    global _enabled
    _enabled = True


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())[:limit]
    return value or None


def opened(peer: tuple[str, int] | None, client: Any) -> int | None:
    """Report a new client. Returns the id for ``closed``, or None when the report is off."""
    if not _enabled:
        return None
    info = client if isinstance(client, dict) else {}
    conn_id = next(_ids)
    _emit({
        "event": "connection.open",
        "id": conn_id,
        "peer": f"{peer[0]}:{peer[1]}" if peer else None,
        "name": _text(info.get("name"), NAME_MAX),
        "app": _text(info.get("app"), APP_MAX),
        "since": int(time.time() * 1000),
    })
    return conn_id


def closed(conn_id: int | None) -> None:
    if conn_id is not None:
        _emit({"event": "connection.close", "id": conn_id})


def _emit(event: dict[str, Any]) -> None:
    try:
        print(json.dumps(event), flush=True)
    except (OSError, ValueError):
        pass  # The app closed stdout. The daemon stops soon.
