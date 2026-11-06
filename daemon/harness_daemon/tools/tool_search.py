"""tool_search: load the full definitions of MCP tools that the request sends by name only.

The definitions of many MCP tools make each request large. A model server that reads the full
prompt for each request then takes longer for each step. When the MCP tools would take more than a
part of the context (Agent.TOOL_SEARCH_SHARE), the request lists their names in this tool, and the
model loads the tools that it needs. A loaded tool is in the tool list of the next requests.
The setting "tool_search" is "auto" (the default), "on" (always), or "off" (never).
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from .base import Tool, ToolContext, ToolError, ToolResult

DEFAULT_RESULTS = 5
MAX_RESULTS = 20


def _words(text: str) -> list[str]:
    return [w for w in re.split(r"[^a-z0-9]+", text.lower()) if w]


def search_tools(tools: dict[str, Tool], ctx: ToolContext, query: str, limit: int) -> list[str]:
    """The names of the tools for the query. "select:a,b" gives these names. Other text matches
    words in the names (most weight) and in the descriptions."""
    query = query.strip()
    if query.lower().startswith("select:"):
        wanted = [n.strip() for n in query[len("select:"):].split(",") if n.strip()]
        return [n for n in wanted if n in tools]
    words = _words(query)
    if not words:
        return []
    scored: list[tuple[int, str]] = []
    for name, tool in tools.items():
        name_words = set(_words(name))
        text = tool.describe(ctx).lower()
        score = sum(3 if w in name_words else 2 if w in name.lower() else 1 if w in text else 0 for w in words)
        if score:
            scored.append((score, name))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [name for _, name in scored[:limit]]


class ToolSearchTool(Tool):
    name = "tool_search"
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": 'Exact names: "select:mcp__github__create_issue,mcp__github__get_issue". '
                               'Or keywords that match the names and the descriptions: "github pull request".',
            },
            "max_results": {"type": "integer", "description": f"At most this number of tools (default {DEFAULT_RESULTS})."},
        },
        "required": ["query"],
    }

    def __init__(self, deferred: Callable[[], dict[str, Tool]], load: Callable[[list[str]], None]):
        self._deferred = deferred  # The tools that the request sends by name only, also after a load.
        self._load = load

    def describe(self, ctx: ToolContext) -> str:
        # The list has all the tools that can be loaded, also the loaded ones: the text stays the same,
        # so the start of the request stays the same for the cache of the model server.
        names = ", ".join(sorted(self._deferred()))
        return (
            "Load the full definition of MCP tools that are not in your tool list yet. The tool list has only "
            "the names below, to keep each request small. Call this tool with the names (select:) or keywords "
            "of the tools that you need. Then call the tools as usual: they are in your tool list from the "
            "next step. A tool that you loaded before is already in your tool list. "
            f"The tools: {names}."
        )

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ToolError("Give a query: select:<names> or keywords.")
        try:
            limit = max(1, min(int(args.get("max_results") or DEFAULT_RESULTS), MAX_RESULTS))
        except (TypeError, ValueError):
            limit = DEFAULT_RESULTS
        tools = self._deferred()
        found = search_tools(tools, ctx, query, limit)
        if not found:
            return ToolResult(f"No tool matches {query!r}. The tools: {', '.join(sorted(tools))}.", is_error=True)
        self._load(found)
        lines = [f"Loaded {len(found)} {'tool' if len(found) == 1 else 'tools'}. They are in your tool list now:"]
        for name in found:
            schema = tools[name].schema(ctx)["function"]
            lines.append(json.dumps({"name": name, "description": schema.get("description", ""),
                                     "parameters": schema.get("parameters", {})}, ensure_ascii=False))
        return ToolResult("\n".join(lines))
