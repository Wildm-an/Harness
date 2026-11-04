"""A fake of @softeria/ms-365-mcp-server for the Outlook connector tests.

    python fake_ms365.py [args] --login    # Prints a device code, waits, then prints the JSON result.
    python fake_ms365.py [args] --logout   # Prints the JSON result.
    python fake_ms365.py [args]            # The MCP test server (stdio).

The environment controls it:

- FAKE_MS365_LOG: a file. Each run adds one JSON line: the arguments and MS365_MCP_TENANT_ID.
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
        f.write(json.dumps({"args": args, "tenant": os.environ.get("MS365_MCP_TENANT_ID")}) + "\n")

if "--login" in args:
    print("\nTo sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the "
          "code FAKE1234X to authenticate.\n", flush=True)
    approve = os.environ.get("FAKE_MS365_APPROVE")
    if approve:
        while not Path(approve).exists():
            time.sleep(0.1)
    if os.environ.get("FAKE_MS365_FAIL"):
        print(json.dumps({"success": False, "message": "The user denied the sign-in"}), flush=True)
    else:
        print(json.dumps({"success": True, "message": "Login successful",
                          "userData": {"displayName": "Pat", "userPrincipalName": "pat@outlook.com"}}), flush=True)
    sys.exit(0)

if "--logout" in args:
    print(json.dumps({"message": "Logged out successfully"}), flush=True)
    sys.exit(0)

sys.argv = [sys.argv[0]]
runpy.run_path(str(Path(__file__).with_name("mcp_test_server.py")), run_name="__main__")
