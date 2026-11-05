"""OAuth for the HTTP and SSE MCP servers (SPEC.md section 5.7), as the MCP authorization specification describes.

The flow is OAuth 2.1 with PKCE. The MCP SDK (``mcp.client.auth``) finds the authorization server,
registers the client (dynamic client registration), and refreshes the tokens. This module gives it:

- The token store: ``~/.harness/mcp-auth.json``. One record for each server name and URL. A record has
  the tokens, the client registration, and the callback port.
- The callback listener: a small HTTP server on ``127.0.0.1:<port>`` of the daemon host. The browser
  goes to ``http://127.0.0.1:<port>/callback`` after the sign-in.
- The paste fallback: when the browser is on another computer (a remote daemon), the user pastes the
  URL of the failed callback page. ``Callback.resolve`` reads the code from it.

A connection at the start of a session never opens a browser. When the server needs a sign-in, the
redirect handler raises ``AuthRequired`` and the server state is "needs_auth". The user then clicks
"Authenticate" (message ``mcp.auth``), and the manager connects again with an interactive flow.

The ``oauth`` key of a server in ``mcp.json``:

- missing or ``true``: OAuth is on, if the headers have no ``Authorization``.
- ``false``: OAuth is off.
- an object: ``client_id`` and ``client_secret`` for a server with no dynamic client registration
  (for example GitHub), ``scopes``, and ``callback_port`` (a fixed port for the redirect URI).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import threading
from dataclasses import dataclass, field
from html import escape
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .config import ConfigError, harness_home

log = logging.getLogger("harness.mcp")

AUTH_TIMEOUT = 300  # Seconds for the user to sign in.
CALLBACK_PATH = "/callback"
_STORE_LOCK = threading.Lock()


@dataclass
class OAuthConfig:
    client_id: str | None = None
    client_secret: str | None = None
    scopes: list[str] = field(default_factory=list)
    callback_port: int | None = None


class AuthRequired(Exception):
    """The server needs a sign-in, and this connection must not open a browser."""


class AuthCancelled(Exception):
    """The user cancelled the sign-in."""


def parse_oauth(name: str, raw: Any, headers: dict[str, str], expand) -> OAuthConfig | None:
    """The ``oauth`` key of a server entry. ``expand`` replaces ``${VAR}`` in a string."""
    has_header = any(k.lower() == "authorization" for k in headers)
    if raw is None or raw is True:
        return None if has_header else OAuthConfig()
    if raw is False:
        return None
    if not isinstance(raw, dict):
        raise ConfigError(f"MCP server {name}: 'oauth' must be true, false, or an object.")
    if has_header:
        raise ConfigError(f"MCP server {name}: use 'oauth' or an Authorization header, not both.")
    config = OAuthConfig()
    for key in ("client_id", "client_secret"):
        value = raw.get(key)
        if value is not None:
            if not isinstance(value, str) or not value.strip():
                raise ConfigError(f"MCP server {name}: 'oauth.{key}' must be a string.")
            setattr(config, key, expand(value.strip()))
    if config.client_secret and not config.client_id:
        raise ConfigError(f"MCP server {name}: 'oauth.client_secret' needs 'oauth.client_id'.")
    scopes = raw.get("scopes", [])
    if isinstance(scopes, str):
        scopes = scopes.split()
    if not isinstance(scopes, list) or not all(isinstance(s, str) for s in scopes):
        raise ConfigError(f"MCP server {name}: 'oauth.scopes' must be a list of strings.")
    config.scopes = [s for s in scopes if s.strip()]
    port = raw.get("callback_port")
    if port is not None:
        if not isinstance(port, int) or isinstance(port, bool) or not 1024 <= port <= 65535:
            raise ConfigError(f"MCP server {name}: 'oauth.callback_port' must be a port from 1024 to 65535.")
        config.callback_port = port
    return config


# -- the token store ------------------------------------------------------------------------------------


def store_path() -> Path:
    return harness_home() / "mcp-auth.json"


def record_key(name: str, url: str) -> str:
    return f"{name} {url}"


def _read_store() -> dict[str, Any]:
    try:
        data = json.loads(store_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_store(data: dict[str, Any]) -> None:
    path = store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    # Only the user can read the file. On Windows, the profile folder already gives that.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2) + "\n")
    os.replace(tmp, path)


def read_record(key: str) -> dict[str, Any]:
    with _STORE_LOCK:
        record = _read_store().get(key)
    return record if isinstance(record, dict) else {}


def update_record(key: str, **values: Any) -> None:
    """Set or remove (value None) the fields of a record."""
    with _STORE_LOCK:
        data = _read_store()
        record = data.get(key) if isinstance(data.get(key), dict) else {}
        for k, v in values.items():
            if v is None:
                record.pop(k, None)
            else:
                record[k] = v
        data[key] = record
        _write_store(data)


def clear_record(key: str) -> bool:
    """Remove the tokens and the registration of a server. True if there was a record."""
    with _STORE_LOCK:
        data = _read_store()
        if key not in data:
            return False
        del data[key]
        _write_store(data)
    return True


def has_tokens(key: str) -> bool:
    tokens = read_record(key).get("tokens")
    return isinstance(tokens, dict) and bool(tokens.get("access_token"))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def redirect_uri(port: int) -> str:
    return f"http://127.0.0.1:{port}{CALLBACK_PATH}"


def callback_port(key: str, config: OAuthConfig) -> int:
    """The port of the redirect URI: the configured port, else the port of the record, else a new free port."""
    if config.callback_port:
        return config.callback_port
    port = read_record(key).get("port")
    if isinstance(port, int) and 1024 <= port <= 65535:
        return port
    port = free_port()
    update_record(key, port=port)
    return port


class FileTokenStorage:
    """The ``TokenStorage`` of the MCP SDK, in ``mcp-auth.json``."""

    def __init__(self, key: str, config: OAuthConfig, redirect: str):
        self.key = key
        self.config = config
        self.redirect = redirect

    async def get_tokens(self) -> Any:
        from mcp.shared.auth import OAuthToken

        raw = read_record(self.key).get("tokens")
        try:
            return OAuthToken.model_validate(raw) if isinstance(raw, dict) else None
        except ValueError:
            return None

    async def set_tokens(self, tokens: Any) -> None:
        update_record(self.key, tokens=tokens.model_dump(mode="json", exclude_none=True))

    async def get_client_info(self) -> Any:
        from mcp.shared.auth import OAuthClientInformationFull

        if self.config.client_id:  # A client that the user registered.
            return OAuthClientInformationFull(
                client_id=self.config.client_id, client_secret=self.config.client_secret,
                redirect_uris=[self.redirect],  # type: ignore[list-item]
                token_endpoint_auth_method="client_secret_post" if self.config.client_secret else "none")
        raw = read_record(self.key).get("client")
        if not isinstance(raw, dict):
            return None
        try:
            info = OAuthClientInformationFull.model_validate(raw)
        except ValueError:
            return None
        if info.redirect_uris and self.redirect not in [str(u) for u in info.redirect_uris]:
            return None  # The callback port changed: register again.
        return info

    async def set_client_info(self, client_info: Any) -> None:
        if not self.config.client_id:
            update_record(self.key, client=client_info.model_dump(mode="json", exclude_none=True))


def make_provider(server_url: str, storage: FileTokenStorage, config: OAuthConfig, redirect_handler, callback_handler):
    """An ``OAuthClientProvider`` of the MCP SDK, with two changes:

    - The configured scopes replace the scopes that the server suggests.
    - The token requests ask for JSON. GitHub sends a form-encoded body without ``Accept: application/json``.
    """
    from mcp.client.auth import OAuthClientProvider
    from mcp.shared.auth import OAuthClientMetadata

    from . import __version__

    class Provider(OAuthClientProvider):
        async def _perform_authorization_code_grant(self):  # type: ignore[override]
            if config.scopes:
                self.context.client_metadata.scope = " ".join(config.scopes)
            return await super()._perform_authorization_code_grant()

        async def _exchange_token_authorization_code(self, auth_code: str, code_verifier: str):  # type: ignore[override]
            request = await super()._exchange_token_authorization_code(auth_code, code_verifier)
            request.headers["Accept"] = "application/json"
            return request

        async def _refresh_token(self):  # type: ignore[override]
            request = await super()._refresh_token()
            request.headers["Accept"] = "application/json"
            return request

    metadata = OAuthClientMetadata(
        client_name="Harness", redirect_uris=[storage.redirect],  # type: ignore[list-item]
        grant_types=["authorization_code", "refresh_token"], response_types=["code"],
        token_endpoint_auth_method="client_secret_post" if config.client_secret else "none",
        scope=" ".join(config.scopes) or None, software_id="harness", software_version=__version__)
    return Provider(server_url=server_url, client_metadata=metadata, storage=storage,
                    redirect_handler=redirect_handler, callback_handler=callback_handler)


class _QuietAuthRequired(logging.Filter):
    """The SDK logs each OAuth error with a traceback. ``AuthRequired`` is a normal state, not an error."""

    def filter(self, record: logging.LogRecord) -> bool:
        error = record.exc_info[1] if record.exc_info else None
        return not isinstance(error, (AuthRequired, AuthCancelled))


logging.getLogger("mcp.client.auth.oauth2").addFilter(_QuietAuthRequired())


def find_error(error: BaseException, kind: type[BaseException]) -> BaseException | None:
    """The first exception of ``kind`` in an exception, its group, or its causes."""
    seen: set[int] = set()
    stack = [error]
    while stack:
        e = stack.pop()
        if id(e) in seen:
            continue
        seen.add(id(e))
        if isinstance(e, kind):
            return e
        if isinstance(e, BaseExceptionGroup):
            stack.extend(e.exceptions)
        for linked in (e.__cause__, e.__context__):
            if linked is not None:
                stack.append(linked)
    return None


# -- the callback listener -----------------------------------------------------------------------------

PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Harness</title>
<style>body{{font:15px system-ui,sans-serif;margin:15vh auto;max-width:28em;padding:0 16px;color:#222}}
@media (prefers-color-scheme:dark){{body{{background:#1f1f1e;color:#eee}}}}</style></head>
<body><h1 style="font-size:20px">{title}</h1><p>{text}</p></body></html>"""


