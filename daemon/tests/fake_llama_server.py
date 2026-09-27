"""A fake llama-server for the Cookbook tests.

It reads --port and --alias, prints a few log lines, and answers GET /health with 200 after a
short load time. With the environment variable FAKE_LLAMA_CRASH, it stops at once with an error.
"""

from __future__ import annotations

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


def arg(name: str, default: str = "") -> str:
    args = sys.argv[1:]
    return args[args.index(name) + 1] if name in args else default


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        body = json.dumps({"status": "ok"} if self.path == "/health" else {"data": [{"id": arg("--alias")}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    print(f"fake llama-server: model {arg('-m')} context {arg('-c')} gpu layers {arg('-ngl')}", flush=True)
    if os.environ.get("FAKE_LLAMA_CRASH"):
        print("error: failed to load model", flush=True)
        sys.exit(1)
    time.sleep(0.5)
    server = HTTPServer(("127.0.0.1", int(arg("--port", "8080"))), Handler)
    print("main: server is listening", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
