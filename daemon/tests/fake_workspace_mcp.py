"""A fake of workspace-mcp for the Gmail connector tests: the MCP test server (stdio).

The tool "secret" of the test server gives MCP_TEST_SECRET. This fake sets it to GOOGLE_OAUTH_CLIENT_SECRET,
so a test can check that the daemon gives the server the client secret. FAKE_WORKSPACE_LOG gets the arguments.
"""

from __future__ import annotations

import json
import os
import runpy
import sys
from pathlib import Path

log = os.environ.get("FAKE_WORKSPACE_LOG")
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"args": sys.argv[1:], "dir": os.environ.get("WORKSPACE_MCP_CREDENTIALS_DIR")}) + "\n")
os.environ["MCP_TEST_SECRET"] = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "(none)")
sys.argv = [sys.argv[0]]
runpy.run_path(str(Path(__file__).with_name("mcp_test_server.py")), run_name="__main__")
