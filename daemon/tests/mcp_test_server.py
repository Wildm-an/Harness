"""A small MCP server for the MCP tests.

    python mcp_test_server.py                  # stdio
    python mcp_test_server.py http <port>      # streamable HTTP at http://127.0.0.1:<port>/mcp

Tools: add, echo, fail (an error result), picture (an image), secret (reads the env
variable MCP_TEST_SECRET), and add_tool (adds a tool and sends tools/list_changed).
"""

from __future__ import annotations

import base64
import os
import sys

from mcp.server.mcpserver import Context, MCPServer

server = MCPServer("harness-test")

# A 1x1 PNG.
PIXEL = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


@server.tool(description="Add two integers.")
def add(a: int, b: int) -> int:
    return a + b


@server.tool(description="Return the text.")
def echo(text: str) -> str:
    return text


@server.tool(description="Always fails.")
def fail() -> str:
    raise ValueError("this tool always fails")


@server.tool(description="Return a small image.")
def picture():
    from mcp.server.mcpserver import Image

    return Image(data=PIXEL, format="png")


@server.tool(description="Return the value of MCP_TEST_SECRET.")
def secret() -> str:
    return os.environ.get("MCP_TEST_SECRET", "(not set)")


@server.tool(description="Add the tool 'late', then tell the client that the tool list changed.")
async def add_tool(ctx: Context) -> str:
    def late() -> str:
        return "late tool"

    server.add_tool(late, name="late", description="A tool that comes later.")
    await ctx.session.send_tool_list_changed()
    return "added"


def main() -> None:
    if len(sys.argv) > 2 and sys.argv[1] == "http":
        import uvicorn

        uvicorn.run(server.streamable_http_app(), host="127.0.0.1", port=int(sys.argv[2]), log_level="warning")
    else:
        server.run("stdio")


if __name__ == "__main__":
    main()
