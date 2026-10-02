"""HTTP servers for the tests that start at once.

http.server.HTTPServer calls socket.getfqdn() when it binds. On the macOS runners of GitHub
Actions, getfqdn("127.0.0.1") takes about 35 seconds. A test server then printed its address too
late, and the test stopped at its time limit. These servers do not call getfqdn.
"""

from __future__ import annotations

import socketserver
from http.server import HTTPServer, ThreadingHTTPServer


class QuickHTTPServer(HTTPServer):
    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port


class QuickThreadingHTTPServer(socketserver.ThreadingMixIn, QuickHTTPServer):
    daemon_threads = ThreadingHTTPServer.daemon_threads
