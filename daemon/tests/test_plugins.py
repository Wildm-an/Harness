"""Tests for plugins: the manifest, the patch layers, install, the host, and the protocol."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
import yaml

from harness_daemon.plugins import PluginHost, Prompt, ToolCall
from harness_daemon.plugins.install import InstallError, installed_bundles, install, remove, set_bundle_enabled
from harness_daemon.plugins.dsh import DshError
from harness_daemon.plugins.manifest import version_matches
from harness_daemon.plugins.patch import Layer, compose, project_patch_path, set_row_disabled, user_patch_path
from harness_daemon.providers import PLUGIN_PROVIDERS, load_providers
from harness_daemon.tools.base import ToolContext
from harness_daemon.tools.shell import detect_shell

from test_server import Client, daemon  # noqa: F401 - the daemon fixture

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "plugins" / "hello"


def make_bundle(root: Path, name: str, files: dict[str, str], manifest: dict | None = None) -> Path:
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "plugin.json").write_text(json.dumps({"name": name, "version": "1.0.0", **(manifest or {})}))
    for rel, text in files.items():
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_text(text, encoding="utf-8")
    return folder


def load(cwd: Path | None = None) -> PluginHost:
    host = PluginHost(cwd)
    asyncio.run(host.load())
    return host


# -- versions and patches ----------------------------------------------------------------------------


def test_version_ranges():
    assert version_matches(">=0.1.4", "0.1.4") and version_matches(">=0.1.4 <0.3", "0.2.9")
    assert not version_matches(">=0.2", "0.1.9") and not version_matches("<0.3", "0.3.0")
    assert version_matches("^0.1.2", "0.1.9") and not version_matches("^0.1.2", "0.2.0")
    assert version_matches("^1.2", "1.9.0") and not version_matches("^1.2", "2.0.0")
    assert version_matches("*", "9.9.9") and version_matches("", "0.0.1")


def test_compose_layers_later_wins():
    rows, warnings = compose([
        Layer("bundle:a", Path("a"), [{"insert": [{"id": "a", "name": "a", "config": {"x": 1, "y": 2}},
                                                  {"id": "a2", "name": "a/extra", "disabled": True}]}]),
        Layer("user", Path("user"), [{"id": "a", "config": {"x": 5}}, {"id": "a2", "disabled": False}]),
        Layer("project", Path("project"), [{"id": "a", "disabled": True},
                                           {"id": "a", "name": "other"},  # A wrong name: ignored.
                                           {"id": "missing", "disabled": True},
                                           {"insert": [{"id": "a", "name": "a"}]}]),  # A duplicate id.
    ])
    assert rows["a"].config == {"x": 5}  # "config" replaces the full value.
    assert rows["a"].disabled is True and rows["a"].overrides == ["user", "project"]
    assert rows["a2"].disabled is False and rows["a2"].bundle == "a"
    assert len(warnings) == 3


def test_toggle_writes_the_user_layer_unless_the_project_sets_it(harness_home, project):
    assert set_row_disabled("hello", True, project) == user_patch_path()
    assert yaml.safe_load(user_patch_path().read_text()) == [{"id": "hello", "disabled": True}]
    set_row_disabled("hello", False, project)  # The same override changes. No second patch.
    assert yaml.safe_load(user_patch_path().read_text()) == [{"id": "hello", "disabled": False}]
    project_patch_path(project).parent.mkdir(parents=True, exist_ok=True)
    project_patch_path(project).write_text("- id: hello\n  disabled: true\n")
    assert set_row_disabled("hello", False, project) == project_patch_path(project)
    assert yaml.safe_load(project_patch_path(project).read_text()) == [{"id": "hello", "disabled": False}]


# -- install and remove ------------------------------------------------------------------------------


def test_install_the_example_from_a_folder_and_remove_it(harness_home):
    item = install(str(EXAMPLE))
    assert item.name == "hello" and item.enabled and item.source == str(EXAMPLE)
    assert (harness_home / "plugins" / "hello" / "plugin.py").is_file()
    with pytest.raises(InstallError, match="already installed"):
        install(str(EXAMPLE))
    assert install(str(EXAMPLE), replace=True).name == "hello"
    set_row_disabled("hello", True, None)
    set_bundle_enabled("hello", False)
    assert not installed_bundles()[0].enabled
    remove("hello")
    assert installed_bundles() == []
    assert yaml.safe_load(user_patch_path().read_text()) == []  # The overrides of its rows are gone.


def test_install_rejects_bad_bundles(harness_home, tmp_path):
    with pytest.raises(InstallError, match="does not exist"):
        install(str(tmp_path / "nothing"))
    make_bundle(tmp_path, "new", {"plugin.py": "def apply(ctx, config): pass"}, {"engines": {"harness": ">=99"}})
    with pytest.raises(InstallError, match="needs Harness >=99"):
        install(str(tmp_path / "new"))
    make_bundle(tmp_path, "nomain", {})
    with pytest.raises(InstallError, match="main file"):
        install(str(tmp_path / "nomain"))
    bad = tmp_path / "bad"
    bad.mkdir()
    (bad / "plugin.json").write_text(json.dumps({"name": "Bad Name", "version": "1"}))
    with pytest.raises(InstallError, match="'name'"):
        install(str(bad))
    assert not any(p.name.startswith(".staging") for p in (harness_home / "plugins").iterdir())


# -- the host ----------------------------------------------------------------------------------------


def test_the_example_plugin_registers_its_parts(harness_home, project):
    install(str(EXAMPLE))
    host = load(project)
    assert host.rows["hello"].state == "active" and host.rows["hello-guard"].state == "disabled"
    assert [t.name for t in host.tools()] == ["greet"]
    ctx = ToolContext(cwd=project, settings={}, shell=detect_shell(None))
    assert asyncio.run(host.tools()[0].run({"name": "Ada"}, ctx)).output == "Hello, Ada!"
    assert list(host.commands()) == ["hello"]
    assert "greet tool" in host.prompt_sections()[0]
    assert host.skill_roots() == [(harness_home / "plugins" / "hello" / "skills", "hello")]
    assert host.tools()[0].schema(ctx)["function"]["parameters"]["required"] == ["name"]
    asyncio.run(host.dispose())
    assert host.tools() == [] and host.commands() == {} and host.prompt_sections() == [] and host.skill_roots() == []


def test_a_user_override_changes_the_config_and_turns_on_a_row(harness_home, project):
    install(str(EXAMPLE))
    user_patch_path().write_text("- id: hello\n  config: {greeting: Hi}\n- id: hello-guard\n  disabled: false\n")
    host = load(project)
    ctx = ToolContext(cwd=project, settings={}, shell=detect_shell(None))
    assert asyncio.run(host.tools()[0].run({"name": "Bo"}, ctx)).output == "Hi, Bo!"
    call = asyncio.run(host.hooks.emit("tool.before", ToolCall("bash", {"command": "rm -rf / --x"}, project)))
    assert "does not allow" in call.blocked
    ok = asyncio.run(host.hooks.emit("tool.before", ToolCall("bash", {"command": "ls"}, project)))
    assert ok.blocked is None


def test_inject_sets_the_load_order_and_errors_stay_in_one_plugin(harness_home, project):
    plugins = harness_home / "plugins"
    make_bundle(plugins, "user-of", {"plugin.py": (
        "inject = ['greeter', 'tools']\n"
        "def apply(ctx, config):\n"
        "    ctx.tools.register(name='shout', description='x', run=lambda a, c: ctx.greeter('x').upper())\n")})
    make_bundle(plugins, "zz-provider", {"plugin.py": (
        "provide = ['greeter']\n"
        "def apply(ctx, config):\n"
        "    ctx.provide('greeter', lambda n: 'hi ' + n)\n")})
    make_bundle(plugins, "broken", {"plugin.py": "def apply(ctx, config):\n    raise RuntimeError('boom')\n"})
    make_bundle(plugins, "lonely", {"plugin.py": "inject = ['nothing']\ndef apply(ctx, config): pass\n"})
    make_bundle(plugins, "typed", {"plugin.py": "Config = {'n': 1}\ndef apply(ctx, config): pass\n"})
    user_patch_path().write_text("- id: typed\n  config: {n: text}\n")
    host = load(project)
    states = {row_id: (s.state, s.error) for row_id, s in host.rows.items()}
    assert states["user-of"][0] == "active" and states["zz-provider"][0] == "active"
    ctx = ToolContext(cwd=project, settings={}, shell=detect_shell(None))
    assert asyncio.run(host.tools()[0].run({}, ctx)).output == "HI X"
    assert states["broken"] == ("failed", "RuntimeError: boom (plugin.py, line 2)")
    assert states["lonely"] == ("failed", "No active plugin provides the service: nothing.")
    assert states["typed"] == ("failed", "The config value 'n' must be a int, not a str.")


def test_a_failed_apply_removes_what_it_registered(harness_home, project):
    make_bundle(harness_home / "plugins", "half", {"plugin.py": (
        "def apply(ctx, config):\n"
        "    ctx.commands.register('half', 'x', lambda inv: 'x')\n"
        "    ctx.tools.register(name='bad name!', run=lambda a, c: 1)\n")})
    host = load(project)
    assert host.rows["half"].state == "failed" and "Not a valid tool name" in host.rows["half"].error
    assert host.commands() == {}


def test_plugin_providers_and_mcp_servers(harness_home, project):
    make_bundle(harness_home / "plugins", "infra", {"plugin.py": (
        "def apply(ctx, config):\n"
        "    ctx.providers.register('plugged', {'base_url': 'http://127.0.0.1:9/v1', 'api_key': 'k'})\n"
        "    ctx.mcp.add_server('docs', {'command': 'python', 'args': ['-V'], 'disabled': True})\n")})
    host = load(project)
    assert "plugged" in load_providers() and "fake" in load_providers()
    assert host.mcp_servers() == {"docs": {"command": "python", "args": ["-V"], "disabled": True}}
    asyncio.run(host.dispose())
    assert "plugged" not in load_providers() and PLUGIN_PROVIDERS == {}


def test_a_disabled_bundle_and_a_project_row_of_a_missing_bundle(harness_home, project):
    install(str(EXAMPLE))
    set_bundle_enabled("hello", False)
    project_patch_path(project).parent.mkdir(parents=True, exist_ok=True)
    project_patch_path(project).write_text("- insert:\n    - {id: mine, name: hello/guard}\n")
    host = load(project)
    assert list(host.rows) == ["mine"] and host.rows["mine"].state == "failed"
    assert "not installed, or it is off" in host.rows["mine"].error


def test_a_changed_plugin_file_has_an_effect_at_the_next_load(harness_home, project):
    folder = make_bundle(harness_home / "plugins", "live", {"plugin.py": (
        "def apply(ctx, config):\n    ctx.prompt.section('one')\n")})
    host = load(project)
    assert host.prompt_sections() == ["one"]
    (folder / "plugin.py").write_text("def apply(ctx, config):\n    ctx.prompt.section('two')\n")
    asyncio.run(host.load())
    assert host.prompt_sections() == ["two"]


# -- the protocol ------------------------------------------------------------------------------------


def test_a_session_uses_the_plugins(daemon, harness_home, project, fake_model):  # noqa: F811
    install(str(EXAMPLE))
    user_patch_path().write_text("- id: hello-guard\n  disabled: false\n")
    c = Client(daemon)
    ready = c.new_session(project)
    assert ready["warnings"] == []

    c.send({"type": "skills.list"})
    items = {i["name"]: i for i in c.until("skills")[0]["items"]}
    assert items["hello"]["source"] == "plugin (hello)" and items["greeting-style"]["source"] == "plugin (hello)"

    c.send({"type": "command", "name": "hello", "args": "Ada"})
    assert c.until("command.result")[0]["text"] == "Hello, Ada!"

    fake_model.script(
        {"tool_calls": [{"name": "greet", "arguments": {"name": "Bo"}},
                        {"name": "bash", "arguments": {"command": "rm -rf /"}}]},
        {"text": "Done."})
    c.send({"type": "prompt", "text": "Greet Bo, then clean up."})
    _, events = c.until("turn.end")
    results = [e for e in events if e["type"] == "tool.result"]
    assert results[0]["output"] == "Hello, Bo!"
    assert results[1]["is_error"] and "hello/guard plugin does not allow" in results[1]["output"]
    system = fake_model.requests[0]["messages"][0]["content"]
    assert "use the greet tool" in system and "greeting-style" in system

    c.send({"type": "plugins.set_plugin", "id": "hello", "enabled": False})
    listing = c.until("plugins")[0]
    rows = {r["id"]: r for r in listing["bundles"][0]["rows"]}
    assert listing["loaded"] and rows["hello"]["state"] == "disabled" and rows["hello-guard"]["state"] == "active"
    c.send({"type": "command", "name": "hello", "args": ""})
    assert "Unknown command" in c.until("error")[0]["message"]
    c.close()


def test_a_plugin_command_can_start_a_turn(daemon, harness_home, project, fake_model):  # noqa: F811
    make_bundle(harness_home / "plugins", "ask", {"plugin.py": (
        "from harness_daemon.plugins import Prompt\n"
        "def apply(ctx, config):\n"
        "    ctx.commands.register('ask', 'Ask the agent.', lambda inv: Prompt('Answer: ' + inv.args))\n")})
    c = Client(daemon)
    c.new_session(project)
    fake_model.script({"text": "42"})
    c.send({"type": "command", "name": "ask", "args": "the question"})
    c.until("turn.end")
    user = [m for m in fake_model.requests[0]["messages"] if m["role"] == "user"]
    assert user[-1]["content"] == "Answer: the question"
    c.close()


def test_plugins_screen_with_no_session_and_install(daemon, harness_home):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "plugins.list"})
    empty = c.until("plugins")[0]
    assert empty["bundles"] == [] and empty["loaded"] is False
    c.send({"type": "plugins.install", "source": str(EXAMPLE)})
    listing = c.until("plugins")[0]
    assert listing["installed"] == "hello" and listing["bundles"][0]["version"] == "0.1.0"
    assert listing["bundles"][0]["icon"].startswith("data:image/svg+xml;base64,")
    assert {r["id"]: r["state"] for r in listing["bundles"][0]["rows"]} == {"hello": "idle", "hello-guard": "disabled"}
    c.send({"type": "plugins.install", "source": str(EXAMPLE)})
    assert "already installed" in c.until("error")[0]["message"]
    c.send({"type": "plugins.remove", "name": "hello"})
    assert c.until("plugins")[0]["removed"] == "hello"
    c.close()


def test_prompt_type_is_exported():
    assert Prompt("x").text == "x"


def test_python_plugins_get_the_loop_events(daemon, harness_home, project, fake_model):  # noqa: F811
    make_bundle(harness_home / "plugins", "loop", {"plugin.py": (
        "stopped = set()\n"
        "def apply(ctx, config):\n"
        "    def step(e):\n"
        "        if e.step == 1:\n"
        "            e.messages = ['[step] ' + m for m in e.messages]\n"
        "    def request(e):\n"
        "        e.temperature = 0.5\n"
        "    def before(call):\n"
        "        if call.name == 'glob':\n"
        "            call.ask('loop asks')\n"
        "    def after(call):\n"
        "        if call.name == 'glob':\n"
        "            call.add_context('glob done')\n"
        "    def stopping(e):\n"
        "        if e.turn not in stopped:\n"
        "            stopped.add(e.turn)\n"
        "            e.steer('one more')\n"
        "    ctx.on('step.before', step)\n"
        "    ctx.on('request.before', request)\n"
        "    ctx.on('tool.before', before)\n"
        "    ctx.on('tool.after', after)\n"
        "    ctx.on('turn.stopping', stopping)\n")})
    c = Client(daemon)
    c.new_session(project)
    fake_model.script({"tool_calls": [{"name": "glob", "arguments": {"pattern": "*.py"}}]}, {"text": "a"}, {"text": "b"})
    c.send({"type": "prompt", "text": "Hi"})
    request = c.until("permission.request", timeout=30)[0]
    assert request["tool"] == "glob" and request["reason"] == "loop asks" and request["rule"] is None
    c.send({"type": "permission.reply", "request_id": request["request_id"], "decision": "allow_once"})
    assert c.until("turn.end", timeout=30)[0]["stop_reason"] == "end"
    first, second, third = fake_model.requests
    assert first["messages"][-1] == {"role": "user", "content": "[step] Hi"} and first["temperature"] == 0.5
    assert second["messages"][-1] == {"role": "user", "content": "glob done"}
    assert third["messages"][-1] == {"role": "user", "content": "one more"}
    c.close()


def test_a_deepseek_install_asks_before_the_mirror(daemon, monkeypatch):  # noqa: F811
    from harness_daemon import server

    mirror = "https://registry.npmmirror.com/"
    calls: list[dict] = []

    async def request(method, params, timeout=None):
        calls.append(params)
        if not params.get("useMirror"):
            raise DshError("The npm registry cannot be reached.", data={"mirror": mirror})
        raise DshError("The mirror failed too.")

    monkeypatch.setattr(server.DSH, "request", request)
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "plugins.install", "kind": "deepseek", "source": "dsh-plugin-guide"})
    error = c.until("error")[0]
    assert error["ref"] == "plugins.install"
    assert error["data"] == {"mirror": mirror, "source": "dsh-plugin-guide", "use_mirror": False}
    assert calls == [{"spec": "dsh-plugin-guide", "approvedBuilds": [], "useMirror": False}]

    # The user agrees: the client sends the install again with use_mirror.
    c.send({"type": "plugins.install", "kind": "deepseek", "source": "dsh-plugin-guide", "use_mirror": True})
    error = c.until("error")[0]
    assert error["message"] == "The mirror failed too." and error.get("data") is None
    assert calls[1]["useMirror"] is True
    c.close()
