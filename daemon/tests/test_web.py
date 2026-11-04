"""Tests for web_fetch and web_search (web.py, tools/web.py). The HTTP requests go to a mock transport."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from harness_daemon import web
from harness_daemon.agent import Agent
from harness_daemon.auto_mode import fast_path
from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.providers import ModelClient, resolve_model
from harness_daemon.tools import ToolContext, ToolError, detect_shell
from harness_daemon.tools.web import WebFetchTool, WebSearchTool


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def routes(monkeypatch):
    """The answers of the mock web: {url: handler(request) or httpx.Response}. The requests go to ``seen``."""
    table: dict[str, object] = {}
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        key = str(request.url.copy_with(query=None))
        answer = table.get(key)
        if answer is None:
            return httpx.Response(404, text="not found")
        return answer(request) if callable(answer) else answer

    monkeypatch.setattr(web, "_transport", lambda: httpx.MockTransport(handle))
    web.clear_cache()
    web.WEB_KEYS.clear()
    table["seen"] = seen
    yield table
    web.clear_cache()
    web.WEB_KEYS.clear()


def html(body: str, title: str = "Page") -> httpx.Response:
    return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"},
                          text=f"<html><head><title>{title}</title><script>var x=1</script></head><body>{body}</body></html>")


def ctx(tmp_path: Path, **settings) -> ToolContext:
    return ToolContext(cwd=tmp_path, settings={**DEFAULT_SETTINGS, **settings}, shell=detect_shell())


# -- HTML to text ---------------------------------------------------------------------------------------


def test_html_becomes_markdown_text():
    title, text = web.html_to_text(
        "<title> The  title </title><style>p{}</style><h1>Head</h1><p>Some <a href='/b'>link</a> and "
        "<code>code()</code>.</p><ul><li>one</li><li>two<ul><li>sub</li></ul></li></ul>"
        "<ol><li>first</li><li>second</li></ol><pre>  keep\n    spaces</pre>"
        "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>", "https://e.com/docs/")
    assert title == "The title"
    assert "# Head" in text
    assert "Some [link](https://e.com/b) and `code()`." in text
    assert "- one\n- two\n  - sub" in text
    assert "1. first\n2. second" in text
    assert "```\n  keep\n    spaces\n```" in text
    assert "a | b\n1 | 2" in text
    assert "p{}" not in text and "var x" not in text


def test_the_main_content_replaces_the_page_when_it_is_long():
    main = "<p>" + "Main text. " * 60 + "</p>"
    _, text = web.html_to_text(f"<nav>Menu item</nav><div role='main'>{main}</div><footer>Foot</footer>")
    assert text.startswith("Main text.") and "Menu item" not in text and "Foot" not in text
    # A short <main> is not the content: the full page shows.
    _, text = web.html_to_text("<nav>Menu item</nav><main><p>Short</p></main>")
    assert "Menu item" in text and "Short" in text


def test_list_items_with_paragraphs_stay_on_one_line():
    _, text = web.html_to_text("<ul><li><p>one</p></li><li><p>two</p></li></ul><h2>Next<a href='#n'>¶</a></h2>")
    assert "- one\n- two" in text and "## Next" in text and "¶" not in text


# -- fetch ----------------------------------------------------------------------------------------------


def test_fetch_reads_a_page_and_caches_it(routes):
    routes["https://e.com/docs"] = html("<h1>Docs</h1><p>Hello.</p>", title="Docs page")
    page = run(web.fetch("e.com/docs"))  # A URL with no scheme gets https.
    assert (page.url, page.status, page.title) == ("https://e.com/docs", 200, "Docs page")
    assert "# Docs" in page.text and "Hello." in page.text
    run(web.fetch("https://e.com/docs"))
    assert len(routes["seen"]) == 1  # The second fetch came from the cache.


def test_fetch_follows_a_redirect_on_the_same_host_only(routes):
    routes["http://e.com/old"] = httpx.Response(301, headers={"location": "https://www.e.com/new"})
    routes["https://www.e.com/new"] = html("<p>New page</p>")
    page = run(web.fetch("http://e.com/old"))
    assert page.url == "https://www.e.com/new" and "New page" in page.text and page.redirect is None
    routes["https://e.com/away"] = httpx.Response(302, headers={"location": "https://other.org/x"})
    page = run(web.fetch("https://e.com/away"))
    assert page.redirect == "https://other.org/x" and page.text == ""
    assert not any(r.url.host == "other.org" for r in routes["seen"])


def test_fetch_rejects_bad_urls_large_pages_and_binary_files(routes):
    for bad in ("", "ftp://e.com/file", "file:///etc/passwd"):
        with pytest.raises(web.WebError):
            run(web.fetch(bad))
    routes["https://e.com/big"] = httpx.Response(200, headers={"content-type": "text/plain"},
                                                 content=b"x" * (web.MAX_BYTES + 1))
    with pytest.raises(web.WebError, match="too large"):
        run(web.fetch("https://e.com/big"))
    routes["https://e.com/app.zip"] = httpx.Response(200, headers={"content-type": "application/zip"}, content=b"PK")
    with pytest.raises(web.WebError, match="application/zip"):
        run(web.fetch("https://e.com/app.zip"))


def test_fetch_reads_json_and_gives_images(routes):
    routes["https://api.e.com/v1"] = httpx.Response(200, json={"version": "2.1"})
    assert json.loads(run(web.fetch("https://api.e.com/v1")).text) == {"version": "2.1"}
    routes["https://e.com/logo.png"] = httpx.Response(200, headers={"content-type": "image/png"}, content=b"\x89PNG....")
    page = run(web.fetch("https://e.com/logo.png"))
    assert page.image and page.image.startswith("data:image/png;base64,")


def test_the_fetch_tool_asks_for_each_host_and_reads_in_parts(routes, tmp_path):
    tool = WebFetchTool()
    approval = run(tool.prepare({"url": "https://Docs.E.com/a?b=1"}, ctx(tmp_path)))
    assert (approval.key, approval.rule) == ("domain:docs.e.com", "web_fetch(domain:docs.e.com)")
    with pytest.raises(ToolError):
        run(tool.prepare({"url": "mailto:a@e.com"}, ctx(tmp_path)))
    routes["https://e.com/long"] = httpx.Response(200, headers={"content-type": "text/plain"}, text="a" * 300 + "b" * 300)
    small = ctx(tmp_path, max_output_chars=300)
    first = run(tool.run({"url": "https://e.com/long"}, small)).output
    assert "URL: https://e.com/long" in first and "Use offset=300 to read more." in first and "b" not in first.split("\n\n")[1]
    second = run(tool.run({"url": "https://e.com/long", "offset": 300}, small)).output
    assert "b" * 300 in second and "Characters 300-600 of 600.]" in second
    routes["https://e.com/away"] = httpx.Response(302, headers={"location": "https://other.org/x"})
    assert "Call web_fetch with this URL" in run(tool.run({"url": "https://e.com/away"}, small)).output


def test_the_fetch_tool_gives_an_image_only_to_a_model_with_image_input(routes, tmp_path):
    routes["https://e.com/a.png"] = httpx.Response(200, headers={"content-type": "image/png"}, content=b"\x89PNG")
    tool = WebFetchTool()
    blind = run(tool.run({"url": "https://e.com/a.png"}, ctx(tmp_path)))
    assert blind.image is None and "does not accept images" in blind.output
    seeing = ctx(tmp_path)
    seeing.image_input = True
    assert run(tool.run({"url": "https://e.com/a.png"}, seeing)).image.startswith("data:image/png")


def test_auto_mode_allows_local_fetches_with_no_check():
    assert fast_path("web_fetch", "domain:localhost")
    assert not fast_path("web_fetch", "domain:example.com")


# -- search ---------------------------------------------------------------------------------------------

DUCK_PAGE = """
<div class="result results_links result--ad"><a class="result__a" href="https://ads.example/x">Ad</a></div>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2Flibrary%2Fasyncio.html&amp;rut=1">asyncio &mdash; docs</a>
  <a class="result__snippet" href="#">The <b>asyncio</b> module.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="https://blog.example.com/post">A blog post</a>
  <div class="result__snippet">About tasks.</div>
