"""The network proxy of the sandbox: an HTTP proxy in the daemon that checks each host. See docs/SANDBOX.md.

A sandboxed command has no network. When sandbox.network.allowedDomains has a domain, the bash tool starts one
proxy for each command (network_for). The proxy variables of the command (HTTP_PROXY, HTTPS_PROXY) point to it,
and the sandbox allows only the connection to the proxy:

- macOS: the proxy listens on 127.0.0.1:<random port>. The Seatbelt profile allows only that port.
- Linux: the proxy listens on a Unix socket. socat in the network namespace of the command connects a local port
  to the socket (sandbox.LINUX_BRIDGE_SCRIPT).

The proxy accepts two requests:

- ``CONNECT host:port`` (HTTPS and other TLS): a tunnel to the host. The proxy does not read the TLS data.
- ``GET http://host/path`` and the other methods with an absolute URL (plain HTTP): the proxy sends the request
  to the host with "Connection: close", and with no Proxy-* headers.

The domain rules (domain_allowed) are the rules of Claude Code: an exact host, "*.example.com" for the subdomains
of example.com, and "*" for all hosts. A pattern can end with ":<port>". A denied domain wins over an allowed
domain. An empty allow list allows nothing.

The proxy writes no log. It keeps only the blocked "host:port" values of its command, for the line that the bash
tool adds to the output. It never keeps a path, a query, a header, or data: these can hold secrets.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import secrets
import tempfile
from contextlib import asynccontextmanager, suppress
from dataclasses import replace
from typing import Any, AsyncIterator
from urllib.parse import urlsplit

from . import sandbox
from .sandbox import SandboxPolicy

HEAD_LIMIT = 64 * 1024  # The maximum size of a request head.
HEAD_TIMEOUT = 30.0  # Seconds for the request head.
CONNECT_TIMEOUT = 15.0  # Seconds for the connection to the host.
CHUNK = 64 * 1024
MAX_BLOCKED = 20  # The blocked hosts that the proxy keeps for one command.

_HOST_LABEL = re.compile(r"^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$")
_DROP_HEADERS = {"proxy-authorization", "proxy-connection", "connection", "keep-alive"}

BLOCKED_TEXT = ("The Harness sandbox blocked the connection to {host}. The host is not in "
                "sandbox.network.allowedDomains, or it is in sandbox.network.deniedDomains.\n")


# -- the domain rules ----------------------------------------------------------------------------------------


def normalize_host(host: Any) -> str | None:
    """The host in lower case with no final dot, or None if it is not a valid host name or IP address.

    An IPv6 address can have brackets. A host name has only letters, digits, "-", "_", and dots.
    """
    if not isinstance(host, str):
        return None
    host = host.strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    host = host.rstrip(".")
    if not host or len(host) > 253:
        return None
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    labels = host.split(".")
    return host if all(_HOST_LABEL.match(label) for label in labels) else None


def _split_pattern(pattern: str) -> tuple[str, int | None]:
    """The host part and the port of a domain pattern. "example.com:443" gives ("example.com", 443)."""
    pattern = pattern.strip().lower()
    if pattern.startswith("["):  # "[::1]:8080" or "[::1]".
        host, _, rest = pattern[1:].partition("]")
        port = rest[1:] if rest.startswith(":") else ""
        return host, int(port) if port.isdigit() else None
    if pattern.count(":") == 1:
        host, _, port = pattern.partition(":")
        return host, int(port) if port.isdigit() else -1  # -1: a port that is not valid matches nothing.
    return pattern, None  # No port, or an IPv6 address with no brackets.


def pattern_matches(pattern: str, host: str, port: int) -> bool:
    """True if the domain pattern matches the normalized ``host`` and ``port``.

    "example.com" matches only example.com. "*.example.com" matches a.example.com and a.b.example.com, but not
    example.com. "*" matches all hosts. A pattern with no port matches all ports.
    """
    if not isinstance(pattern, str) or not pattern.strip():
        return False
    name, want_port = _split_pattern(pattern)
    if want_port is not None and want_port != port:
        return False
    name = name.rstrip(".")
    if name == "*":
        return True
    if name.startswith("*."):
        base = normalize_host(name[2:])
        return base is not None and host.endswith("." + base)
    return normalize_host(name) == host


def domain_allowed(host: Any, port: int, allowed: list[str], denied: list[str]) -> bool:
    """True if a sandboxed command can connect to ``host``:``port``. A denied domain wins over an allowed
    domain. An empty allow list allows nothing. A host that is not valid is never allowed."""
    name = normalize_host(host)
    if name is None or not 0 < port < 65536:
        return False
    if any(pattern_matches(p, name, port) for p in denied):
        return False
    return any(pattern_matches(p, name, port) for p in allowed)


# -- the proxy -----------------------------------------------------------------------------------------------


def _split_target(target: str) -> tuple[str, int] | None:
    """The host and the port of a CONNECT target "host:port" or "[v6]:port"."""
    if target.startswith("["):
        host, _, rest = target[1:].partition("]")
        port = rest[1:] if rest.startswith(":") else ""
    else:
        host, _, port = target.rpartition(":")
    if not host or not port.isdigit():
        return None
    return host, int(port)


def _response(status: str, text: str = "") -> bytes:
    body = text.encode("utf-8")
    return (f"HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {len(body)}\r\n"
            f"Connection: close\r\n\r\n").encode("ascii") + body


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Copy the data of ``reader`` to ``writer`` until the end, then end the write side."""
    try:
        while True:
            data = await reader.read(CHUNK)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        with suppress(Exception):
            if writer.can_write_eof():
                writer.write_eof()


