"""A fake of @softeria/ms-365-mcp-server for the Outlook connector tests.

    python fake_ms365.py [args] --login               # Prints a device code, waits, adds an account.
    python fake_ms365.py [args] --list-accounts       # {"accounts": [{"id", "username", ...}]}
    python fake_ms365.py [args] --remove-account <x>  # Removes one account.
    python fake_ms365.py [args] --logout              # Removes all the accounts.
    python fake_ms365.py [args]                       # The MCP test server (stdio).

The accounts are a JSON list in the file MS365_MCP_TOKEN_CACHE_PATH, as the real server keeps its
cache there. As the real server, --login reports the selected account (the first one), not the new one.
The environment controls it:

- FAKE_MS365_LOG: a file. Each run adds one JSON line: the arguments and the important variables.
- FAKE_MS365_USER: the account that --login adds. The default is pat@outlook.com.
- FAKE_MS365_USER_FILE: a file with the account that --login adds. It wins over FAKE_MS365_USER.
- FAKE_MS365_APPROVE: a file. --login waits until it exists (the user signs in). With no value, it does not wait.
- FAKE_MS365_FAIL: --login prints a failed result.
"""

from __future__ import annotations

import json
import os
import runpy
import sys
import time
from pathlib import Path

args = sys.argv[1:]
log = os.environ.get("FAKE_MS365_LOG")
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"args": args, "tenant": os.environ.get("MS365_MCP_TENANT_ID"),
                            "cache": os.environ.get("MS365_MCP_TOKEN_CACHE_PATH")}) + "\n")

cache = Path(os.environ.get("MS365_MCP_TOKEN_CACHE_PATH") or Path.home() / ".fake-ms365.json")


def accounts() -> list[str]:
    try:
        return json.loads(cache.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def save(names: list[str]) -> None:
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(names), encoding="utf-8")


def done(data: dict) -> None:
    print(json.dumps(data), flush=True)
    sys.exit(0)


if "--login" in args:
    print("\nTo sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the "
          "code FAKE1234X to authenticate.\n", flush=True)
    approve = os.environ.get("FAKE_MS365_APPROVE")
    if approve:
        while not Path(approve).exists():
            time.sleep(0.1)
    if os.environ.get("FAKE_MS365_FAIL"):
        done({"success": False, "message": "The user denied the sign-in"})
    user = os.environ.get("FAKE_MS365_USER", "pat@outlook.com")
    user_file = os.environ.get("FAKE_MS365_USER_FILE")
    if user_file and Path(user_file).exists():
        user = Path(user_file).read_text(encoding="utf-8").strip() or user
    names = accounts()
    if user not in names:
        names.append(user)
    save(names)
    done({"success": True, "message": "Login successful",
          "userData": {"displayName": names[0], "userPrincipalName": names[0]}})

if "--list-accounts" in args:
    done({"accounts": [{"id": f"id-{n}", "username": n, "name": n, "selected": i == 0}
                       for i, n in enumerate(accounts())]})

if "--remove-account" in args:
    target = args[args.index("--remove-account") + 1]
    names = accounts()
    if target not in names:
        done({"error": f"Account not found: {target}"})
    save([n for n in names if n != target])
    done({"message": f"Removed account: {target}"})

if "--logout" in args:
    save([])
    done({"message": "Logged out successfully"})

sys.argv = [sys.argv[0]]
runpy.run_path(str(Path(__file__).with_name("mcp_test_server.py")), run_name="__main__")
