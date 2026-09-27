"""The agent browser: a headless Chromium through Playwright (SPEC.md section 8.7).

The agent uses this browser to check its own changes. The user has a separate browser
(the Browser pane of the client).

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


def _first_line(error: Exception) -> str:
    text = str(error).strip()
    return text.splitlines()[0] if text else type(error).__name__


def data_url(image: bytes, mime: str = "image/jpeg") -> str:
    return f"data:{mime};base64,{base64.b64encode(image).decode('ascii')}"
