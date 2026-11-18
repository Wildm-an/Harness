"""Settings > Agents: the sign-in state, the usage, the enabled agents, and the model choices (agent_auth.py)."""

from __future__ import annotations

import json

from harness_daemon import acp_harnesses, agent_auth
from test_server import Client, daemon  # noqa: F401 - the daemon fixture


def test_the_status_of_a_subscription():
    state = agent_auth.parse_status({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
                                     "subscriptionType": "max", "email": "a@b.c"})
    assert state == {"status": "authenticated", "label": "Claude Max", "detail": "", "subscription": True}
    assert "email" not in json.dumps(state)


def test_the_status_of_other_sign_ins():
    assert agent_auth.parse_status({"loggedIn": False})["status"] == "unauthenticated"
    assert agent_auth.parse_status({"loggedIn": True, "apiProvider": "bedrock"})["label"] == "Amazon Bedrock"
    assert agent_auth.parse_status({"loggedIn": True, "authMethod": "api_key"})["label"] == "API key"
    assert agent_auth.parse_status("bad")["status"] == "unknown"


def test_no_claude_program():
    state = agent_auth.read_status(None)
    assert state["status"] == "unknown" and state["install_url"] == agent_auth.INSTALL_URL


def test_the_usage_limits():
    response = {"rate_limits_available": True, "rate_limits": {"limits": [
        {"group": "session", "percent": 6, "resets_at": "2026-11-16T20:20:00+00:00", "severity": "normal"},
        {"group": "weekly", "percent": 41, "resets_at": "2026-11-20T19:00:00+00:00"},
        {"group": "weekly", "percent": 153, "scope": {"model": {"display_name": "Fable", "id": None}}},
        {"group": "weekly"},  # No percent: not shown.
    ]}}
    limits = agent_auth.parse_usage(response)
    assert [(u["label"], u["percent"]) for u in limits] == [("5-hour limit", 6.0), ("Weekly", 41.0), ("Weekly · Fable", 100.0)]
    assert limits[0]["resets_at"] == "2026-11-16T20:20:00+00:00"


def test_the_old_usage_form_and_no_usage():
    response = {"rate_limits": {"five_hour": {"utilization": 12, "resets_at": "r"}, "seven_day": None}}
    assert agent_auth.parse_usage(response) == [{"label": "5-hour limit", "percent": 12.0, "resets_at": "r", "severity": "normal"}]
    assert agent_auth.parse_usage({"rate_limits_available": False}) == []
    assert agent_auth.parse_usage(None) == []


def test_the_enabled_agents_include_the_operating_harness():
    assert acp_harnesses.enabled_ids({}) == []
    assert acp_harnesses.enabled_ids({"operating_harness": "opencode"}) == ["opencode"]
    assert acp_harnesses.enabled_ids({"agents_enabled": ["claude-acp"], "operating_harness": "harness"}) == ["claude-acp"]


def test_the_models_of_the_last_session(harness_home):
    assert acp_harnesses.cached_models("claude-acp") == []
    assert acp_harnesses.models_checked("claude-acp") is None and acp_harnesses.implied_model("claude-acp") is None
    acp_harnesses.save_models("claude-acp", [{"id": "default", "name": "Default", "description": ""}])
    assert acp_harnesses.cached_models("claude-acp")[0]["id"] == "default"
    assert acp_harnesses.models_checked("claude-acp") is not None
    # Only a default alias: no model to imply.
    assert acp_harnesses.implied_model("claude-acp") is None


def test_the_model_of_new_sessions_with_no_choice(harness_home):
    """As T3 Code: the current model of the harness, else its first model. A default alias does not count."""
    default = {"id": "default", "name": "Default (recommended)", "description": "", "current": True}
    opus = {"id": "opus", "name": "Opus", "description": ""}
    sonnet = {"id": "sonnet", "name": "Sonnet", "description": ""}
    acp_harnesses.save_models("claude-acp", [default, opus, sonnet])
    assert acp_harnesses.implied_model("claude-acp") == "opus"
    acp_harnesses.save_models("claude-acp", [default, opus, {**sonnet, "current": True}])
    assert acp_harnesses.implied_model("claude-acp") == "sonnet"
    assert acp_harnesses.is_default_alias({"id": "auto", "name": "Default model"})
    assert not acp_harnesses.is_default_alias(opus)


