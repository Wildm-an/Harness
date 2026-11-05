"""The agent browser (SPEC.md section 8.7).

The agent uses a browser to check its own changes. It has two kinds:

- ``PaneBrowser``: a tab of the Browser pane of the user (the desktop app with a local daemon).
  The agent and the user see and use the same page. The client runs each DevTools protocol call
  in the tab (``browser.call``), so no debug port is open.
- ``AgentBrowser``: a headless Chromium through Playwright, when the pane is not available (a
  remote daemon, a normal browser, a session that the client does not show). It sends live
  frames of its page, so that the user can see what the agent does.

- Playwright runs in its own thread with its own event loop. On Windows, that loop is a
  ProactorEventLoop, because Playwright starts the browser as a subprocess.
- The browser starts on the first call, and it stops when the session closes.
- The browser opens only the URLs that ``allow_url`` accepts. Other page navigations
  are blocked. Requests for page resources (scripts, styles, images) are not blocked.
- A snapshot is a text tree of the page. Each element that the agent can operate has a
  reference, for example ``[ref=e5]``. ``click`` and ``fill`` use these references.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shlex
import subprocess
import threading
import time
from collections import deque
from typing import Any, Awaitable, Callable, TypeVar

from . import frozen

log = logging.getLogger("harness.browser")

T = TypeVar("T")

VIEWPORT = {"width": 1280, "height": 800}
NAVIGATE_TIMEOUT = 30_000  # Milliseconds.
ACTION_TIMEOUT = 5_000
SETTLE_MS = 400  # The wait after an action, so that the page can react.
CONSOLE_ENTRIES = 500
SNAPSHOT_LINES = 500
FRAME_QUALITY = 55
LIVE_QUALITY = 50
LIVE_SIZE = {"maxWidth": 800, "maxHeight": 500}  # The live frames are small: the rail and the pane show them.
LIVE_INTERVAL = 0.3  # Seconds between two live frames, at most.
SCREENSHOT_QUALITY = 70
ALWAYS_ALLOWED_SCHEMES = ("about:", "data:", "blob:")

INSTALL_HINT = (
    "The agent browser needs Playwright on the daemon computer. Install it with: "
    "pip install playwright, then: python -m playwright install chromium"
)
def chromium_hint() -> str:
    command = subprocess.list2cmdline(frozen.install_browser_argv()) if os.name == "nt"         else shlex.join(frozen.install_browser_argv())
    return f"Chromium for Playwright is not installed on the daemon computer. Install it with: {command}"
STALE_REF = "The element reference {ref} is not on the page. The page changed. Take a new snapshot with preview_snapshot."


class BrowserError(Exception):
    """A failure of the agent browser. The message goes to the model."""


# The page script for snapshots. It keeps the element references in window.__harness, so
# that the page DOM does not change. A new document (after a navigation) has no references.
# Its numbers start after the numbers of the earlier documents: an old reference never
# selects an element of a new page.
SNAPSHOT_JS = r"""
({ maxLines, startSeq }) => {
  const state = window.__harness || (window.__harness = { seq: startSeq, byRef: new Map(), byEl: new WeakMap() });
  const lines = [];
  let truncated = false;
  const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
    "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
    "spinbutton", "treeitem"]);
  // Roles that take their name from their text. The snapshot shows them as one line.
  const LEAF = new Set(["button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "treeitem", "switch", "checkbox", "radio", "img", "textbox", "searchbox", "combobox",
    "slider", "spinbutton", "progressbar", "columnheader", "rowheader"]);
  const TAG_ROLES = { nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
    aside: "complementary", form: "form", dialog: "dialog", ul: "list", ol: "list", li: "listitem",
    table: "table", tr: "row", th: "columnheader", td: "cell", fieldset: "group", summary: "button",
    textarea: "textbox", progress: "progressbar", iframe: "iframe", h1: "heading", h2: "heading",
    h3: "heading", h4: "heading", h5: "heading", h6: "heading" };
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link"]);
  const SEMANTIC = "a[href],button,input,select,textarea,[role],h1,h2,h3,h4,h5,h6,img,[contenteditable]," +
    "[tabindex],summary,ul,ol,table,nav,main,header,footer,form,dialog,iframe,[onclick]";

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const quote = (s) => JSON.stringify(s);

  function roleOf(el) {
    const explicit = clean(el.getAttribute("role"));
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "button") return "button";
    if (tag === "img") return "img";
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (tag === "section" && (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))) return "region";
    if (el.isContentEditable && el.hasAttribute("contenteditable")) return "textbox";
    return null;
  }

  function isHidden(el) {
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
    const style = getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
  }

  function isClickable(el) {
    if (el.hasAttribute("onclick")) return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    if (getComputedStyle(el).cursor !== "pointer") return false;
    // A pointer that the parent also has is not a separate target.
    const parent = el.parentElement;
    return !parent || getComputedStyle(parent).cursor !== "pointer";
  }

  function labelText(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label && clean(label.innerText)) return clean(label.innerText);
    }
    const wrap = el.closest("label");
    return wrap ? clean(wrap.innerText) : "";
  }

  function nameOf(el, role) {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = clean(by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean)
        .map((e) => e.innerText || e.textContent).join(" "));
      if (text) return text;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && ["button", "submit", "reset"].includes(type)) return clean(el.value || type);
      return labelText(el) || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title"));
    }
    if (tag === "img") return clean(el.getAttribute("alt") || el.getAttribute("title"));
    if (LEAF.has(role) || role === "cell" || role === "listitem" || !role) {
      const text = clean(el.innerText || el.textContent);
      if (text) return text;
    }
    return clean(el.getAttribute("title"));
  }

  function refOf(el) {
    let ref = state.byEl.get(el);
    if (!ref || state.byRef.get(ref) !== el) {
      ref = "e" + (++state.seq);
      state.byEl.set(el, ref);
      state.byRef.set(ref, el);
    }
    return ref;
  }

  function details(el, role) {
    const parts = [];
    const tag = el.tagName.toLowerCase();
    if (role === "heading") {
      const level = el.getAttribute("aria-level") || (/^h[1-6]$/.test(tag) ? tag[1] : "");
      if (level) parts.push(`[level=${level}]`);
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("[disabled]");
    const checked = el.checked === true || el.getAttribute("aria-checked") === "true";
    if (checked && ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) parts.push("[checked]");
    if (el.getAttribute("aria-selected") === "true") parts.push("[selected]");
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) parts.push(expanded === "true" ? "[expanded]" : "[collapsed]");
    if (el.required) parts.push("[required]");
    if (el.hasAttribute("aria-invalid") && el.getAttribute("aria-invalid") !== "false") parts.push("[invalid]");
    return parts.join(" ");
  }

  function valueOf(el, role) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const chosen = Array.from(el.selectedOptions || []).map((o) => clean(o.text)).join(", ");
      return chosen ? quote(cut(chosen, 100)) : "";
    }
    if (tag === "input" || tag === "textarea") {
      if ((el.getAttribute("type") || "").toLowerCase() === "password") return el.value ? quote("••••") : "";
      if (["textbox", "searchbox", "spinbutton", "slider", "combobox"].includes(role)) return el.value ? quote(cut(el.value, 200)) : "";
    }
    if (role === "textbox" && el.isContentEditable) {
      const text = clean(el.innerText);
      return text ? quote(cut(text, 200)) : "";
    }
    return "";
  }

  function push(depth, text) {
    if (lines.length >= maxLines) { truncated = true; return false; }
    lines.push("  ".repeat(depth) + "- " + text);
    return true;
  }

  function childrenOf(node) {
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    if (node.tagName && node.tagName.toLowerCase() === "slot") return node.assignedNodes({ flatten: true });
    return Array.from(node.childNodes);
  }

  function hasSemantic(el) {
    if (el.shadowRoot) return true;
    return !!el.querySelector(SEMANTIC);
  }

  function walk(node, depth) {
    for (const child of childrenOf(node)) {
      if (truncated) return;
      if (child.nodeType === Node.TEXT_NODE) {
        const text = clean(child.textContent);
        if (text) push(depth, "text: " + quote(cut(text, 300)));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child;
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag) || isHidden(el)) continue;
      let role = roleOf(el);
      if (role === "presentation" || role === "none" || role === "generic") role = null;
      if (tag === "svg" && !role) continue;

      if (!role) {
        if (isClickable(el)) {
          const name = cut(nameOf(el, null), 100);
          push(depth, `clickable ${quote(name)} [ref=${refOf(el)}]`);
          continue;
        }
        if (!hasSemantic(el)) {
          const text = clean(el.innerText);
          if (text) push(depth, "text: " + quote(cut(text, 300)));
          continue;
        }
        walk(el, depth);
        continue;
      }

      const name = cut(nameOf(el, role), 100);
      let line = role + (name ? " " + quote(name) : "");
      const extra = details(el, role);
      if (extra) line += " " + extra;
      if (INTERACTIVE.has(role) || isClickable(el)) line += ` [ref=${refOf(el)}]`;
      if (role === "link") {
        const href = el.getAttribute("href");
        if (href && !href.startsWith("javascript:")) line += " -> " + cut(href, 120);
      }
      if (role === "iframe") line += " (the snapshot does not include frames)";
      const value = valueOf(el, role);
      if (value) line += ": " + value;
      if (LEAF.has(role) || role === "iframe") {
        push(depth, line);
        continue;
      }
      if (!hasSemantic(el)) {
        // A container with text only, for example a list item or a table cell.
        const text = clean(el.innerText);
        push(depth, text && text !== name ? `${line}: ${quote(cut(text, 300))}` : line);
        continue;
      }
      if (!push(depth, line)) return;
      walk(el, depth + 1);
    }
  }

  if (document.body) walk(document.body, 0);
  return { lines, truncated, seq: state.seq };
}
"""

ELEMENT_JS = """(ref) => {
  const s = window.__harness;
  const el = s && s.byRef.get(ref);
  return el && el.isConnected ? el : null;
}"""

ELEMENT_KIND_JS = """(el) => ({
  tag: el.tagName.toLowerCase(),
  type: (el.getAttribute('type') || '').toLowerCase(),
  editable: el.isContentEditable,
})"""


class AgentBrowser:
    """One headless Chromium page. All public methods are coroutines of the caller loop."""

    def __init__(self, allow_url: Callable[[str], bool]):
        self.allow_url = allow_url
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._pw: Any = None
        self._browser: Any = None
        self._context: Any = None
        self._page: Any = None
        self._seq = 0  # The number of the last console entry.
        self._ref_seq = 0  # The number of the last element reference, for all documents.
        # The console messages of the current document. A new document clears them.
        self.console: deque[dict[str, Any]] = deque(maxlen=CONSOLE_ENTRIES)
        self.blocked: deque[str] = deque(maxlen=20)  # Navigations that the allow list blocked.
        # The live frames: the callback gets (url, JPEG bytes). It runs in the browser thread.
        self._on_live: Callable[[str, bytes], None] | None = None
        self._live_session: Any = None  # The CDP session of the page that sends the frames.
        self._live_sent = 0.0

    # -- the browser thread ---------------------------------------------------------

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self._loop is not None:
                return self._loop
            ready = threading.Event()

            def run() -> None:
                loop = asyncio.ProactorEventLoop() if os.name == "nt" else asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                self._loop = loop
                ready.set()
                try:
                    loop.run_forever()
                finally:
                    loop.close()

            self._thread = threading.Thread(target=run, name="agent-browser", daemon=True)
            self._thread.start()
            ready.wait()
            assert self._loop is not None
            return self._loop

    async def _call(self, fn: Callable[[], Awaitable[T]]) -> T:
        """Run ``fn`` in the browser loop. A cancel of the caller also cancels ``fn``."""
        loop = self._ensure_loop()
        future = asyncio.run_coroutine_threadsafe(fn(), loop)
        return await asyncio.wrap_future(future)

    @property
    def started(self) -> bool:
        return self._page is not None

    # -- the page (these run in the browser loop) -------------------------------------

    async def _ensure_page(self) -> Any:
        if self._page is not None and not self._page.is_closed():
            return self._page
        if self._browser is None:
            try:
                from playwright.async_api import async_playwright
            except ImportError:
                raise BrowserError(INSTALL_HINT) from None
            self._pw = await async_playwright().start()
            try:
                self._browser = await self._pw.chromium.launch(headless=True)
            except Exception as e:  # noqa: BLE001 - Playwright raises its own Error type.
                await self._pw.stop()
                self._pw = None
                if "Executable doesn't exist" in str(e) or "playwright install" in str(e):
                    raise BrowserError(chromium_hint()) from None
                raise BrowserError(f"The agent browser did not start: {e}") from None
            self._context = await self._browser.new_context(viewport=VIEWPORT)
            self._context.on("page", self._adopt)
            await self._context.route("**/*", self._route)
        page = await self._context.new_page()
        self._adopt(page)
        return page

    def _adopt(self, page: Any) -> None:
        """Watch a page. A new page (for example, a link with target=_blank) becomes the active page."""
        if page is self._page:
            return
        self._page = page
        page.set_default_timeout(ACTION_TIMEOUT)
        page.set_default_navigation_timeout(NAVIGATE_TIMEOUT)
        page.on("console", self._on_console)
        page.on("pageerror", lambda error: self._log("error", f"Uncaught error: {error}"))
        page.on("requestfailed", self._on_request_failed)
        page.on("dialog", self._on_dialog)
        if self._on_live is not None:
            asyncio.ensure_future(self._start_live(page))

    # -- live frames (these run in the browser loop) -----------------------------------------

    async def _start_live(self, page: Any) -> None:
        await self._stop_live()
        if self._context is None or page.is_closed():
            return
        try:
            session = await self._context.new_cdp_session(page)
            self._live_session = session
            session.on("Page.screencastFrame", lambda frame: asyncio.ensure_future(self._on_frame(session, page, frame)))
            await session.send("Page.startScreencast", {"format": "jpeg", "quality": LIVE_QUALITY, **LIVE_SIZE})
        except Exception as e:  # noqa: BLE001 - the frames are only for the user.
            log.debug("No live frames: %s", e)

    async def _on_frame(self, session: Any, page: Any, frame: dict[str, Any]) -> None:
        try:
            await session.send("Page.screencastFrameAck", {"sessionId": frame["sessionId"]})
        except Exception:  # noqa: BLE001 - the page closed.
            return
        now = time.monotonic()
        callback = self._on_live
        if callback is None or now - self._live_sent < LIVE_INTERVAL:
            return
        self._live_sent = now
        try:
            callback(page.url, base64.b64decode(frame["data"]))
        except Exception:  # noqa: BLE001
            pass

    async def _stop_live(self) -> None:
        session, self._live_session = self._live_session, None
        if session is None:
            return
        try:
            await session.send("Page.stopScreencast")
            await session.detach()
        except Exception:  # noqa: BLE001 - the page can be gone.
            pass

    async def set_live(self, callback: Callable[[str, bytes], None] | None) -> None:
        """Start (a callback) or stop (None) the live frames of the page."""
        async def run() -> None:
            self._on_live = callback
            if callback is None:
                await self._stop_live()
            elif self._page is not None and not self._page.is_closed() and self._live_session is None:
                await self._start_live(self._page)
        if self._loop is not None:
            await self._call(run)
        else:
            self._on_live = callback

    def _log(self, level: str, text: str) -> None:
        self._seq += 1
        self.console.append({"seq": self._seq, "level": level, "text": text, "time": time.time()})

    def _on_console(self, message: Any) -> None:
        level = message.type
        level = {"warning": "warn", "assert": "error"}.get(level, level)
        text = message.text
        location = message.location or {}
        if location.get("url"):
            text += f"  ({location['url']}:{location.get('lineNumber', 0) + 1})"
        self._log(level, text)

    def _on_request_failed(self, request: Any) -> None:
        failure = request.failure or "failed"
        if "ERR_ABORTED" in failure:
            return  # The page stopped the request, for example a navigation to a new page.
        self._log("error", f"Request failed: {request.method} {request.url} ({failure})")

    async def _on_dialog(self, dialog: Any) -> None:
        self._log("info", f"The page showed a {dialog.type} dialog: {dialog.message!r}. The browser closed it.")
        try:
            if dialog.type == "alert":
                await dialog.accept()
            else:
                await dialog.dismiss()
        except Exception:  # noqa: BLE001 - the dialog can be gone.
            pass

    async def _route(self, route: Any) -> None:
        request = route.request
        url = request.url
        allowed = url.startswith(ALWAYS_ALLOWED_SCHEMES) or self.allow_url(url)
        try:
            is_page = request.is_navigation_request() and request.frame.parent_frame is None
        except Exception:  # noqa: BLE001 - a request of a closed page.
            is_page = False
        if is_page and not allowed:
            self.blocked.append(url)
            # "aborted" keeps the current page. "blockedbyclient" shows a Chrome error page.
            await route.abort("aborted")
            return
        if is_page:
            self.console.clear()  # A new document starts.
        await route.continue_()

    async def _settle(self, page: Any) -> None:
        try:
            await page.wait_for_load_state("load", timeout=ACTION_TIMEOUT)
        except Exception:  # noqa: BLE001 - a slow page is not an error.
            pass
        await page.wait_for_timeout(SETTLE_MS)

    async def _element(self, ref: str) -> Any:
        page = self._page
        if page is None or page.is_closed():
            raise BrowserError("No page is open. Open a page with preview_navigate.")
        handle = await page.evaluate_handle(ELEMENT_JS, ref)
        element = handle.as_element()
        if element is None:
            await handle.dispose()
            raise BrowserError(STALE_REF.format(ref=ref))
        return element

    # -- the public methods --------------------------------------------------------------

    async def navigate(self, url: str) -> dict[str, Any]:
        """Open a URL. Return the final URL, the title, and the HTTP status."""
        async def run() -> dict[str, Any]:
            page = await self._ensure_page()
            self.console.clear()
            self.blocked.clear()
            try:
                response = await page.goto(url, wait_until="load")
            except Exception as e:  # noqa: BLE001
                if url in self.blocked:
                    raise BrowserError(f"The agent browser blocked {url}.") from None
                raise BrowserError(f"The page did not load: {_first_line(e)}") from None
            await page.wait_for_timeout(SETTLE_MS)
            return {"url": page.url, "title": await page.title(),
                    "status": response.status if response is not None else None}
        return await self._call(run)

    async def snapshot(self) -> dict[str, Any]:
        async def run() -> dict[str, Any]:
            page = self._page
            if page is None or page.is_closed():
                raise BrowserError("No page is open. Open a page with preview_navigate.")
            try:
                result = await page.evaluate(SNAPSHOT_JS, {"maxLines": SNAPSHOT_LINES, "startSeq": self._ref_seq})
            except Exception as e:  # noqa: BLE001 - for example, the page navigates now.
                raise BrowserError(f"The snapshot failed: {_first_line(e)}. Try again.") from None
            self._ref_seq = max(self._ref_seq, int(result.pop("seq")))
            return {"url": page.url, "title": await page.title(), **result}
        return await self._call(run)

    async def click(self, ref: str) -> dict[str, Any]:
        async def run() -> dict[str, Any]:
            element = await self._element(ref)
            page = self._page
            before, mark = page.url, self._seq
            self.blocked.clear()
            try:
                await element.click(timeout=ACTION_TIMEOUT)
            except Exception as e:  # noqa: BLE001
                raise BrowserError(f"The click on {ref} failed: {_first_line(e)}") from None
            finally:
                await element.dispose()
            await self._settle(self._page)
            return self._after(before, mark)
        return await self._call(run)

    async def fill(self, ref: str, text: str, submit: bool = False) -> dict[str, Any]:
        async def run() -> dict[str, Any]:
            element = await self._element(ref)
            page = self._page
            before, mark = page.url, self._seq
            self.blocked.clear()
            try:
                kind = await element.evaluate(ELEMENT_KIND_JS)
                if kind["tag"] == "select":
                    try:
                        await element.select_option(label=text, timeout=ACTION_TIMEOUT)
                    except Exception:  # noqa: BLE001 - try the option value.
                        await element.select_option(value=text, timeout=ACTION_TIMEOUT)
                elif kind["type"] in ("checkbox", "radio"):
                    raise BrowserError(f"{ref} is a {kind['type']}. Use preview_click to change it.")
                else:
                    await element.fill(text, timeout=ACTION_TIMEOUT)
                if submit:
                    await element.press("Enter", timeout=ACTION_TIMEOUT)
            except BrowserError:
                raise
            except Exception as e:  # noqa: BLE001
                raise BrowserError(f"The fill of {ref} failed: {_first_line(e)}") from None
            finally:
                await element.dispose()
            await self._settle(self._page)
            return self._after(before, mark)
        return await self._call(run)

    def _after(self, before: str, mark: int) -> dict[str, Any]:
        """The result of an action: the new URL, the blocked URLs, and the new console errors."""
        page = self._page
        errors = [e["text"] for e in self.console if e["seq"] > mark and e["level"] == "error"]
        return {"url": page.url, "navigated": page.url != before, "blocked": list(self.blocked), "errors": errors}

    async def console_messages(self) -> list[dict[str, Any]]:
        async def run() -> list[dict[str, Any]]:
            return [dict(e) for e in self.console]
        return await self._call(run) if self._loop else []

    async def screenshot(self, full_page: bool = False, quality: int = SCREENSHOT_QUALITY) -> bytes:
        async def run() -> bytes:
            page = self._page
            if page is None or page.is_closed():
                raise BrowserError("No page is open. Open a page with preview_navigate.")
            return await page.screenshot(type="jpeg", quality=quality, full_page=full_page)
        return await self._call(run)

    async def page_info(self) -> dict[str, Any] | None:
        async def run() -> dict[str, Any] | None:
            page = self._page
            if page is None or page.is_closed():
                return None
            return {"url": page.url, "title": await page.title()}
        return await self._call(run) if self._loop else None

    async def _shutdown(self) -> None:
        for close in (lambda: self._browser and self._browser.close(), lambda: self._pw and self._pw.stop()):
            try:
                result = close()
                if result:
                    await result
            except Exception:  # noqa: BLE001 - the browser can be gone.
                pass
        self._pw = self._browser = self._context = self._page = None
        self._live_session = None

    async def close(self) -> None:
        loop = self._loop
        if loop is None:
            return
        try:
            await asyncio.wait_for(self._call(self._shutdown), 10)
        except Exception:  # noqa: BLE001
            log.warning("The agent browser did not close cleanly.")
        self._stop_loop(loop)

    def close_now(self) -> None:
        """Stop the browser from any thread, with no event loop. For a daemon that stops."""
        loop = self._loop
        if loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._shutdown(), loop).result(timeout=5)
        except Exception:  # noqa: BLE001
            pass
        self._stop_loop(loop)

    def _stop_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            if self._loop is loop:
                self._loop = None
        loop.call_soon_threadsafe(loop.stop)


# The page script of a tab of the Browser pane: it keeps the console messages of the page for
# preview_console. It runs before the scripts of each new document, and one time in the current one.
CONSOLE_HOOK_JS = r"""
(() => {
  if (window.__harnessLog) return;
  const entries = (window.__harnessLog = []);
  window.__harnessDoc = Math.random().toString(36).slice(2);
  let seq = 0;
  const text = (a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack || String(a);
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  const push = (level, message) => {
    entries.push({ seq: ++seq, level, text: String(message).slice(0, 2000), time: Date.now() / 1000 });
    if (entries.length > 500) entries.shift();
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = function (...args) {
      try { push(level, args.map(text).join(" ")); } catch {}
      return original.apply(this, args);
    };
  }
  addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) push("error", "Request failed: " + (t.src || t.href));
    else push("error", "Uncaught error: " + (e.error && e.error.stack ? e.error.stack : e.message));
  }, true);
  addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    push("error", "Uncaught error (in promise): " + (r && (r.stack || r.message) ? (r.stack || r.message) : String(r)));
  });
})()
"""

STATE_JS = """(() => ({
  url: location.href,
  title: document.title,
  doc: window.__harnessDoc || "",
  seq: (window.__harnessLog || []).reduce((m, e) => Math.max(m, e.seq), 0),
}))()"""

STATUS_JS = """(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  return nav && nav.responseStatus ? nav.responseStatus : null;
})()"""

# The middle of an element in the viewport, after a scroll to it. "hit": the point is on the element.
POINT_JS = """(ref) => {
  const s = window.__harness;
  const el = s && s.byRef.get(ref);
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  return { x, y, width: r.width, height: r.height, hit: !!hit && (hit === el || el.contains(hit)) };
}"""

CLICK_JS = """(ref) => {
  window.__harness.byRef.get(ref).click();
  return true;
}"""

# Focus a field and select its text, so that the typed text replaces it. A select box gets its option here.
FILL_JS = """([ref, text]) => {
  const s = window.__harness;
  const el = s && s.byRef.get(ref);
  if (!el || !el.isConnected) return { error: "stale" };
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "select") {
    const options = Array.from(el.options);
    const option = options.find((o) => o.text.trim() === text) || options.find((o) => o.value === text);
    if (!option) return { error: "option" };
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { kind: "select" };
  }
  if (tag === "input" && (type === "checkbox" || type === "radio")) return { error: "check", type };
  el.scrollIntoView({ block: "center" });
  el.focus();
  if ((tag === "input" || tag === "textarea") && typeof el.select === "function") el.select();
  else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return { kind: "text" };
}"""

ENTER = {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13}
BACKSPACE = {"key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8}

Call = Callable[[str, dict[str, Any], float], Awaitable[dict[str, Any]]]


class PaneBrowser:
    """The agent works in its tab of the Browser pane of the user.

    ``call(method, params, timeout)`` runs a DevTools protocol method in the tab (the client
    relays it) and returns its result. The result has the tab id in ``__tab``. A new tab id
    means that the client made a new tab (for example, the user closed the old tab).
    """

    def __init__(self, call: Call, allow_url: Callable[[str], bool]):
        self._send = call
        self.allow_url = allow_url
        self._tab: str | None = None  # The tab that has the console hook.
        self._ref_seq = 0
        self.started = False  # The agent opened a page in the tab.

    async def _call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 15) -> dict[str, Any]:
        result = await self._send(method, params or {}, timeout)
        tab = result.pop("__tab", None)
        if tab and tab != self._tab:
            # A new tab: it needs the console hook for each new document.
            self._tab = tab
            await self._send("Page.enable", {}, 10)  # The new document scripts need it.
            await self._send("Page.addScriptToEvaluateOnNewDocument", {"source": CONSOLE_HOOK_JS}, 10)
        return result

    async def _eval(self, expression: str, timeout: float = 15) -> Any:
        result = await self._call("Runtime.evaluate", {"expression": expression, "returnByValue": True,
                                                       "awaitPromise": True}, timeout)
        details = result.get("exceptionDetails")
        if details:
            text = (details.get("exception") or {}).get("description") or details.get("text") or "error"
            raise BrowserError(f"The page script failed: {str(text).splitlines()[0]}")
        return (result.get("result") or {}).get("value")

    async def _run(self, fn_js: str, arg: Any, timeout: float = 15) -> Any:
        return await self._eval(f"({fn_js})({json.dumps(arg)})", timeout)

    async def _state(self) -> dict[str, Any]:
        return await self._eval(STATE_JS) or {}

    async def _wait_ready(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        await asyncio.sleep(SETTLE_MS / 1000)
        while time.monotonic() < deadline:
            try:
                state = await self._eval("document.readyState", 5)
            except BrowserError:
                state = None  # The page changes now.
            if state == "complete":
                return
            await asyncio.sleep(0.1)

    def _require(self) -> None:
        if not self.started:
            raise BrowserError("No page is open. Open a page with preview_navigate.")

    async def navigate(self, url: str) -> dict[str, Any]:
        await self._eval(CONSOLE_HOOK_JS)  # The first call makes the tab.
        result = await self._call("Page.navigate", {"url": url}, NAVIGATE_TIMEOUT / 1000)
        error = result.get("errorText")
        if error and error != "net::ERR_ABORTED":
            raise BrowserError(f"The page did not load: {error}")
        self.started = True
        await self._wait_ready(NAVIGATE_TIMEOUT / 1000)
        await self._eval(CONSOLE_HOOK_JS)
        state = await self._state()
        status = await self._eval(STATUS_JS)
        return {"url": state.get("url", url), "title": state.get("title", ""), "status": status}

    async def snapshot(self) -> dict[str, Any]:
        self._require()
        result = await self._run(SNAPSHOT_JS, {"maxLines": SNAPSHOT_LINES, "startSeq": self._ref_seq})
        if not isinstance(result, dict):
            raise BrowserError("The snapshot failed. Try again.")
        self._ref_seq = max(self._ref_seq, int(result.pop("seq")))
        state = await self._state()
        return {"url": state.get("url", ""), "title": state.get("title", ""), **result}

    async def click(self, ref: str) -> dict[str, Any]:
        self._require()
        before = await self._state()
        point = await self._run(POINT_JS, ref)
        if point is None:
            raise BrowserError(STALE_REF.format(ref=ref))
        if point["hit"] and point["width"] > 0 and point["height"] > 0:
            # A real mouse click, as the user makes it.
            at = {"x": point["x"], "y": point["y"]}
            await self._call("Input.dispatchMouseEvent", {"type": "mouseMoved", **at})
            for kind in ("mousePressed", "mouseReleased"):
                await self._call("Input.dispatchMouseEvent", {"type": kind, **at, "button": "left", "clickCount": 1})
        else:
            await self._run(CLICK_JS, ref)  # Another element covers it, or it has no size.
        return await self._after(before)

    async def fill(self, ref: str, text: str, submit: bool = False) -> dict[str, Any]:
        self._require()
        before = await self._state()
        kind = await self._run(FILL_JS, [ref, text])
        error = (kind or {}).get("error")
        if kind is None or error == "stale":
            raise BrowserError(STALE_REF.format(ref=ref))
        if error == "option":
            raise BrowserError(f"The select box {ref} has no option {text!r}.")
        if error == "check":
            raise BrowserError(f"{ref} is a {kind['type']}. Use preview_click to change it.")
        if kind.get("kind") == "text":
            if text:
                await self._call("Input.insertText", {"text": text})
            else:
                for kind_ in ("keyDown", "keyUp"):
                    await self._call("Input.dispatchKeyEvent", {"type": kind_, **BACKSPACE})
        if submit:
            await self._call("Input.dispatchKeyEvent", {"type": "keyDown", **ENTER, "text": "\r"})
            await self._call("Input.dispatchKeyEvent", {"type": "keyUp", **ENTER})
        return await self._after(before)

    async def _after(self, before: dict[str, Any]) -> dict[str, Any]:
        """The result of an action: the new URL, the blocked URLs, and the new console errors."""
        await self._wait_ready(ACTION_TIMEOUT / 1000)
        await self._eval(CONSOLE_HOOK_JS)
        state = await self._state()
        url = state.get("url", "")
        blocked: list[str] = []
        if url != before.get("url") and url.startswith(("http:", "https:")) and not self.allow_url(url):
            # The agent opens only the allowed sites. The tab goes back to the page before.
            blocked.append(url)
            await self._eval("history.back()")
            await self._wait_ready(ACTION_TIMEOUT / 1000)
            await self._eval(CONSOLE_HOOK_JS)
            state = await self._state()
            url = state.get("url", "")
        mark = before.get("seq", 0) if state.get("doc") == before.get("doc") else 0
        errors = [e["text"] for e in await self.console_messages() if e["seq"] > mark and e["level"] == "error"]
        return {"url": url, "navigated": url != before.get("url"), "blocked": blocked, "errors": errors}

    async def console_messages(self) -> list[dict[str, Any]]:
        if not self.started:
            return []
        entries = await self._eval("window.__harnessLog || []")
        return [dict(e) for e in entries or []]

    async def screenshot(self, full_page: bool = False, quality: int = SCREENSHOT_QUALITY) -> bytes:
        self._require()
        params: dict[str, Any] = {"format": "jpeg", "quality": quality}
        if full_page:
            metrics = await self._call("Page.getLayoutMetrics")
            size = metrics.get("cssContentSize") or metrics.get("contentSize") or {}
            params["captureBeyondViewport"] = True
            params["clip"] = {"x": 0, "y": 0, "width": size.get("width", VIEWPORT["width"]),
                              "height": min(size.get("height", VIEWPORT["height"]), 16_000), "scale": 1}
        result = await self._call("Page.captureScreenshot", params, 30)
        return base64.b64decode(result.get("data") or "")

    async def page_info(self) -> dict[str, Any] | None:
        if not self.started:
            return None
        state = await self._state()
        return {"url": state.get("url", ""), "title": state.get("title", "")}

    async def close(self) -> None:
        """The tab stays open: the user can use it."""
        self.started = False


def _first_line(error: Exception) -> str:
    text = str(error).strip()
    return text.splitlines()[0] if text else type(error).__name__


def data_url(image: bytes, mime: str = "image/jpeg") -> str:
    return f"data:{mime};base64,{base64.b64encode(image).decode('ascii')}"