async def _close(writer: asyncio.StreamWriter) -> None:
    with suppress(Exception):
        writer.close()
        await writer.wait_closed()


class SandboxProxy:
    """One HTTP proxy for the commands of one bash call. Start it with start(), and stop it with stop()."""

    def __init__(self, allowed: list[str], denied: list[str], connect_timeout: float = CONNECT_TIMEOUT):
        self.allowed = list(allowed)
        self.denied = list(denied)
        self.connect_timeout = connect_timeout
        self.blocked: list[str] = []  # "host:port" values that the proxy refused, in order, with no duplicates.
        self.port: int | None = None  # The TCP port, when the proxy listens on 127.0.0.1.
        self.socket_path: str | None = None  # The Unix socket, when the proxy listens on one.
        self._server: asyncio.AbstractServer | None = None
        self._tasks: set[asyncio.Task] = set()

    async def start(self, unix_path: str | None = None) -> None:
        """Listen on 127.0.0.1 and a free port, or on the Unix socket ``unix_path``."""
        if unix_path is not None:
            with suppress(FileNotFoundError):
                os.unlink(unix_path)
            self._server = await asyncio.start_unix_server(self._handle, path=unix_path, limit=HEAD_LIMIT)
            with suppress(OSError):
                os.chmod(unix_path, 0o600)
            self.socket_path = unix_path
        else:
            self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0, limit=HEAD_LIMIT)
            self.port = self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        """Stop to listen, and close all open connections."""
        if self._server is not None:
            self._server.close()
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._server is not None:
            with suppress(Exception):
                await self._server.wait_closed()
            self._server = None
        if self.socket_path is not None:
            with suppress(OSError):
                os.unlink(self.socket_path)

    def _block(self, host: str, port: int) -> None:
        name = normalize_host(host)
        label = f"{name}:{port}" if name is not None else "a host name that is not valid"
        if label not in self.blocked and len(self.blocked) < MAX_BLOCKED:
            self.blocked.append(label)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._tasks.add(task)
        upstream: asyncio.StreamWriter | None = None
        try:
            try:
                head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEAD_TIMEOUT)
            except asyncio.IncompleteReadError:
                return  # The client closed the connection with no request (for example a port check).
            except asyncio.LimitOverrunError:
                writer.write(_response("431 Request Header Fields Too Large"))
                return
            except (asyncio.TimeoutError, ConnectionError, OSError):
                return
            lines = head.decode("latin-1").split("\r\n")
            parts = lines[0].split(" ")
            if len(parts) != 3 or not parts[2].startswith("HTTP/"):
                writer.write(_response("400 Bad Request", "The Harness sandbox proxy cannot read the request.\n"))
                return
            method, target, version = parts
            if method.upper() == "CONNECT":
                found = _split_target(target)
                if found is None:
                    writer.write(_response("400 Bad Request", "CONNECT needs host:port.\n"))
                    return
                host, port = found
                first: bytes | None = None
            else:
                url = urlsplit(target)
                if url.scheme.lower() != "http" or not url.hostname:
                    writer.write(_response("400 Bad Request", "The Harness sandbox proxy needs an absolute "
                                                              "http:// URL, or CONNECT for HTTPS.\n"))
                    return
                host = url.hostname
                try:
                    port = url.port or 80
                except ValueError:
                    writer.write(_response("400 Bad Request", "The port is not valid.\n"))
                    return
                path = url.path or "/"
                if url.query:
                    path += "?" + url.query
                headers = [line for line in lines[1:] if line and
                           line.split(":", 1)[0].strip().lower() not in _DROP_HEADERS]
                first = "\r\n".join([f"{method} {path} {version}", *headers, "Connection: close", "", ""]
                                    ).encode("latin-1")
            if not domain_allowed(host, port, self.allowed, self.denied):
                self._block(host, port)
                shown = normalize_host(host) or "this host"
                writer.write(_response("403 Forbidden", BLOCKED_TEXT.format(host=shown)))
                return
            try:
                up_reader, upstream = await asyncio.wait_for(
                    asyncio.open_connection(normalize_host(host), port, limit=CHUNK), self.connect_timeout)
            except (asyncio.TimeoutError, OSError) as e:
                reason = "timed out" if isinstance(e, asyncio.TimeoutError) else type(e).__name__
                writer.write(_response("502 Bad Gateway", f"The Harness sandbox proxy cannot connect to "
                                                          f"{normalize_host(host)}:{port} ({reason}).\n"))
                return
            if first is None:
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
            else:
                upstream.write(first)
            await asyncio.gather(_pipe(reader, upstream), _pipe(up_reader, writer))
        except (ConnectionError, OSError):
            pass
        finally:
            with suppress(Exception):
                await writer.drain()
            if upstream is not None:
                await _close(upstream)
            await _close(writer)
            if task is not None:
                self._tasks.discard(task)


