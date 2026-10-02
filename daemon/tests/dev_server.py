"""A small dev server for the server tests.

    python dev_server.py <port> [crash]

It prints a line with its address (the ready pattern), writes a line to stderr, and then
serves "hello from the dev server" for each GET request. With "crash", it stops with exit
code 3 after it prints its lines.
"""

from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler

from quick_http import QuickHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - the name comes from BaseHTTPRequestHandler.
        body = b"hello from the dev server"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    port = int(sys.argv[1])
    if len(sys.argv) > 2 and sys.argv[2] == "crash":
        print("Starting, then failing", flush=True)
        print("Error: something is wrong", file=sys.stderr, flush=True)
        sys.exit(3)
    server = QuickHTTPServer(("127.0.0.1", port), Handler)
    print(f"  Local:   http://127.0.0.1:{port}/", flush=True)
    print("a warning on stderr", file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
