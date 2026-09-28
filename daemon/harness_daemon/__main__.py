"""Start the daemon.

    python -m harness_daemon [--host 127.0.0.1] [--port 0] [--token TOKEN]

The token comes from, in order:

1. ``--token``. Other users can see command-line arguments in the process list.
2. The ``HARNESS_TOKEN`` environment variable. The desktop client uses it for the sidecar.
3. The token file (``--token-file``, default ``~/.harness/daemon-token``). The daemon
   creates the file on the first start, so a remote daemon keeps its token after a restart.
   ``--new-token`` replaces the token in the file.

When the daemon is ready, it prints one JSON line to stdout::

    {"event": "ready", "host": "127.0.0.1", "port": 53817}

Other commands:

    harness-daemon --install-browser   Install Chromium for the agent browser, then stop.
    harness-daemon --version           Show the version, then stop.
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import logging
import os
import secrets
import socket
import sys
import threading
from pathlib import Path

import uvicorn

from . import __version__, frozen
from .config import harness_home
from .server import create_app, stop_all_servers
from .tunnels import TUNNELS

SHUTDOWN_GRACE = 5


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def load_or_create_token(path: Path, replace: bool = False) -> tuple[str, bool]:
    """Read the token from ``path``, or write a new one. Return the token and True if it is new."""
    if not replace:
        try:
            token = path.read_text(encoding="utf-8").strip()
            if token:
                return token, False
        except FileNotFoundError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    # Only the owner can read the file (on POSIX systems).
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(token + "\n")
    return token, True


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    frozen.repair_environment()
    if argv[:1] == [frozen.PYTHON_STDIN_FLAG]:
        # The frozen daemon runs the Cookbook host script this way (cookbook/hosts.py).
        frozen.run_python_stdin()
        return
    parser = argparse.ArgumentParser(prog="harness-daemon")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address. Default 127.0.0.1.")
    parser.add_argument("--port", type=int, default=0, help="Port. 0 selects a random free port.")
    parser.add_argument("--token", default=None, help="Connection token. Prefer HARNESS_TOKEN or the token file.")
    parser.add_argument("--token-file", default=None, help="The token file. Default: ~/.harness/daemon-token.")
    parser.add_argument("--new-token", action="store_true", help="Write a new token to the token file.")
    parser.add_argument("--log-level", default="warning")
    parser.add_argument("--exit-on-stdin-eof", action="store_true",
                        help="Stop when stdin closes. The desktop client uses this for the sidecar.")
    parser.add_argument("--install-browser", action="store_true",
                        help="Install Chromium for the agent browser (Playwright), then stop.")
    parser.add_argument("--version", action="version", version=f"harness-daemon {__version__}")
    args = parser.parse_args(argv)
    if args.install_browser:
        sys.exit(frozen.install_browser())

    logging.basicConfig(level=args.log_level.upper(), stream=sys.stderr)
    token = args.token or os.environ.get("HARNESS_TOKEN")
    token_file: Path | None = None
    if not token:
        token_file = Path(args.token_file).expanduser() if args.token_file else harness_home() / "daemon-token"
        token, created = load_or_create_token(token_file, args.new_token)
        state = "created" if created else "read"
        print(f"The token was {state}: {token_file}", file=sys.stderr)
    if not _is_loopback(args.host):
        print(f"Warning: the daemon listens on {args.host}. Do not expose this port to the internet.", file=sys.stderr)

    family = socket.AF_INET6 if ":" in args.host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.bind((args.host, args.port))
    sock.listen(64)
    port = sock.getsockname()[1]

    app = create_app(token=token)
    server = uvicorn.Server(uvicorn.Config(app, log_level=args.log_level, ws_max_size=32 * 1024 * 1024))
    ready: dict = {"event": "ready", "host": args.host, "port": port}
    if token_file is not None:
        # The user started the daemon by hand. Show the token that the client needs.
        ready["token"] = token
        ready["token_file"] = str(token_file)
    print(json.dumps(ready), flush=True)
    if args.exit_on_stdin_eof:
        threading.Thread(target=_exit_on_stdin_eof, args=(server,), daemon=True).start()
    asyncio.run(server.serve(sockets=[sock]))


def _hard_exit() -> None:
    # os._exit does not run the shutdown code. Do not leave ssh or server processes.
    TUNNELS.close_all()
    stop_all_servers()
    os._exit(0)


def _exit_on_stdin_eof(server: uvicorn.Server) -> None:
    """Stop the server when the parent process closes stdin or stops."""
    try:
        while sys.stdin.buffer.read(4096):
            pass
    except (OSError, ValueError):
        pass
    server.should_exit = True
    # A graceful stop cancels the turns. If it takes too long, stop now.
    timer = threading.Timer(SHUTDOWN_GRACE, _hard_exit)
    timer.daemon = True
    timer.start()


if __name__ == "__main__":
    main()
