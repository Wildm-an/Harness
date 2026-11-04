"""Web search and web fetch for the agent (tools/web.py), as WebSearch and WebFetch in Claude Code.

Fetch: an http or https page as text. HTML becomes text in the Markdown form, a PDF becomes its
text, and an image goes to the model as an image. A redirect to another host does not continue:
the result gives the new URL, so that the user approves the new host.

Search: the ``web_search`` setting selects the provider:

- ``duckduckgo`` (the default): no key. It reads the HTML page of DuckDuckGo.
- ``brave``: the Brave Search API, with an API key.
- ``tavily``: the Tavily API, with an API key.
- ``searxng``: a SearXNG server (the ``web_search_url`` setting) with the JSON format on.
- ``off``: the agent has no web_search tool.

The client keeps the API keys in the keychain and sends them with the message ``web.key``.
The daemon keeps them in memory only.
"""

from __future__ import annotations

import base64
import re
import time
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Callable
from urllib.parse import parse_qs, urljoin, urlparse

import httpx

from . import __version__

PROVIDERS = ("duckduckgo", "brave", "tavily", "searxng", "off")
KEY_PROVIDERS = ("brave", "tavily")
DEFAULT_PROVIDER = "duckduckgo"

FETCH_TIMEOUT = 20.0  # Seconds for one request.
MAX_BYTES = 5_000_000  # The largest page that the agent can fetch.
MAX_REDIRECTS = 10
CACHE_SECONDS = 15 * 60  # The agent can read the next part of a page with no new request.
CACHE_SIZE = 32
MAX_RESULTS = 20
DEFAULT_RESULTS = 8
USER_AGENT = f"Mozilla/5.0 (compatible; Harness/{__version__})"
IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")
TEXT_TYPES = ("application/json", "application/xml", "application/javascript", "application/x-javascript",
              "application/ld+json", "application/rss+xml", "application/atom+xml", "application/x-yaml")

# The API keys from the keychain of the client: {"brave": "...", "tavily": "..."}.
WEB_KEYS: dict[str, str] = {}

# A test can replace the transport of the HTTP clients.
Transport = Callable[[], httpx.AsyncBaseTransport | None]
_transport: Transport = lambda: None  # noqa: E731


class WebError(Exception):
    """A failure of a fetch or a search. The message goes to the model."""


def set_key(provider: str, key: str | None) -> None:
    if provider not in KEY_PROVIDERS:
        raise ValueError(f"'provider' must be one of: {', '.join(KEY_PROVIDERS)}.")
    if key and key.strip():
        WEB_KEYS[provider] = key.strip()
    else:
        WEB_KEYS.pop(provider, None)


def _client(**kwargs: Any) -> httpx.AsyncClient:
    transport = _transport()
    if transport is not None:
        kwargs["transport"] = transport
    return httpx.AsyncClient(timeout=FETCH_TIMEOUT, headers={"User-Agent": USER_AGENT}, **kwargs)


# -- URLs and domains --------------------------------------------------------------------------------


def normalize_url(raw: str) -> str:
    """A full http or https URL. A URL with no scheme gets https. Raise WebError for other URLs."""
    url = (raw or "").strip()
    if not url:
        raise WebError("Give a URL, for example https://example.com/docs.")
    if "://" not in url:
        scheme = re.match(r"([a-zA-Z][\w+.-]*):(?!\d)", url)  # "mailto:x", but not "localhost:3000".
        if scheme:
            raise WebError(f"Only http and https URLs can be fetched, not {scheme.group(1).lower()}: URLs.")
        url = "https://" + url
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise WebError(f"Only http and https URLs can be fetched, not {parsed.scheme}: URLs.")
    if not parsed.hostname:
        raise WebError(f"'{raw}' is not a full URL. Give a URL such as https://example.com/docs.")
    return url


def host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def _bare(host: str) -> str:
    return host[4:] if host.startswith("www.") else host


def same_site(a: str, b: str) -> bool:
    """True if two hosts are the same, with or without "www."."""
    return _bare(a) == _bare(b)


def clean_domain(raw: str) -> str:
    """"https://www.Example.com/docs" -> "example.com"."""
    text = (raw or "").strip().lower()
    if "://" in text:
        text = urlparse(text).hostname or ""
    text = text.split("/")[0].split(":")[0].lstrip(".")
    return _bare(text)


def domain_matches(url: str, domains: list[str]) -> bool:
    host = _bare(host_of(url))
    return any(host == d or host.endswith("." + d) for d in domains if d)


