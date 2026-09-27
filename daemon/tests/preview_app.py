"""A small web app for the preview tool tests.

    python preview_app.py <port>

Pages:

- ``/``: a counter button, a text box with a "Greet" button, a select box, links, a button
  that throws an error, and hidden text. It writes one console error when it loads.
- ``/about``: a second page.
- Other paths: HTTP 404.
"""

from __future__ import annotations

import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

HOME = """<!doctype html>
<html>
<head><title>Test app</title></head>
<body>
  <h1>Counter</h1>
  <p id="count">Count: 0</p>
  <button onclick="add()">Add one</button>
  <label for="name">Name</label>
  <input id="name" placeholder="Your name">
  <button onclick="greet()">Greet</button>
  <div id="out"></div>
  <select id="color" aria-label="Color"><option>Red</option><option>Blue</option></select>
  <a href="/about">About</a>
  <a href="https://example.com/">External</a>
  <button onclick="boom()">Break</button>
  <div hidden>Secret hidden text</div>
  <script>
    let n = 0;
    function add() { n += 1; document.getElementById("count").textContent = "Count: " + n; }
    function greet() { document.getElementById("out").textContent = "Hello, " + document.getElementById("name").value; }
    function boom() { throw new Error("boom from the page"); }
    console.error("an error at load");
  </script>
</body>
</html>
"""

ABOUT = """<!doctype html>
<html><head><title>About</title></head><body><h1>About page</h1><a href="/">Home</a></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - the name comes from BaseHTTPRequestHandler.
        path = self.path.split("?")[0]
        page = {"/": HOME, "/about": ABOUT}.get(path)
        body = (page or "<h1>Not found</h1>").encode("utf-8")
        self.send_response(200 if page else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    port = int(sys.argv[1])
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"  Local:   http://127.0.0.1:{port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