class Callback:
    """The listener for one sign-in. It runs in the MCP event loop."""

    def __init__(self, port: int, path: str = CALLBACK_PATH):
        self.port = port
        self.path = path  # Google uses "/" for a loopback redirect.
        self.server: asyncio.base_events.Server | None = None
        self.future: asyncio.Future | None = None

    async def start(self) -> None:
        self.future = asyncio.get_running_loop().create_future()
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", self.port)

    async def close(self) -> None:
        if self.server is not None:
            self.server.close()
            self.server = None
        if self.future is not None and not self.future.done():
            self.future.cancel()

    async def wait(self) -> Any:
        assert self.future is not None
        try:
            return await asyncio.wait_for(asyncio.shield(self.future), AUTH_TIMEOUT)
        except asyncio.TimeoutError:
            raise AuthCancelled(f"The sign-in did not complete in {AUTH_TIMEOUT // 60} minutes.") from None

    def cancel(self) -> None:
        if self.future is not None and not self.future.done():
            self.future.set_exception(AuthCancelled("The sign-in was cancelled."))

    def resolve(self, url: str) -> str | None:
        """Read the code from a callback URL (or its query). Return an error text, or None if it was accepted."""
        from mcp.client.auth import OAuthFlowError
        from mcp.shared.auth import AuthorizationCodeResult

        text = url.strip()
        query = urlparse(text).query if "://" in text else text.lstrip("?")
        params = {k: v[0] for k, v in parse_qs(query).items() if v}
        if self.future is None or self.future.done():
            return "No sign-in is waiting for a code."
        if "error" in params:
            detail = params.get("error_description") or params["error"]
            self.future.set_exception(OAuthFlowError(f"The authorization server refused the sign-in: {detail}"))
            return None
        if not params.get("code"):
            return "The URL has no 'code' parameter. Paste the full URL from the address bar."
        self.future.set_result(AuthorizationCodeResult(code=params["code"], state=params.get("state"),
                                                       iss=params.get("iss")))
        return None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            line = (await asyncio.wait_for(reader.readline(), 10)).decode("latin-1")
            while (await asyncio.wait_for(reader.readline(), 10)) not in (b"\r\n", b"\n", b""):
                pass  # The headers.
            parts = line.split()
            target = urlparse(parts[1]) if len(parts) >= 2 else None
            if parts[:1] != ["GET"] or target is None or target.path != self.path:
                await self._reply(writer, 404, "Not found", "This address only takes the sign-in callback.")
                return
            error = self.resolve(target.query)
            if error is None and "error=" not in target.query:
                await self._reply(writer, 200, "Signed in", "You can close this tab and go back to Harness.")
            else:
                await self._reply(writer, 400, "Sign-in failed", error or "Go back to Harness to see the error.")
        except Exception:  # noqa: BLE001 - a bad request must not stop the listener.
            log.debug("Bad OAuth callback request", exc_info=True)
        finally:
            writer.close()

    @staticmethod
    async def _reply(writer: asyncio.StreamWriter, status: int, title: str, text: str) -> None:
        body = PAGE.format(title=escape(title), text=escape(text)).encode()
        head = (f"HTTP/1.1 {status} {title}\r\nContent-Type: text/html; charset=utf-8\r\n"
                f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
        writer.write(head.encode() + body)
        await writer.drain()
