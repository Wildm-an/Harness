"""The test HTTP servers do not call socket.getfqdn (it takes about 35 seconds on the macOS runners)."""

from __future__ import annotations

import re
import socket
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path

import httpx
import pytest

from quick_http import QuickHTTPServer, QuickThreadingHTTPServer


class Hello(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - the name comes from BaseHTTPRequestHandler.
        self.send_response(200)
        self.send_header("Content-Length", "5")
        self.end_headers()
        self.wfile.write(b"hello")

    def log_message(self, *args) -> None:
        pass


@pytest.mark.parametrize("server_class", [QuickHTTPServer, QuickThreadingHTTPServer])
def test_the_server_starts_without_getfqdn(monkeypatch, server_class):
    def no_getfqdn(*args):
        raise AssertionError("getfqdn was called")

    monkeypatch.setattr(socket, "getfqdn", no_getfqdn)
    server = server_class(("127.0.0.1", 0), Hello)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert server.server_name == "127.0.0.1"
        assert httpx.get(f"http://127.0.0.1:{server.server_port}/").text == "hello"
    finally:
        server.shutdown()
        server.server_close()


def test_no_test_server_uses_the_slow_servers():
    slow = re.compile(r"\b(?<!Quick)(Threading)?HTTPServer\(")
    tests = Path(__file__).parent
    users = [p.name for p in tests.glob("*.py") if p.name != "quick_http.py" and slow.search(p.read_text(encoding="utf-8"))]
    assert users == [], f"Use quick_http.QuickHTTPServer in: {users}"
