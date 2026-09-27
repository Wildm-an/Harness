"""Tests for the agent browser and the preview_* tools (build phase 10)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from harness_daemon.agent import Agent
from harness_daemon.browser import AgentBrowser, BrowserError
from harness_daemon.config import load_settings
from harness_daemon.context import estimate_tokens
from harness_daemon.launch import save_launch
from harness_daemon.permissions import PermissionGate
from harness_daemon.preview import PreviewHost
from harness_daemon.providers import ModelClient, Provider, image_input
from harness_daemon.servers import ServerManager
from harness_daemon.tools import ToolContext, ToolError, detect_shell, preview_tools
from harness_daemon.tools.base import Approval

from test_server import Client, daemon  # noqa: F401 - the daemon fixture
from test_servers import PYTHON, free_port

PREVIEW_APP = Path(__file__).with_name("preview_app.py").as_posix()


def app_command(port: int) -> str:
    return f'"{PYTHON}" "{PREVIEW_APP}" {port}'


@pytest.fixture(scope="module")
def chromium():
    """Skip the browser tests if Playwright or its Chromium is not installed."""
    async def probe() -> None:
        browser = AgentBrowser(lambda url: False)
        try:
            await browser.navigate("about:blank")
        finally:
            await browser.close()
    try:
        asyncio.run(probe())
    except BrowserError as e:
        pytest.skip(str(e))


def launch(project: Path, port: int) -> None:
    save_launch(project, [{"name": "web", "command": app_command(port), "port": port,
                           "ready_pattern": "Local:", "default": True}])


# -- the tools, with no WebSocket ----------------------------------------------------------------


def test_preview_tools_operate_the_app(project, harness_home, chromium):
    port = free_port()
    launch(project, port)
    events: list[dict] = []

    async def emit(event: dict) -> None:
        events.append(event)

    async def main() -> None:
        settings = load_settings(project)
        shell = detect_shell(None)
        manager = ServerManager(project, shell, emit)
        host = PreviewHost(manager, emit)
        ctx = ToolContext(cwd=project, settings=settings, shell=shell, preview=host)
        tools = {t.name: t for t in preview_tools(image_input=True)}

        async def call(tool_name: str, **args) -> str:
            tool = tools[tool_name]
            tool.validate(args)
            await tool.prepare(args, ctx)
            result = await tool.run(args, ctx)
            assert not result.is_error, result.output
            return result.output

        try:
            # preview_start needs the approval of a server(<command>) rule, like the Servers pane.
            approval = await tools["preview_start"].prepare({}, ctx)
            assert approval == Approval(key=app_command(port), rule=f"server({app_command(port)})", tool="server",
                                        input={"name": "web", "command": app_command(port), "cwd": "."})
            assert f"running at http://127.0.0.1:{port}/" in await call("preview_start")
            assert await tools["preview_start"].prepare({}, ctx) is None  # It runs: no approval.

            # The server URLs need no approval. Other URLs do.
            nav = tools["preview_navigate"]
            assert await nav.prepare({"url": "/"}, ctx) is None
            assert await nav.prepare({"url": f"http://localhost:{port}/about"}, ctx) is None
            external = await nav.prepare({"url": "https://example.com/page"}, ctx)
            assert external.rule == "preview_navigate(https://example.com/*)"

            opened = await call("preview_navigate", url="/")
            assert f"Opened http://127.0.0.1:{port}/ (HTTP 200)." in opened and "Title: Test app" in opened
            assert "an error at load" in opened
            frame = next(e for e in events if e["type"] == "preview.frame")
            assert frame["url"] == f"http://127.0.0.1:{port}/" and frame["image"].startswith("data:image/jpeg;base64,")

            snap = await call("preview_snapshot")
            assert snap.startswith(f"Page: Test app\nURL: http://127.0.0.1:{port}/")
            for line in ['heading "Counter" [level=1]', 'button "Add one" [ref=e1]', 'textbox "Name" [ref=e2]',
                         'combobox "Color" [ref=e4]: "Red"', 'link "About" [ref=e5] -> /about']:
                assert line in snap
            assert "Secret hidden text" not in snap

            await call("preview_click", ref="e1")
            await call("preview_fill", ref="[ref=e2]", text="Ada")
            await call("preview_click", ref="e3")
            await call("preview_fill", ref="e4", text="Blue")
            snap = await call("preview_snapshot")
            assert '"Count: 1"' in snap and '"Hello, Ada"' in snap and 'combobox "Color" [ref=e4]: "Blue"' in snap

            # A link to a URL that is not a server: the browser blocks it and stays on the page.
            blocked = await call("preview_click", ref="e6")
            assert "blocked a navigation to https://example.com/" in blocked and "page changed" not in blocked

            broke = await call("preview_click", ref="e7")
            assert "New console errors" in broke and "boom from the page" in broke
            console = await call("preview_console")
            assert "an error at load" in console and "boom from the page" in console

            moved = await call("preview_click", ref="e5")
            assert f"The page changed to http://127.0.0.1:{port}/about" in moved
            # The references of the old page select nothing on the new page.
            with pytest.raises(ToolError, match="not on the page"):
                await call("preview_click", ref="e1")
            snap = await call("preview_snapshot")
            assert 'link "Home" [ref=e8]' in snap
            assert await call("preview_console") == "There are no console errors."

            missing = await tools["preview_navigate"].run({"url": "/missing"}, ctx)
            assert missing.is_error and "HTTP 404" in missing.output

            logs = await call("preview_logs")
            assert "The server web is running" in logs and "Local:" in logs

            shot = await tools["preview_screenshot"].run({}, ctx)
            assert shot.image.startswith("data:image/jpeg;base64,")

            with pytest.raises(ToolError, match="not an element reference"):
                await call("preview_click", ref="Add one")
            assert "stopped" in await call("preview_stop", name="web")
        finally:
            await host.close()
            await manager.stop_all()

    asyncio.run(main())


def test_preview_start_errors(project, harness_home):
    async def emit(event: dict) -> None:
        pass

    async def main() -> None:
        shell = detect_shell(None)
        host = PreviewHost(ServerManager(project, shell, emit), emit)
        ctx = ToolContext(cwd=project, settings=load_settings(project), shell=shell, preview=host)
        start = next(t for t in preview_tools(False) if t.name == "preview_start")
        with pytest.raises(ToolError, match="Create .harness/launch.json"):
            await start.prepare({}, ctx)
        launch(project, free_port())
        with pytest.raises(ToolError, match="Unknown server: api"):
            await start.prepare({"name": "api"}, ctx)
        # Without a session, the tools tell the model that they are not available.
        with pytest.raises(ToolError, match="not available"):
            await start.run({}, ToolContext(cwd=project, settings={}, shell=shell))

    asyncio.run(main())


def test_screenshot_tool_only_for_image_input():
    assert "preview_screenshot" not in {t.name for t in preview_tools(False)}
    assert "preview_screenshot" in {t.name for t in preview_tools(True)}


# -- approval, images, and model checks ---------------------------------------------------------------


def test_rule_name_of_an_approval(project):
    (project / ".harness").mkdir()
    (project / ".harness" / "settings.json").write_text(json.dumps(
        {"allow": ["server(npm run dev)", "preview_navigate(https://example.com/*)"]}))
    asked: list[dict] = []

    async def approver(request: dict) -> str:
        asked.append(request)
        return "allow_always"

    tools = {t.name: t for t in preview_tools(False)}
    gate = PermissionGate(project, approver)

    async def main() -> None:
        # A server(<command>) rule of the Servers pane also allows preview_start.
        assert await gate.check(tools["preview_start"], {}, Approval("npm run dev", "server(npm run dev)", tool="server"))
        assert await gate.check(tools["preview_navigate"], {},
                                Approval("https://example.com/a/b", "preview_navigate(https://example.com/*)"))
        assert not asked
        # A new command asks. "Always" adds a server rule.
        assert await gate.check(tools["preview_start"], {"name": "api"}, Approval("uvicorn app:app", "server(uvicorn app:app)", tool="server"))
        assert asked[0]["tool"] == "preview_start" and asked[0]["rule"] == "server(uvicorn app:app)"

    asyncio.run(main())
    assert "server(uvicorn app:app)" in json.loads((project / ".harness" / "settings.json").read_text())["allow"]


IMAGE = "data:image/jpeg;base64," + "A" * 50_000


def _agent(project: Path, image_input: bool) -> Agent:
    async def emit(event: dict) -> None:
        pass

    async def approver(request: dict) -> str:
        return "deny"

    client = ModelClient(Provider(name="fake", base_url="http://127.0.0.1:9/v1"), "m")
    return Agent(cwd=project, client=client, emit=emit, approver=approver, settings=load_settings(project),
                 image_input=image_input)


def _screenshot_history() -> list[dict]:
    call = {"id": "c1", "type": "function", "function": {"name": "preview_screenshot", "arguments": "{}"}}
    other = {"id": "c2", "type": "function", "function": {"name": "preview_console", "arguments": "{}"}}
    return [
        {"role": "user", "content": "check the page"},
        {"role": "assistant", "content": None, "tool_calls": [call, other]},
        {"role": "tool", "tool_call_id": "c1", "content": "A screenshot.", "is_error": False, "image": IMAGE},
        {"role": "tool", "tool_call_id": "c2", "content": "No errors.", "is_error": False},
    ]


def test_the_newest_image_goes_to_the_model_after_the_tool_results(project, harness_home):
    agent = _agent(project, image_input=True)
    agent.history = _screenshot_history()
    messages = agent.messages()
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "tool", "tool", "user"]
    assert "image" not in messages[3]
    parts = messages[-1]["content"]
    assert parts[0]["text"] == "The image from the preview_screenshot tool call:"
    assert parts[1] == {"type": "image_url", "image_url": {"url": IMAGE}}
    # The data URL does not count as text in the token estimate.
    assert estimate_tokens(messages) < 3000

    # After the next user message, the old image is for the client only.
    agent.history.append({"role": "user", "content": "thanks"})
    assert all(not isinstance(m["content"], list) for m in agent.messages())

    # A model with no image input never gets the image.
    agent = _agent(project, image_input=False)
    agent.history = _screenshot_history()
    assert [m["role"] for m in agent.messages()] == ["system", "user", "assistant", "tool", "tool"]


def test_preview_tools_follow_the_image_input_of_the_model(project, harness_home):
    agent = _agent(project, image_input=False)
    assert not any(n.startswith("preview_") for n in agent.tools)
    agent.enable_preview(object())
    assert "preview_navigate" in agent.tools and "preview_screenshot" not in agent.tools
    assert "# Preview" in agent.system_prompt and "Auto-verify" not in agent.system_prompt
    agent.set_client(agent.client, image_input=True)
    assert "preview_screenshot" in agent.tools
    agent.reload_settings({**agent.settings, "auto_verify": True})
    assert "Auto-verify" in agent.system_prompt


def test_image_input_order():
    provider = Provider(name="p", base_url="http://x/v1", models={"llava": {"image_input": True}})
    assert image_input(provider, "llava", {}, None) is True
    assert image_input(provider, "llava", {"image_input": False}, None) is False
    assert image_input(provider, "qwen", {}, ["completion", "tools", "vision"]) is True
    assert image_input(provider, "qwen", {}, ["completion", "tools"]) is False
    assert image_input(provider, "qwen", {}, None) is False


# -- through the protocol ----------------------------------------------------------------------------


def test_agent_starts_and_opens_the_app_through_the_protocol(daemon, project, fake_model, chromium):  # noqa: F811
    port = free_port()
    launch(project, port)
    fake_model.script(
        {"tool_calls": [{"name": "preview_start", "arguments": {}}]},
        {"tool_calls": [{"name": "preview_navigate", "arguments": {"url": "/about"}}]},
        {"text": "The app runs."},
        {"text": "Checked."},
    )
    c = Client(daemon)
    ready = c.new_session(project)
    assert ready["auto_verify"] is False and ready["image_input"] is False
    c.send({"type": "prompt", "text": "check the app"})
    request = c.until("permission.request")[0]
    assert request["tool"] == "preview_start" and request["rule"] == f"server({app_command(port)})"
    assert request["input"] == {"name": "web", "command": app_command(port), "cwd": "."}
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_always"})
    end, seen = c.until("turn.end", timeout=60)
    assert end["stop_reason"] == "end"
    results = [m for m in seen if m["type"] == "tool.result"]
    assert "is running at" in results[0]["output"]
    assert f"Opened http://127.0.0.1:{port}/about (HTTP 200)." in results[1]["output"]
    frame = next(m for m in seen if m["type"] == "preview.frame")
    assert frame["title"] == "About" and frame["action"] == "navigate"
    assert any(m["type"] == "server.status" and m["state"] == "running" for m in seen)

    tools = {t["function"]["name"] for t in fake_model.requests[0]["tools"]}
    assert {"preview_start", "preview_navigate", "preview_snapshot"} <= tools and "preview_screenshot" not in tools
    assert "Auto-verify" not in fake_model.requests[0]["messages"][0]["content"]

    # "Auto-verify" is a project setting. The system prompt of the next turn has it.
    c.send({"type": "settings.set", "auto_verify": True})
    assert c.until("settings")[0]["auto_verify"] is True
    assert json.loads((project / ".harness" / "settings.json").read_text())["auto_verify"] is True
    c.send({"type": "settings.set", "auto_verify": "yes"})
    assert "must be a bool" in c.until("error")[0]["message"]
    c.send({"type": "prompt", "text": "again"})
    c.until("turn.end")
    assert "Auto-verify" in fake_model.requests[-1]["messages"][0]["content"]
    c.close()
