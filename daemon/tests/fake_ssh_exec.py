"""A fake ssh program that runs the remote command on this computer.

    fake_ssh_exec.py [ssh options] -- <target> <command...>

It writes its arguments to the file in FAKE_SSH_LOG, if that variable is set. stdin goes to
the command, as with ssh.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys


def main() -> None:
    args = sys.argv[1:]
    if os.environ.get("FAKE_SSH_LOG"):
        with open(os.environ["FAKE_SSH_LOG"], "a", encoding="utf-8") as f:
            f.write(json.dumps(args) + "\n")
    command = args[args.index("--") + 2:]
    sys.exit(subprocess.call(command))


if __name__ == "__main__":
    main()
