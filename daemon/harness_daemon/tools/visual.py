"""The ``show_visual`` tool: the agent shows an interactive visual (HTML or SVG) in the chat.

This is the ``show_widget`` tool of the Claude desktop app. The tool only checks the code. The
client reads the code from the tool call and draws it in the chat in a sandboxed iframe (client
``VisualBlock.tsx``). The tool changes no file and needs no approval.

The iframe loads the page ``/visual-frame`` of the daemon (``FRAME_HTML``). The page has its own
Content Security Policy (``FRAME_CSP``): inline scripts and the CDNs of ``ALLOWED_CDNS`` can run,
but the page has no network access. The app CSP does not let inline scripts run, and an
``about:srcdoc`` frame gets the CSP of its parent. The client sends the full document to the page
with ``postMessage``, and the page writes it into itself.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from .base import Tool, ToolContext, ToolError, ToolResult

# The script and style hosts that a visual can load from. Keep this list the same as FRAME_CSP.
ALLOWED_CDNS = ("cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com")
_CDN_SOURCES = " ".join(f"https://{host}" for host in ALLOWED_CDNS)
MAX_VISUAL_CODE = 200_000  # Characters. The visual goes to the client in the tool call.
TITLE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

# The CSP of the frame page. "sandbox" also applies if the iframe loses its sandbox attribute.
FRAME_CSP = (
    "default-src 'none'; "
    f"script-src 'unsafe-inline' {_CDN_SOURCES}; "
    f"style-src 'unsafe-inline' https://fonts.googleapis.com {_CDN_SOURCES}; "
    f"font-src data: https://fonts.gstatic.com {_CDN_SOURCES}; "
    "img-src data: blob:; media-src data: blob:; "
    "connect-src 'none'; form-action 'none'; base-uri 'none'; "
    "sandbox allow-scripts"
)

# The frame page: it waits for the document of the visual from its parent, and writes it.
# document.open() keeps the document, so the CSP of the page stays in force.
FRAME_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>Visual</title></head><body><script>
addEventListener("message", function (e) {
  if (e.source !== parent || !e.data || e.data.type !== "harness-visual-doc" || typeof e.data.html !== "string") return;
  document.open();
  document.write(e.data.html);
  document.close();
});
parent.postMessage({ type: "harness-visual-ready" }, "*");
</script></body></html>
"""

_EXTERNAL_REF = re.compile(r"<(script|link)\b[^>]*?\b(?:src|href)\s*=\s*[\"']?([^\"'\s>]+)", re.IGNORECASE)


def blocked_sources(code: str) -> list[str]:
    """The script and stylesheet URLs of the code that are not on a host of ALLOWED_CDNS."""
    blocked = []
    for _tag, url in _EXTERNAL_REF.findall(code):
        parsed = urlparse(url if not url.startswith("//") else "https:" + url)
        if parsed.scheme == "https" and parsed.hostname in ALLOWED_CDNS:
            continue
        if parsed.scheme == "https" and parsed.hostname in ("fonts.googleapis.com", "fonts.gstatic.com"):
            continue
        blocked.append(url)
    return blocked


class ShowVisualTool(Tool):
    name = "show_visual"
    description = (
        "Show an interactive visual in the chat: an HTML fragment, or one raw <svg> element. Use it "
        "for a diagram, a chart, a small demo, or a set of choices with buttons. The user sees it "
        "below your message. Follow these rules:\n"
        "- Give a fragment only. Do not write <!DOCTYPE>, <html>, <head>, or <body>.\n"
        "- Use these CSS variables for all colors and fonts. They change with the light and the dark "
        "theme: --color-text, --color-text-muted, --color-surface, --color-surface-2, "
        "--color-border, --color-accent, --color-accent-text, --color-success, --color-danger, "
        "--color-warning, --font-sans, --font-mono, --radius. Example: color: var(--color-text). "
        "Do not use fixed colors for text, lines, or backgrounds.\n"
        "- Use a flat style: no gradients, no large shadows. The page background is transparent.\n"
        "- Do not use vh units. The frame gets the height of its content.\n"
        "- Scripts and styles can load only from cdnjs.cloudflare.com, cdn.jsdelivr.net, and "
        "unpkg.com. fetch and other network calls do not work.\n"
        "- Call sendPrompt(text) in a button click to send text as the next prompt of the user.\n"
        "- Keep the code short. Do not repeat the visual in your text reply."
    )
    parameters = {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "A short snake_case name for the visual, for example loader_options.",
            },
            "code": {
                "type": "string",
                "description": "The HTML fragment or the <svg> element.",
            },
        },
        "required": ["title", "code"],
    }

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        title = args.get("title")
        code = args.get("code")
        if not isinstance(title, str) or not TITLE_PATTERN.match(title.strip()):
            raise ToolError("title must be a snake_case name: lowercase letters, digits, and _ (for example loader_options).")
        if not isinstance(code, str) or not code.strip():
            raise ToolError("code is empty. Give an HTML fragment or an <svg> element.")
        if len(code) > MAX_VISUAL_CODE:
            raise ToolError(f"code has {len(code)} characters. The limit is {MAX_VISUAL_CODE}. Make the visual smaller.")
        blocked = blocked_sources(code)
        if blocked:
            raise ToolError(
                f"The visual cannot load {', '.join(blocked[:3])}. "
                f"Scripts and styles can load only from {', '.join(ALLOWED_CDNS)}. Put other code inline."
            )
        return ToolResult(f"Showed the visual {title.strip()} in the chat. The user can see it now.")
