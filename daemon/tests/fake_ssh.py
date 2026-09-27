"""A fake ssh program for the tunnel tests.

It reads "-L 127.0.0.1:<local>:<host>:<port>" and forwards the local port to host:port,
as ``ssh -N -L`` does. It ignores the SSH target. It writes each command line to the file
in FAKE_SSH_LOG, if that variable is set.

FAKE_SSH_FAIL=<message> makes it print the message and stop, as a failed login does.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading


def pipe(src: socket.socket, dst: socket.socket) -> None:
    try:
        while data := src.recv(65536):
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def main() -> None:
    args = sys.argv[1:]
    if os.environ.get("FAKE_SSH_LOG"):
        with open(os.environ["FAKE_SSH_LOG"], "a", encoding="utf-8") as f:
            f.write(json.dumps(args) + "\n")
    if os.environ.get("FAKE_SSH_FAIL"):
        print(os.environ["FAKE_SSH_FAIL"], file=sys.stderr, flush=True)
        sys.exit(255)
    spec = args[args.index("-L") + 1]
    bind, local, host, port = spec.rsplit(":", 3)
    server = socket.socket()
    server.bind((bind, int(local)))
    server.listen()
    while True:
        client, _ = server.accept()
        upstream = socket.create_connection((host.strip("[]"), int(port)))
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


if __name__ == "__main__":
    main()
