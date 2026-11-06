"""The HTTP clients of the daemon share one SSL context.

A new httpx client loads the CA certificates into a new SSL context. On Windows that takes about
300 ms, and it blocks the event loop: a session open, the model checks, and the events of all
sessions wait for it. The daemon makes the context one time (in a thread at the start) and gives it
to each client.
"""

from __future__ import annotations

import ssl
import threading
from typing import Any

import httpx

_lock = threading.Lock()
_context: ssl.SSLContext | None = None


def ssl_context() -> ssl.SSLContext:
    """The shared SSL context with the default CA certificates of httpx."""
    global _context
    if _context is None:
        with _lock:
            if _context is None:
                _context = httpx.create_ssl_context()
    return _context


def warm_up() -> None:
    """Make the SSL context and import the model client in a thread, so that the first request does not wait.

    The import of openai takes about 1 second. In the event loop, it stops the daemon for that time.
    """
    threading.Thread(target=ssl_context, name="ssl-context", daemon=True).start()
    threading.Thread(target=_import_model_client, name="import-openai", daemon=True).start()


def _import_model_client() -> None:
    try:
        import openai  # noqa: F401
    except Exception:  # The first model request reports the error.
        pass


def async_client(**kwargs: Any) -> httpx.AsyncClient:
    """An httpx.AsyncClient with the shared SSL context. ``verify`` in kwargs replaces it."""
    kwargs.setdefault("verify", ssl_context())
    return httpx.AsyncClient(**kwargs)