# -- the start point for the bash tool -----------------------------------------------------------------------


def socket_path() -> str:
    """A new Unix socket path for the proxy on Linux. It is short (the limit is 108 bytes) and has no character
    that socat reads as a separator."""
    folder = tempfile.gettempdir()
    if len(folder) > 60 or re.search(r"[^A-Za-z0-9_./-]", folder):
        folder = "/tmp"
    return os.path.join(folder, f"harness-proxy-{secrets.token_hex(6)}.sock")


@asynccontextmanager
async def network_for(policy: SandboxPolicy | None, config: dict[str, Any],
                      platform: str | None = None) -> AsyncIterator[tuple[SandboxPolicy | None, SandboxProxy | None]]:
    """Start a proxy for one sandboxed command when the settings allow domains. Yield the policy of the command
    (with the network "proxy" and the proxy port) and the proxy. With no proxy, yield the policy as it is and
    None. The proxy stops when the block ends."""
    if policy is None or policy.network != "off" or sandbox.network_mode(config, platform) != "proxy":
        yield policy, None
        return
    network = config.get("network") or {}
    proxy = SandboxProxy(network.get("allowedDomains") or [], network.get("deniedDomains") or [])
    if sandbox.backend_for(platform) == "bubblewrap":
        path = socket_path()
        await proxy.start(unix_path=path)
        policy = replace(policy, network="proxy", proxy_port=sandbox.LINUX_PROXY_PORT, proxy_socket=path)
    else:
        await proxy.start()
        policy = replace(policy, network="proxy", proxy_port=proxy.port)
    try:
        yield policy, proxy
    finally:
        await proxy.stop()
