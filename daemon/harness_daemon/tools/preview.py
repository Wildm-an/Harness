"""The agent preview tools (SPEC.md section 8.7).

The agent starts the servers of launch.json and operates a browser, so that it can check
its own changes. The browser is its tab of the Browser pane of the user when the client can
host it, else a headless browser (preview.py). The tools use the preview host of the session (preview.py).

| Tool | Needs approval |
|---|---|
| ``preview_start`` | The first start of each command. The rule is ``server(<command>)``. |
| ``preview_navigate`` | Only for a URL that is not a server of launch.json. |
| All other tools | No. |
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from ..browser import BrowserError, data_url
from .base import Approval, Tool, ToolContext, ToolError, ToolResult, get_bool, get_int

if TYPE_CHECKING:
    from ..preview import PreviewHost

MAX_LOG_LINES = 500
MAX_ERRORS_SHOWN = 10
REF_RE = re.compile(r"^\[?(?:ref\s*=\s*)?(e\d+)\]?$", re.I)


def _host(ctx: ToolContext) -> "PreviewHost":
    host = ctx.preview
    if host is None:
        raise ToolError("The preview tools need a daemon session with servers. They are not available here.")
    return host


def _ref(args: dict[str, Any]) -> str:
    raw = str(args.get("ref") or "").strip()
    match = REF_RE.match(raw)
    if not match:
        raise ToolError(f"'{raw}' is not an element reference. Use a reference from preview_snapshot, for example e5.")
    return match.group(1).lower()


def _errors_text(errors: list[str], title: str) -> str:
    shown = errors[:MAX_ERRORS_SHOWN]
    text = f"{title}:\n" + "\n".join(f"- {e}" for e in shown)
    if len(errors) > len(shown):
        text += f"\n- ... and {len(errors) - len(shown)} more. Use preview_console to see all."
    return text


def _action_text(done: str, result: dict[str, Any]) -> str:
    lines = [done]
    if result["blocked"]:
        lines.append(
            f"The agent browser blocked a navigation to {', '.join(result['blocked'])}. It opens only the "
            "servers of launch.json. Use preview_navigate to open another URL. That needs approval.")
    if result["navigated"]:
        lines.append(f"The page changed to {result['url']}.")
    if result["errors"]:
        lines.append(_errors_text(result["errors"], "New console errors"))
    lines.append("Use preview_snapshot to see the page now.")
    return "\n".join(lines)


class _PreviewTool(Tool):
    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        try:
            return await self.act(_host(ctx), args, ctx)
        except BrowserError as e:
            raise ToolError(str(e)) from None

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        raise NotImplementedError


class PreviewStartTool(_PreviewTool):
    name = "preview_start"
    description = (
        "Start a server from .harness/launch.json, and wait until it is ready. With no name, start the "
        "default server. The result gives the server URL. Before you start a server, or add a new server "
        "to launch.json, call preview_servers: when a running server serves what you need, use it."
    )
    parameters = {
        "type": "object",
        "properties": {"name": {"type": "string", "description": "The server name. Optional."}},
    }
    needs_approval = True

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval | None:
        try:
            server = _host(ctx).find_server(args.get("name"))
        except BrowserError as e:
            raise ToolError(str(e)) from None
        if server.state in ("starting", "running"):
            return None
        config = server.config
        # The same rule and request input as a start from the Servers menu of the Browser pane.
        return Approval(key=config.command, rule=f"server({config.command})", tool="server",
                        input={"name": config.name, "command": config.command, "cwd": config.cwd})

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        server = host.find_server(args.get("name"))
        name = server.config.name
        if server.state not in ("starting", "running"):
            await host.servers.start(name, by="agent")
        await host.wait_started(server)
        if server.state == "running":
            return ToolResult(f"The server {name} is running at {host.server_url(server)}. "
                              "Open it with preview_navigate.")
        if server.state == "starting":
            return ToolResult(f"The server {name} is still starting. Read its output with preview_logs.")
        lines = [f"The server {name} is {server.state}."]
        if server.error:
            lines.append(server.error)
        tail = [f"[{stream}] {text}" for stream, text in list(server.logs)[-20:]]
        if tail:
            lines.append("The last lines of its output:\n" + "\n".join(tail))
        return ToolResult("\n".join(lines), is_error=True)


class PreviewServersTool(_PreviewTool):
    name = "preview_servers"
    description = (
        "List the servers of .harness/launch.json of this project: the name, the state, the URL, the "
        "command, and who started it. Call it before preview_start, and before you add a server to "
        "launch.json: use a running server when it serves what you need."
    )
    parameters = {"type": "object", "properties": {}}

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        exists = host.servers.reload()
        if not exists:
            return ToolResult("The project has no .harness/launch.json. Add a server to it, then start it with "
                              "preview_start.")
        servers = list(host.servers.servers.values())
        if not servers:
            return ToolResult("launch.json has no servers.")
        lines = ["The servers of .harness/launch.json:"]
        for s in servers:
            url = host.server_url(s) if s.state == "running" else None
            who = " (the agent started it)" if s.state in ("starting", "running") and s.started_by == "agent" else ""
            lines.append(f"- {s.config.name}: {s.state}{f' at {url}' if url else ''}{who}. Command: {s.config.command}"
                         + (" [default]" if s.config.default else ""))
        return ToolResult("\n".join(lines))


class PreviewStopTool(_PreviewTool):
    name = "preview_stop"
    description = "Stop a server of .harness/launch.json. With no name, stop all servers."
    parameters = {
        "type": "object",
        "properties": {"name": {"type": "string", "description": "The server name. Optional."}},
    }

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        name = str(args.get("name") or "").strip()
        if not name or name == "all":
            await host.servers.stop_all()
            return ToolResult("All servers are stopped.")
        server = host.find_server(name)
        await host.servers.stop(server.config.name)
        return ToolResult(f"The server {server.config.name} is stopped.")


class PreviewLogsTool(_PreviewTool):
    name = "preview_logs"
    description = (
        "Read the last output lines of a server. With no name, read the default server. "
        "Use it when a server does not start, or when a request fails."
    )
    parameters = {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "The server name. Optional."},
            "lines": {"type": "integer", "description": "The number of lines. The default is 50."},
        },
    }

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        server = host.find_server(args.get("name"))
        count = min(max(get_int(args, "lines", 50) or 50, 1), MAX_LOG_LINES)
        status = f"The server {server.config.name} is {server.state}"
        url = host.server_url(server) if server.state == "running" else None
        status += f" at {url}." if url else "."
        if server.error:
            status += f" {server.error}"
        lines = list(server.logs)[-count:]
        if not lines:
            return ToolResult(f"{status}\nThe server has no output.")
        body = "\n".join(f"[stderr] {text}" if stream == "stderr" else text for stream, text in lines)
        return ToolResult(f"{status}\nThe last {len(lines)} lines:\n{body}")


async def _page_card(host: "PreviewHost", info: dict[str, Any]) -> dict[str, Any]:
    """The browser card of the chat for a page that the agent opened: the URL, the title, the tab of
    the Browser pane (None for the headless browser), and a small picture of the page."""
    try:
        image: str | None = data_url(await host.browser.thumbnail())
    except Exception:  # noqa: BLE001 - the card shows with no picture.
        image = None
    return {"type": "browser", "url": info["url"], "title": info["title"], "tab": host.browser.tab, "image": image}


class PreviewNavigateTool(_PreviewTool):
    name = "preview_navigate"
    description = (
        "Open a page in the browser. In the desktop app, this is the Browser pane of the session: you and "
        "the user use the same tabs, see the same pages, and share the cookies. With 'tab', choose the tab "
        "first: an id from preview_tabs (to continue in a tab that the user opened for this task), or "
        "\"new\" for a new tab (when no open tab is about this task). Without 'tab', the page opens in the "
        "tab that you used last. Give a full URL, or a path such as /about. A path opens on the current "
        "page, or on the running server. The URLs of the servers in launch.json need no approval. Other "
        "URLs need approval."
    )
    parameters = {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "A full URL or a path."},
            "server": {"type": "string", "description": "A server name. The path opens on this server. Optional."},
            "tab": {"type": "string", "description": "Optional: a tab id from preview_tabs, or \"new\"."},
        },
        "required": ["url"],
    }
    needs_approval = True

    async def _url(self, host: "PreviewHost", args: dict[str, Any]) -> str:
        server = args.get("server")
        return await host.resolve_url(str(args.get("url") or ""), server if isinstance(server, str) else None)

    async def prepare(self, args: dict[str, Any], ctx: ToolContext) -> Approval | None:
        from ..preview import origin_of

        host = _host(ctx)
        try:
            url = await self._url(host, args)
        except BrowserError as e:
            raise ToolError(str(e)) from None
        if url.startswith(("about:", "data:")) or host.allowed(url):
            return None
        return Approval(key=url, rule=f"preview_navigate({origin_of(url)}/*)")

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        url = await self._url(host, args)
        if not url.startswith(("about:", "data:")) and not host.allowed(url):
            host.approve(url)  # The permission gate approved it.
        tab = str(args.get("tab") or "").strip() or None
        info = await host.browser.navigate(url, tab)
        await host.send_frame("navigate")
        status = info["status"]
        lines = [f"Opened {info['url']}" + (f" (HTTP {status})." if status else ".")]
        if info["title"]:
            lines.append(f"Title: {info['title']}")
        if status and status >= 400:
            lines.append(f"The server returned HTTP {status}. Read the server output with preview_logs.")
        errors = [e["text"] for e in await host.browser.console_messages() if e["level"] == "error"]
        if errors:
            lines.append(_errors_text(errors, "Console errors"))
        lines.append("Use preview_snapshot to read the page.")
        return ToolResult("\n".join(lines), is_error=bool(status and status >= 400), card=await _page_card(host, info))


class PreviewSnapshotTool(_PreviewTool):
    name = "preview_snapshot"
    description = (
        "Read the page of the agent browser as a text tree. Each element that you can click or "
        "fill has a reference, for example [ref=e5]. Use this tool before preview_screenshot: text "
        "uses less context."
    )
    parameters = {"type": "object", "properties": {}}

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        snap = await host.browser.snapshot()
        head = f"Page: {snap['title'] or '(no title)'}\nURL: {snap['url']}\n"
        body = "\n".join(snap["lines"]) or "(The page has no visible content.)"
        if snap["truncated"]:
            body += f"\n[The snapshot stops after {len(snap['lines'])} lines. The page has more content.]"
        return ToolResult(f"{head}\n{body}")


class PreviewClickTool(_PreviewTool):
    name = "preview_click"
    description = "Click an element of the agent browser page. Use a reference from preview_snapshot."
    parameters = {
        "type": "object",
        "properties": {"ref": {"type": "string", "description": "The element reference, for example e5."}},
        "required": ["ref"],
    }

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        ref = _ref(args)
        result = await host.browser.click(ref)
        await host.send_frame(f"click {ref}")
        return ToolResult(_action_text(f"Clicked {ref}.", result))


class PreviewFillTool(_PreviewTool):
    name = "preview_fill"
    description = (
        "Type text into a text box of the agent browser page. The text replaces the current value. "
        "For a select box, give the option text. Use a reference from preview_snapshot."
    )
    parameters = {
        "type": "object",
        "properties": {
            "ref": {"type": "string", "description": "The element reference, for example e5."},
            "text": {"type": "string", "description": "The text to type."},
            "submit": {"type": "boolean", "description": "If true, press Enter after the text. Optional."},
        },
        "required": ["ref", "text"],
    }

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        ref = _ref(args)
        submit = get_bool(args, "submit")
        result = await host.browser.fill(ref, str(args.get("text")), submit)
        await host.send_frame(f"fill {ref}")
        done = f"Typed the text into {ref}" + (" and pressed Enter." if submit else ".")
        return ToolResult(_action_text(done, result))


class PreviewConsoleTool(_PreviewTool):
    name = "preview_console"
    description = (
        "Read the browser console messages of the current page: errors, failed requests, and "
        "uncaught errors. Set level to all to also get warnings and logs."
    )
    parameters = {
        "type": "object",
        "properties": {
            "level": {"type": "string", "enum": ["error", "all"], "description": "error (the default) or all."},
        },
    }

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        show_all = str(args.get("level") or "error").lower() == "all"
        entries = await host.browser.console_messages()
        if not show_all:
            entries = [e for e in entries if e["level"] == "error"]
        if not entries:
            return ToolResult("There are no console messages." if show_all else "There are no console errors.")
        return ToolResult("\n".join(f"[{e['level']}] {e['text']}" for e in entries))


class PreviewScreenshotTool(_PreviewTool):
    name = "preview_screenshot"
    description = (
        "Take a screenshot of the agent browser page. Use preview_snapshot first: a screenshot uses "
        "much more context. Use a screenshot only to check the layout or the colors."
    )
    parameters = {
        "type": "object",
        "properties": {
            "full_page": {"type": "boolean", "description": "If true, capture the full page, not only the visible part."},
        },
    }

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        info = await host.browser.page_info()
        if info is None:
            raise ToolError("No page is open. Open a page with preview_navigate.")
        image = await host.browser.screenshot(full_page=get_bool(args, "full_page"))
        return ToolResult(f"A screenshot of {info['url']}. The image is in the next message.", image=data_url(image))


class PreviewTabsTool(_PreviewTool):
    name = "preview_tabs"
    description = (
        "List the tabs of the Browser pane of this session, or switch to one. You and the user use the same "
        "tabs. Before you open a page for a task, list the tabs: if the user opened a tab for this task, "
        "continue in it (give its id in 'use'), and read it with preview_snapshot. If no tab is about the "
        "task, open the page with preview_navigate and tab \"new\". Each tab has its id, URL, title, "
        "\"shown\" (the user sees it now), and \"used\" (you work in it)."
    )
    parameters = {
        "type": "object",
        "properties": {"use": {"type": "string", "description": "Optional: the id of a tab to work in, or \"new\"."}},
    }

    async def act(self, host: "PreviewHost", args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        use = str(args.get("use") or "").strip()
        if use:
            await host.browser.use_tab(use)
        tabs = await host.browser.tabs()
        if tabs is None:
            return ToolResult("The Browser pane is not available. The headless browser has one page: open it with "
                              "preview_navigate.")
        if not tabs:
            return ToolResult("The session has no tabs. Open a page with preview_navigate.")
        lines = [f"Now in the tab {use}." if use else "The tabs of this session:"]
        for t in tabs:
            marks = [m for m, on in (("shown", t.get("shown")), ("used", t.get("used"))) if on]
            lines.append(f"- {t.get('id')}: {t.get('title') or 'New tab'} {t.get('url') or '(no page)'}"
                         + (f" [{', '.join(marks)}]" if marks else ""))
        return ToolResult("\n".join(lines))


def preview_tools(image_input: bool) -> list[Tool]:
    tools: list[Tool] = [
        PreviewServersTool(), PreviewStartTool(), PreviewStopTool(), PreviewLogsTool(), PreviewTabsTool(), PreviewNavigateTool(),
        PreviewSnapshotTool(), PreviewClickTool(), PreviewFillTool(), PreviewConsoleTool(),
    ]
    if image_input:
        tools.append(PreviewScreenshotTool())
    return tools
