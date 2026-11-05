"""The conversation_search tool: find details in the past sessions of the project.

Settings > Your Harness > "Search and reference chats" turns it on or off (the setting ``chat_search``).
The session gives the search function (session.py, Storage.search_chats).
"""

from __future__ import annotations

import time
from typing import Any, Callable

from .base import Tool, ToolContext, ToolError, ToolResult

MAX_RESULTS = 10


class ConversationSearchTool(Tool):
    name = "conversation_search"
    description = (
        "Search the past sessions of this project for relevant details: earlier decisions, requests, "
        "and answers. Use it when the user refers to an earlier conversation, or when context from "
        "an earlier session will help. The query is a few keywords. The result gives the title and "
        "the date of each session, with the parts that match."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Keywords, for example 'release steps tag'."},
            "max_results": {"type": "integer", "description": f"From 1 to {MAX_RESULTS}. Default 5."},
        },
        "required": ["query"],
    }

    def __init__(self, search: Callable[[str, int], list[dict[str, Any]]]):
        self.search = search

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        query = " ".join(str(args.get("query") or "").split())
        if not query:
            raise ToolError("Give the keywords to search for in 'query'.")
        try:
            limit = max(1, min(MAX_RESULTS, int(args.get("max_results") or 5)))
        except (TypeError, ValueError):
            limit = 5
        found = self.search(query, limit)
        if not found:
            return ToolResult(f"No past session of this project matches '{query}'.")
        blocks = []
        for hit in found:
            day = time.strftime("%Y-%m-%d", time.localtime(hit["updated_at"]))
            lines = [f"## {hit['title'] or 'Untitled session'} ({day})"]
            lines += [f"{'User' if s['role'] == 'user' else 'Agent'}: {s['text']}" for s in hit["snippets"]]
            blocks.append("\n".join(lines))
        return ToolResult("\n\n".join(blocks))