</div>
"""


def test_duckduckgo_results_skip_ads_and_decode_the_links(routes):
    routes["https://html.duckduckgo.com/html/"] = httpx.Response(200, text=DUCK_PAGE)
    results = run(web.search("asyncio tasks", {}))
    assert [(r.title, r.url, r.snippet) for r in results] == [
        ("asyncio — docs", "https://docs.python.org/3/library/asyncio.html", "The asyncio module."),
        ("A blog post", "https://blog.example.com/post", "About tasks."),
    ]
    sent = routes["seen"][-1]
    assert sent.method == "POST" and b"q=asyncio+tasks" in sent.content


def test_search_filters_the_domains(routes):
    routes["https://html.duckduckgo.com/html/"] = httpx.Response(200, text=DUCK_PAGE)
    only = run(web.search("asyncio", {}, allowed=["https://www.python.org"]))
    assert [r.url for r in only] == ["https://docs.python.org/3/library/asyncio.html"]
    assert b"site%3Apython.org" in routes["seen"][-1].content
    blocked = run(web.search("asyncio", {}, blocked=["example.com"]))
    assert [r.url for r in blocked] == ["https://docs.python.org/3/library/asyncio.html"]


def test_duckduckgo_block_gives_a_clear_error(routes):
    routes["https://html.duckduckgo.com/html/"] = httpx.Response(202, text="<form>anomaly</form>")
    with pytest.raises(web.WebError, match="DuckDuckGo blocked"):
        run(web.search("asyncio", {}))


def test_brave_and_tavily_need_a_key(routes):
    routes["https://api.search.brave.com/res/v1/web/search"] = lambda r: httpx.Response(
        200 if r.headers.get("x-subscription-token") == "bk" else 401,
        json={"web": {"results": [{"title": "<strong>T</strong>", "url": "https://t.org", "description": "D <strong>x</strong>"}]}})
    with pytest.raises(web.WebError, match="no API key"):
        run(web.search("query", {"web_search": "brave"}))
    web.set_key("brave", "bk")
    assert [(r.title, r.url, r.snippet) for r in run(web.search("query", {"web_search": "brave"}))] == [("T", "https://t.org", "D x")]
    web.set_key("brave", "wrong")
    with pytest.raises(web.WebError, match="did not accept"):
        run(web.search("query", {"web_search": "brave"}))

    def tavily(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["include_domains"] == ["t.org"] and request.headers["authorization"] == "Bearer tk"
        return httpx.Response(200, json={"results": [{"title": "T", "url": "https://t.org/a", "content": "C"}]})

    routes["https://api.tavily.com/search"] = tavily
    web.set_key("tavily", "tk")
    assert run(web.search("query", {"web_search": "tavily"}, allowed=["t.org"]))[0].url == "https://t.org/a"


def test_searxng_and_off(routes):
    with pytest.raises(web.WebError, match="no server URL"):
        run(web.search("query", {"web_search": "searxng"}))
    routes["http://localhost:8888/search"] = lambda r: httpx.Response(
        200, json={"results": [{"title": "S", "url": "https://s.org", "content": "c"}]}) if r.url.params["format"] == "json" else httpx.Response(400)
    found = run(web.search("query", {"web_search": "searxng", "web_search_url": "http://localhost:8888/"}))
    assert found[0].url == "https://s.org"
    with pytest.raises(web.WebError, match="off"):
        run(web.search("query", {"web_search": "off"}))


def test_the_search_tool_lists_results_and_asks_once_for_all(routes, tmp_path):
    routes["https://html.duckduckgo.com/html/"] = httpx.Response(200, text=DUCK_PAGE)
    tool = WebSearchTool()
    approval = run(tool.prepare({"query": "asyncio"}, ctx(tmp_path)))
    assert (approval.key, approval.rule) == ("asyncio", "web_search")
    with pytest.raises(ToolError):
        run(tool.prepare({"query": "x"}, ctx(tmp_path)))
    with pytest.raises(ToolError, match="list of domains"):
        run(tool.prepare({"query": "asyncio", "allowed_domains": [1]}, ctx(tmp_path)))
    out = run(tool.run({"query": "asyncio", "count": 1}, ctx(tmp_path))).output
    assert "1. asyncio — docs\n   https://docs.python.org/3/library/asyncio.html" in out
    assert "A blog post" not in out and "Sources:" in out


def test_the_web_search_setting_off_removes_the_tool(tmp_path):
    async def approver(request):
        return "deny"

    async def emit(event):
        pass

    provider, model = resolve_model("fake/test-model")
    agent = Agent(client=ModelClient(provider, model), cwd=tmp_path, emit=emit, approver=approver,
                  settings={**DEFAULT_SETTINGS})
    assert "web_search" in agent.tools and "web_fetch" in agent.tools
    agent.reload_settings({**DEFAULT_SETTINGS, "web_search": "off"})
    assert "web_search" not in agent.tools and "web_fetch" in agent.tools
    agent.reload_settings({**DEFAULT_SETTINGS})
    assert "web_search" in agent.tools
