"""Tests for the show_visual tool and the frame page of the daemon (tools/visual.py)."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from harness_daemon.config import DEFAULT_SETTINGS
from harness_daemon.tools import ShowVisualTool, ToolContext, ToolError, default_tools, detect_shell
from harness_daemon.tools.visual import ALLOWED_CDNS, FRAME_CSP, MAX_VISUAL_CODE, blocked_sources

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

SVG = '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="8" fill="var(--color-accent)"/></svg>'


@pytest.fixture
def ctx(project):
    return ToolContext(cwd=project.resolve(), settings=dict(DEFAULT_SETTINGS), shell=detect_shell())


def show(ctx, **args):
    return asyncio.run(ShowVisualTool().run(args, ctx))


def test_the_tool_is_in_the_default_tools():
    assert "show_visual" in {t.name for t in default_tools()}
    assert not ShowVisualTool.needs_approval
    description = ShowVisualTool.description
    for rule in ("--color-text", "sendPrompt", "<!DOCTYPE>", *ALLOWED_CDNS):
        assert rule in description


def test_show_an_svg_and_html(ctx):
    assert "loader_options" in show(ctx, title="loader_options", code=SVG).output
    html = '<div class="row"><button onclick="sendPrompt(\'Use option 1\')">Use option</button></div>'
    assert not show(ctx, title="choices", code=html).is_error


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ({"title": "Loader Options", "code": SVG}, "snake_case"),
        ({"title": "", "code": SVG}, "snake_case"),
        ({"title": "a", "code": "  "}, "code is empty"),
        ({"title": "a", "code": "x" * (MAX_VISUAL_CODE + 1)}, "limit"),
        ({"title": "a", "code": '<script src="https://evil.example/x.js"></script>'}, "evil.example"),
    ],
)
def test_bad_visuals_fail(ctx, args, message):
    with pytest.raises(ToolError, match=message):
        show(ctx, **args)


def test_blocked_sources():
    code = (
        '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1"></script>'
        "<script src='//unpkg.com/d3@7'></script>"
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'
        '<script src="http://cdnjs.cloudflare.com/a.js"></script>'  # Not https.
        '<link rel="stylesheet" href="style.css">'
    )
    assert blocked_sources(code) == ["http://cdnjs.cloudflare.com/a.js", "style.css"]


def test_frame_csp():
    assert "connect-src 'none'" in FRAME_CSP and "sandbox allow-scripts" in FRAME_CSP
    assert "script-src 'unsafe-inline' https://cdnjs.cloudflare.com" in FRAME_CSP
    assert "allow-same-origin" not in FRAME_CSP


def test_daemon_serves_the_frame_page(daemon):  # noqa: F811
    base = daemon.replace("ws://", "http://").removesuffix("/ws")
    page = httpx.get(f"{base}/visual-frame")
    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
    assert page.headers["content-security-policy"] == FRAME_CSP
    assert "harness-visual-doc" in page.text and "document.write" in page.text


def test_agent_shows_a_visual(daemon, project, fake_model):  # noqa: F811
    fake_model.script(
        {"text": "", "tool_calls": [{"name": "show_visual", "arguments": {"title": "dot", "code": SVG}}]},
        {"text": "Here is the dot."},
    )
    c = Client(daemon)
    c.new_session(project)
    c.send({"type": "prompt", "text": "Show a dot"})
    _, events = c.until("turn.end")
    start = next(e for e in events if e["type"] == "tool.start")
    result = next(e for e in events if e["type"] == "tool.result")
    assert start["name"] == "show_visual" and start["input"]["code"] == SVG
    assert not result["is_error"], result
    assert not any(e["type"] == "permission.request" for e in events)
    c.close()
