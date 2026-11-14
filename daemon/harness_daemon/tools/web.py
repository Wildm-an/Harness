"""The web tools: web_search and web_fetch (web.py), as WebSearch and WebFetch in Claude Code.

| Tool | Approval | Rule of "Always allow" |
|---|---|---|
| ``web_fetch`` | For each host | ``web_fetch(domain:<host>)`` |
| ``web_search`` | Yes | ``web_search`` (all searches) |
"""

from __future__ import annotations

from typing import Any

from ..web import DEFAULT_RESULTS, MAX_RESULTS, WebError, fetch, host_of, normalize_url, search
from .base import Approval, Tool, ToolContext, ToolError, ToolResult, get_int


def _strings(value: Any, key: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ToolError(f"Argument '{key}' must be a list of domains, for example [\"python.org\"].")
    return value


class WebFetchTool(Tool):
    name = "web_fetch"
    description = (
        "Fetch a web page and read it as text. HTML becomes text in the Markdown form, with the links. "
        "It also reads JSON, plain text, and PDF files, and shows an image to a model that accepts images. "
        "A long page comes in parts: use offset to read the next part. A page that you fetched in the "
        "last 15 minutes comes from a cache. A redirect to another host does not continue: call web_fetch "
        "again with the new URL. Do not use it for pages of the dev servers: use the preview tools."
    )
    parameters = {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "A full http or https URL."},
            "offset": {"type": "integer", "description": "The first character to read. Default 0."},
        },
        "required": ["url"],
    }
    needs_approval = True

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval | None:
        try:
            url = normalize_url(str(args.get("url") or ""))
        except WebError as e:
            raise ToolError(str(e)) from None
        host = host_of(url)
        return Approval(key=f"domain:{host}", rule=f"web_fetch(domain:{host})")

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        offset = max(get_int(args, "offset", 0) or 0, 0)
        try:
            page = await fetch(str(args.get("url") or ""))
        except WebError as e:
            raise ToolError(str(e)) from None
        if page.redirect:
            return ToolResult(f"{page.url} redirects (HTTP {page.status}) to another host: {page.redirect}\n"
                              "Call web_fetch with this URL to read it.")
        head = [f"URL: {page.url}"]
        if page.title:
            head.append(f"Title: {page.title}")
        if page.status >= 400:
            head.append(f"The server returned HTTP {page.status}.")
        if page.image is not None:
            if ctx.image_input:
                return ToolResult("\n".join(head + [page.text]), image=page.image)
            return ToolResult("\n".join(head + [page.text, "The model of this session does not accept images."]))
        text = page.text
        if not text:
            return ToolResult("\n".join(head + ["(The page has no text.)"]))
        if offset >= len(text):
            raise ToolError(f"The page has {len(text)} characters. Offset {offset} is after the end.")
        limit = int(ctx.settings.get("max_output_chars") or 20_000)
        part = text[offset:offset + limit]
        end = offset + len(part)
        body = "\n".join(head) + "\n\n" + part
        if offset or end < len(text):
            body += f"\n\n[Characters {offset}-{end} of {len(text)}."
            body += f" Use offset={end} to read more.]" if end < len(text) else "]"
        return ToolResult(body, limited=True)


class WebSearchTool(Tool):
    name = "web_search"
    description = (
        "Search the web. The result lists the title, the URL, and a short text of each page. Use web_fetch "
        "to read a page. Use it for information after your training data, for example new versions and "
        "docs. In your answer, give the URLs of the pages that you used, in a list with the title "
        "\"Sources:\"."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query."},
            "allowed_domains": {"type": "array", "items": {"type": "string"},
                                "description": "Show only results from these domains. Optional."},
            "blocked_domains": {"type": "array", "items": {"type": "string"},
                                "description": "Do not show results from these domains. Optional."},
            "count": {"type": "integer", "description": f"The number of results, 1 to {MAX_RESULTS}. Default {DEFAULT_RESULTS}."},
        },
        "required": ["query"],
    }
    needs_approval = True

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval | None:
        query = str(args.get("query") or "").strip()
        if len(query) < 2:
            raise ToolError("Give a search query of 2 characters or more.")
        _strings(args.get("allowed_domains"), "allowed_domains")
        _strings(args.get("blocked_domains"), "blocked_domains")
        return Approval(key=query, rule="web_search")

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        query = str(args.get("query") or "").strip()
        count = get_int(args, "count", DEFAULT_RESULTS) or DEFAULT_RESULTS
        try:
            results = await search(query, ctx.settings, _strings(args.get("allowed_domains"), "allowed_domains"),
                                   _strings(args.get("blocked_domains"), "blocked_domains"), count)
        except WebError as e:
            raise ToolError(str(e)) from None
        if not results:
            return ToolResult(f"No results for: {query}")
        lines = [f"Results for: {query}", ""]
        for n, r in enumerate(results, 1):
            lines.append(f"{n}. {r.title}\n   {r.url}")
            if r.snippet:
                lines.append(f"   {r.snippet}")
        lines.append("\nUse web_fetch to read a page. Give the URLs that you used under \"Sources:\" in your answer.")
        return ToolResult("\n".join(lines))