def test_enable_and_the_model_choices(daemon):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "agents.enable", "id": "opencode", "enabled": True})
    opencode = next(i for i in c.until("harnesses")[0]["items"] if i["id"] == "opencode")
    assert opencode["enabled"] is True and opencode["can_sign_in"] is False and opencode["auth"] is None

    # One model for a harness: a model of the harness itself replaces a provider model, and the reverse.
    c.send({"type": "harnesses.model", "id": "opencode", "model": "fake/smart"})
    c.until("harnesses")
    c.send({"type": "harnesses.native_model", "id": "opencode", "model": "anthropic/sonnet"})
    opencode = next(i for i in c.until("harnesses")[0]["items"] if i["id"] == "opencode")
    assert opencode["native_model"] == "anthropic/sonnet" and opencode["provider_model"] is None
    c.send({"type": "harnesses.model", "id": "opencode", "model": "fake/smart"})
    opencode = next(i for i in c.until("harnesses")[0]["items"] if i["id"] == "opencode")
    assert opencode["native_model"] is None and opencode["provider_model"] == "fake/smart"

    c.send({"type": "harnesses.native_model", "id": "nope", "model": "x"})
    assert "Unknown harness" in c.until("error")[0]["message"]
    c.send({"type": "agents.check", "id": "gemini"})  # No sign-in and no program update.
    assert "cannot check" in c.until("error")[0]["message"]
    c.send({"type": "agents.signin.input", "id": "claude-acp", "data": "x"})
    assert "No sign-in runs" in c.until("error")[0]["message"]

    c.send({"type": "agents.enable", "id": "opencode", "enabled": False})
    opencode = next(i for i in c.until("harnesses")[0]["items"] if i["id"] == "opencode")
    assert opencode["enabled"] is False
    c.close()


def test_safe_icons():
    from harness_daemon import acp_icons
    assert acp_icons.safe_svg(b'<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M0 0h1v1z"/></svg>')
    assert not acp_icons.safe_svg(b'<svg><script>alert(1)</script></svg>')
    assert not acp_icons.safe_svg(b'<svg onload="x()"></svg>')
    assert not acp_icons.safe_svg(b'<svg><foreignObject></foreignObject></svg>')
    assert not acp_icons.safe_svg(b"<html></html>")
    assert not acp_icons.safe_svg(b"<svg>" + b" " * (acp_icons.MAX_BYTES + 1) + b"</svg>")


def test_the_icon_of_a_kept_file(harness_home):
    from harness_daemon import acp_icons
    acp_icons._cache.clear()
    folder = harness_home / "harnesses" / "icons"
    folder.mkdir(parents=True)
    (folder / "opencode.svg").write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>')
    (folder / "bad.svg").write_bytes(b"<svg><script/></svg>")
    assert acp_icons.icon("opencode").startswith("data:image/svg+xml;base64,")
    assert acp_icons.icon("bad") is None and acp_icons.icon("../x") is None
    acp_icons._cache.clear()


def test_the_models_of_session_new():
    from harness_daemon.acp import parse_models
    result = {"models": {"availableModels": [{"modelId": "opus", "name": "Opus"}, {"name": "no id"}], "currentModelId": "opus"}}
    assert parse_models(result) == [{"id": "opus", "name": "Opus", "description": "", "current": True}]
    config = {"configOptions": [{"category": "model", "type": "select", "currentValue": "b", "options": [
        {"group": "A", "options": [{"value": "a1", "name": "A one"}]}, {"value": "b", "description": "B"}]}]}
    assert [(m["id"], m.get("current", False)) for m in parse_models(config)] == [("a1", False), ("b", True)]
    assert parse_models(None) == []


def test_the_logos_have_their_brand_colors(harness_home):
    import base64
    from harness_daemon import acp_icons
    acp_icons._cache.clear()
    folder = harness_home / "harnesses" / "icons"
    folder.mkdir(parents=True, exist_ok=True)
    for name in ("claude-acp", "opencode"):
        (folder / f"{name}.svg").write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M0 0"/></svg>')
    svg = lambda i: base64.b64decode(acp_icons.icon(i).split(",", 1)[1])
    assert b'fill="#D97757"' in svg("claude-acp") and b"currentColor" not in svg("claude-acp")
    assert b"currentColor" in svg("opencode")  # No brand color: the client shows it in the text color of the theme.
    # Hermes Agent is not in the registry: Harness ships its logo.
    hermes = svg("hermes")
    assert hermes.startswith(b"<svg") and len(hermes) <= acp_icons.MAX_BYTES and acp_icons.safe_svg(hermes)
    acp_icons._cache.clear()


def test_the_auto_mode_model(daemon, harness_home):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "harnesses.list"})
    assert c.until("harnesses")[0]["auto_model"] is None
    c.send({"type": "agents.auto_model", "model": "fake/smart"})
    assert c.until("harnesses")[0]["auto_model"] == "fake/smart"
    data = json.loads((harness_home / "settings.json").read_text())
    assert data["auto_mode"]["model"] == "fake/smart"
    c.send({"type": "agents.auto_model", "model": "nothing"})
    assert "must be" in c.until("error")[0]["message"]
    c.send({"type": "agents.auto_model", "model": None})
    assert c.until("harnesses")[0]["auto_model"] is None
    assert "auto_mode" not in json.loads((harness_home / "settings.json").read_text())
    c.close()


def test_the_oh_my_pi_logo_ships_with_harness():
    import base64
    from harness_daemon import acp_icons
    acp_icons._cache.pop("omp", None)
    svg = base64.b64decode(acp_icons.icon("omp").split(",", 1)[1])
    assert svg.startswith(b"<svg") and b"#f97316" in svg and acp_icons.safe_svg(svg)