# -- HTML to text ------------------------------------------------------------------------------------

SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "head", "select", "button"}
BLOCK_TAGS = {"p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "form", "figure",
              "figcaption", "table", "thead", "tbody", "tfoot", "ul", "ol", "dl", "dt", "dd", "blockquote",
              "details", "summary", "address", "fieldset", "hr", "center"}
VOID_TAGS = {"br", "img", "hr", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"}
MAIN_TAGS = ("main", "article")
MIN_MAIN_CHARS = 400  # A <main> or <article> with less text than this is not the page content.


class _TextParser(HTMLParser):
    """HTML to text in the Markdown form: headings, lists, links, code, and tables."""

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title = ""
        self._in_title = False
        self._skip = 0  # The depth in tags that have no text for the reader.
        self._pre = 0
        self._main = 0  # The depth in <main>, <article>, or an element with role="main".
        self._open: dict[str, int] = {}  # The open elements of each tag name.
        self._main_ends: list[tuple[str, int]] = []  # The tag and depth of each open main element.
        self.all: list[str] = []
        self.main: list[str] = []
        # (href, the start of the link text in self.all, and in self.main if the link is in the main content)
        self._link: tuple[str, int, int | None] | None = None
        self._lists: list[list[Any]] = []  # [kind, number] for each open list.
        self._cells = 0
        self._after_mark = False  # No text came after the last list mark.

    # The text goes to the full page, and also to the main content inside <main>, <article>, or role="main".
    def _out(self, text: str) -> None:
        self.all.append(text)
        if self._main:
            self.main.append(text)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: v or "" for k, v in attrs}
        if tag == "title":
            self._in_title = True
            return
        if tag in SKIP_TAGS:
            if tag not in VOID_TAGS:
                self._skip += 1
            return
        if self._skip:
            return
        if tag not in VOID_TAGS:
            self._open[tag] = self._open.get(tag, 0) + 1
            if tag in MAIN_TAGS or a.get("role") == "main":
                self._main += 1
                self._main_ends.append((tag, self._open[tag]))
        if re.fullmatch(r"h[1-6]", tag):
            self._out("\n\n" + "#" * int(tag[1]) + " ")
        elif tag in ("ul", "ol"):
            if not self._lists:
                self._out("\n")
            self._lists.append([tag, 0])
        elif tag == "li":
            depth = max(len(self._lists) - 1, 0)
            mark = "- "
            if self._lists and self._lists[-1][0] == "ol":
                self._lists[-1][1] += 1
                mark = f"{self._lists[-1][1]}. "
            self._out("\n" + "  " * depth + mark)
            self._after_mark = True
        elif tag == "pre":
            self._pre += 1
            self._out("\n\n```\n")
        elif tag == "code" and not self._pre:
            self._out("`")
        elif tag == "br":
            self._out("\n")
        elif tag == "hr":
            self._out("\n\n---\n\n")
        elif tag == "tr":
            self._cells = 0
            self._out("\n")
        elif tag in ("td", "th"):
            if self._cells:
                self._out(" | ")
            self._cells += 1
        elif tag == "a":
            href = a.get("href", "").strip()
            if href and not href.startswith(("#", "javascript:", "mailto:")):
                self._link = (urljoin(self.base_url, href), len(self.all), len(self.main) if self._main else None)
        elif tag == "img":
            alt = a.get("alt", "").strip()
            if alt:
                self._out(f" [Image: {alt}] ")
        elif tag in BLOCK_TAGS:
            self._block()

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
            return
        if tag in SKIP_TAGS:
            if tag not in VOID_TAGS:
                self._skip = max(self._skip - 1, 0)
            return
        if self._skip:
            return
        if re.fullmatch(r"h[1-6]", tag):
            self._out("\n\n")
        elif tag in ("ul", "ol"):
            if self._lists:
                self._lists.pop()
            self._out("\n")
        elif tag == "pre":
            self._pre = max(self._pre - 1, 0)
            self._out("\n```\n\n")
        elif tag == "code" and not self._pre:
            self._out("`")
        elif tag == "a" and self._link is not None:
            href, start, main_start = self._link
            self._link = None
            text = re.sub(r"\s+", " ", "".join(self.all[start:])).strip()
            if text and text != href and urlparse(href).scheme in ("http", "https"):
                self._out(f"]({href})")
                # The "[" goes before the link text.
                self.all.insert(start, "[")
                if main_start is not None and self._main:
                    self.main.insert(main_start, "[")
        elif tag in BLOCK_TAGS and not self._lists:
            self._block()  # In a list, the next item or block starts a new line.
        if self._main_ends and self._main_ends[-1] == (tag, self._open.get(tag, 0)):
            self._main_ends.pop()
            self._main -= 1
        if self._open.get(tag):
            self._open[tag] -= 1

    def _block(self) -> None:
        """The break of a block element. In a list it is one line. Right after a list mark it is nothing."""
        if not self._after_mark:
            self._out("\n" if self._lists else "\n\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
            return
        if self._skip or data.strip() == "¶":  # A pilcrow: the anchor link of a heading.
            return
        if data.strip():
            self._after_mark = False
        if self._pre:
            self._out(data)
        else:
            self._out(re.sub(r"\s+", " ", data))


LIST_LINE = re.compile(r"^ *(?:- |\d+\. )")


def _tidy(text: str) -> str:
    """Remove the spaces at the ends of lines (not in code blocks), and the extra empty lines."""
    out: list[str] = []
    fence = False
    for line in text.split("\n"):
        if line.strip().startswith("```"):
            fence = not fence
            out.append(line.strip())
        elif fence:
            out.append(line.rstrip())
        elif LIST_LINE.match(line):
            out.append(line.rstrip())  # A list item keeps its indent.
        else:
            out.append(line.strip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def html_to_text(html: str, base_url: str = "") -> tuple[str, str]:
    """The title and the text of an HTML page. The main content, if the page marks it."""
    parser = _TextParser(base_url)
    parser.feed(html)
    parser.close()
    main = _tidy("".join(parser.main))
    text = main if len(main) >= MIN_MAIN_CHARS else _tidy("".join(parser.all))
    return re.sub(r"\s+", " ", parser.title).strip(), text


# -- fetch ---------------------------------------------------------------------------------------------


@dataclass
class Page:
    url: str  # The URL after the redirects on the same host.
    status: int
    content_type: str
    title: str = ""
    text: str = ""
    image: str | None = None  # A data URL, for an image.
    redirect: str | None = None  # A redirect to another host. The page has no text.
    fetched: float = field(default_factory=time.monotonic)


_cache: dict[str, Page] = {}


def _cached(url: str) -> Page | None:
    page = _cache.get(url)
    if page is not None and time.monotonic() - page.fetched < CACHE_SECONDS:
        return page
    _cache.pop(url, None)
    return None


def _remember(url: str, page: Page) -> None:
    _cache[url] = page
    while len(_cache) > CACHE_SIZE:
        _cache.pop(next(iter(_cache)))


def clear_cache() -> None:
    _cache.clear()


def _charset(content_type: str, data: bytes) -> str:
    match = re.search(r"charset=[\"']?([\w-]+)", content_type, re.I)
    if not match and b"<" in data[:4096]:
        match = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", data[:4096], re.I)
        if match:
            return match.group(1).decode("ascii", "replace")
    return match.group(1) if match else "utf-8"


def _decode(data: bytes, content_type: str) -> str:
    try:
        return data.decode(_charset(content_type, data), errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


async def _download(client: httpx.AsyncClient, url: str) -> tuple[httpx.Response, bytes]:
    async with client.stream("GET", url) as response:
        size = int(response.headers.get("content-length") or 0)
        if size > MAX_BYTES:
            raise WebError(f"The page is too large: {size // 1_000_000} MB. The limit is {MAX_BYTES // 1_000_000} MB.")
        chunks: list[bytes] = []
        total = 0
        if not response.is_redirect:
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_BYTES:
                    raise WebError(f"The page is too large. The limit is {MAX_BYTES // 1_000_000} MB.")
                chunks.append(chunk)
        return response, b"".join(chunks)


def _page_from(url: str, response: httpx.Response, data: bytes) -> Page:
    content_type = response.headers.get("content-type", "").lower()
    kind = content_type.split(";")[0].strip()
    page = Page(url=url, status=response.status_code, content_type=kind or "unknown")
    if kind in ("text/html", "application/xhtml+xml") or (not kind and data.lstrip()[:1] == b"<"):
        page.title, page.text = html_to_text(_decode(data, content_type), url)
    elif kind == "application/pdf" or data[:5] == b"%PDF-":
        from .documents import DocumentError, pdf_text

        try:
            page.text = pdf_text(data)
        except DocumentError as e:
            raise WebError(str(e)) from None
    elif kind in IMAGE_TYPES:
        page.image = f"data:{kind};base64,{base64.b64encode(data).decode('ascii')}"
        page.text = f"(An image: {kind}, {max(len(data) // 1000, 1)} KB.)"
    elif kind.startswith("text/") or kind in TEXT_TYPES or kind.endswith(("+json", "+xml")):
        page.text = _decode(data, content_type).strip()
    else:
        raise WebError(f"The URL gives a file of the type {kind or 'unknown'}. web_fetch reads only web pages, "
                       "text, PDF files, and images. Use bash to download other files.")
    return page


async def fetch(raw_url: str) -> Page:
    """Fetch a page. A cached page from the last 15 minutes needs no new request."""
    url = normalize_url(raw_url)
    page = _cached(url)
    if page is not None:
        return page
    current = url
    try:
        async with _client(follow_redirects=False) as client:
            for _ in range(MAX_REDIRECTS + 1):
                response, data = await _download(client, current)
                if response.is_redirect and response.headers.get("location"):
                    target = urljoin(current, response.headers["location"])
                    if urlparse(target).scheme not in ("http", "https"):
                        raise WebError(f"The page redirects to a URL that is not http or https: {target}")
                    if not same_site(host_of(target), host_of(current)):
                        page = Page(url=current, status=response.status_code, content_type="", redirect=target)
                        break
                    current = target
                    continue
                page = _page_from(current, response, data)
                break
            else:
                raise WebError(f"The page has more than {MAX_REDIRECTS} redirects.")
    except httpx.TimeoutException:
        raise WebError(f"The request to {host_of(current)} timed out after {FETCH_TIMEOUT:.0f} seconds.") from None
    except httpx.HTTPError as e:
        raise WebError(f"The request to {host_of(current)} failed: {e or type(e).__name__}") from None
    if page.status < 400 and page.redirect is None:
        _remember(url, page)
    return page


# -- search --------------------------------------------------------------------------------------------


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str = ""


def _strip_tags(text: str) -> str:
    if "<" in text:
        text = html_to_text(text)[1]
    return re.sub(r"\s+", " ", text).strip()


class _DuckParser(HTMLParser):
    """The results of the HTML page of DuckDuckGo: the links with the class result__a, and the snippets."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[SearchResult] = []
        self._field: str | None = None
        self._text: list[str] = []
        self._ad = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: v or "" for k, v in attrs}
        classes = a.get("class", "").split()
        if tag == "div" and "result" in classes:
            self._ad = "result--ad" in classes
        if tag == "a" and "result__a" in classes and not self._ad:
            self._field = "title"
            self._text = []
            self.results.append(SearchResult(title="", url=_duck_url(a.get("href", ""))))
        elif "result__snippet" in classes and self.results and not self._ad and self._field is None:
            self._field = "snippet"
            self._text = []

    def handle_endtag(self, tag: str) -> None:
        if self._field is None or tag not in ("a", "div", "td"):
            return
        text = re.sub(r"\s+", " ", "".join(self._text)).strip()
        if self._field == "title":
            self.results[-1].title = text
        else:
            self.results[-1].snippet = text
        self._field = None

    def handle_data(self, data: str) -> None:
        if self._field is not None:
            self._text.append(data)


def _duck_url(href: str) -> str:
    """The real URL of a result link. DuckDuckGo links go through //duckduckgo.com/l/?uddg=<URL>."""
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if parsed.hostname and parsed.hostname.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg")
        if target:
            return target[0]
    return href


async def _duckduckgo(client: httpx.AsyncClient, query: str) -> list[SearchResult]:
    response = await client.post("https://html.duckduckgo.com/html/", data={"q": query},
                                 headers={"Referer": "https://html.duckduckgo.com/"})
    if response.status_code == 202 or "anomaly" in response.text[:20000].lower():
        raise WebError("DuckDuckGo blocked the search for a short time. Try again later. The user can "
                       "select another search provider in Settings > General > Web.")
    response.raise_for_status()
    parser = _DuckParser()
    parser.feed(response.text)
    return [r for r in parser.results if r.url.startswith(("http://", "https://")) and "duckduckgo.com/y.js" not in r.url]


def _need_key(provider: str) -> str:
    key = WEB_KEYS.get(provider)
    if not key:
        name = {"brave": "Brave Search", "tavily": "Tavily"}[provider]
        raise WebError(f"Web search uses {name}, but it has no API key. The user adds the key in Settings > "
                       "General > Web, or selects DuckDuckGo there.")
    return key


async def _brave(client: httpx.AsyncClient, query: str, count: int) -> list[SearchResult]:
    response = await client.get("https://api.search.brave.com/res/v1/web/search",
                                params={"q": query, "count": min(count, 20)},
                                headers={"Accept": "application/json", "X-Subscription-Token": _need_key("brave")})
    if response.status_code in (401, 403):
        raise WebError("Brave Search did not accept the API key. The user can change it in Settings > General > Web.")
    response.raise_for_status()
    items = (response.json().get("web") or {}).get("results") or []
    return [SearchResult(_strip_tags(i.get("title", "")), i.get("url", ""), _strip_tags(i.get("description", "")))
            for i in items if isinstance(i, dict)]


async def _tavily(client: httpx.AsyncClient, query: str, count: int, allowed: list[str],
                  blocked: list[str]) -> list[SearchResult]:
    body: dict[str, Any] = {"query": query, "max_results": min(count, 20)}
    if allowed:
        body["include_domains"] = allowed
    if blocked:
        body["exclude_domains"] = blocked
    response = await client.post("https://api.tavily.com/search", json=body,
                                 headers={"Authorization": f"Bearer {_need_key('tavily')}"})
    if response.status_code in (401, 403):
        raise WebError("Tavily did not accept the API key. The user can change it in Settings > General > Web.")
    response.raise_for_status()
    items = response.json().get("results") or []
    return [SearchResult(i.get("title", ""), i.get("url", ""), _strip_tags(i.get("content", "")))
            for i in items if isinstance(i, dict)]


async def _searxng(client: httpx.AsyncClient, base: str | None, query: str) -> list[SearchResult]:
    if not base:
        raise WebError("Web search uses SearXNG, but it has no server URL. The user adds it in Settings > General > Web.")
    url = normalize_url(base).rstrip("/") + "/search"
    response = await client.get(url, params={"q": query, "format": "json"}, headers={"Accept": "application/json"})
    if response.status_code == 403:
        raise WebError("The SearXNG server refused the JSON format. Add 'json' to search.formats in its settings.yml.")
    response.raise_for_status()
    items = response.json().get("results") or []
    return [SearchResult(i.get("title", ""), i.get("url", ""), _strip_tags(i.get("content", "")))
            for i in items if isinstance(i, dict)]


def _with_sites(query: str, allowed: list[str]) -> str:
    if not allowed:
        return query
    sites = " OR ".join(f"site:{d}" for d in allowed)
    return f"{query} ({sites})" if len(allowed) > 1 else f"{query} {sites}"


async def search(query: str, settings: dict[str, Any], allowed: list[str] | None = None,
                 blocked: list[str] | None = None, count: int = DEFAULT_RESULTS) -> list[SearchResult]:
    query = (query or "").strip()
    if len(query) < 2:
        raise WebError("Give a search query of 2 characters or more.")
    provider = settings.get("web_search") or DEFAULT_PROVIDER
    if provider not in PROVIDERS:
        provider = DEFAULT_PROVIDER
    if provider == "off":
        raise WebError("Web search is off. The user can turn it on in Settings > General > Web.")
    allowed = [d for d in (clean_domain(x) for x in allowed or []) if d]
    blocked = [d for d in (clean_domain(x) for x in blocked or []) if d]
    count = max(1, min(count, MAX_RESULTS))
    try:
        async with _client(follow_redirects=True) as client:
            if provider == "brave":
                results = await _brave(client, _with_sites(query, allowed), count)
            elif provider == "tavily":
                results = await _tavily(client, query, count, allowed, blocked)
            elif provider == "searxng":
                results = await _searxng(client, settings.get("web_search_url"), _with_sites(query, allowed))
            else:
                results = await _duckduckgo(client, _with_sites(query, allowed))
    except httpx.TimeoutException:
        raise WebError(f"The search timed out after {FETCH_TIMEOUT:.0f} seconds.") from None
    except httpx.HTTPStatusError as e:
        raise WebError(f"The search failed: HTTP {e.response.status_code} from {e.request.url.host}.") from None
    except httpx.HTTPError as e:
        raise WebError(f"The search failed: {e or type(e).__name__}") from None
    except ValueError:
        raise WebError("The search provider sent an answer that is not valid JSON.") from None
    seen: set[str] = set()
    out: list[SearchResult] = []
    for r in results:
        if not r.url or r.url in seen:
            continue
        if allowed and not domain_matches(r.url, allowed):
            continue
        if blocked and domain_matches(r.url, blocked):
            continue
        seen.add(r.url)
        out.append(SearchResult(r.title or r.url, r.url, r.snippet))
        if len(out) >= count:
            break
    return out
