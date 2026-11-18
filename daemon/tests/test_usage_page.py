"""The Usage page (usage.py): the histories of the agents, the prices, and the summary."""

from __future__ import annotations

import json
import sqlite3
import time

from harness_daemon import usage
from test_server import Client, daemon  # noqa: F401 - the daemon fixture

NOW = 1794870000.0  # 2026-11-16, a fixed time for the tests.


def _claude_line(msg_id: str, req: str, ts: str, model: str = "claude-opus-5-5", **usage_fields) -> str:
    u = {"input_tokens": 2, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 300, "output_tokens": 50,
         "cache_creation": {"ephemeral_1h_input_tokens": 100}, "output_tokens_details": {"thinking_tokens": 20}}
    u.update(usage_fields)
    return json.dumps({"type": "assistant", "timestamp": ts, "sessionId": "s1", "requestId": req,
                       "message": {"id": msg_id, "model": model, "usage": u}})


def test_claude_transcripts(tmp_path):
    path = tmp_path / "a.jsonl"
    path.write_text("\n".join([
        json.dumps({"type": "user", "message": {"content": "hi"}}),
        _claude_line("m1", "r1", "2026-11-16T10:00:00Z"),
        _claude_line("m2", "r2", "2026-11-16T11:00:00Z", model="<synthetic>"),
        "not json",
    ]))
    found = list(usage.parse_claude(path))
    assert len(found) == 1
    r = found[0]
    assert (r.key, r.input, r.cache_read, r.cache_write, r.cache_write_1h, r.output, r.reasoning) == \
        ("claude:m1:r1", 2, 1000, 300, 100, 50, 20)


def test_opencode_and_hermes_databases(tmp_path):
    db = tmp_path / "opencode.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INT, time_created INT, data TEXT)")
    con.execute("INSERT INTO session_message VALUES ('m1','s1','assistant',1,1794869000000,?)", (json.dumps(
        {"model": {"id": "big-pickle"}, "cost": 0, "tokens": {"input": 10, "output": 5, "reasoning": 3,
                                                               "cache": {"read": 7, "write": 1}}}),))
    con.commit()
    con.close()
    (r,) = list(usage.parse_opencode(db))
    assert (r.model, r.input, r.cache_read, r.cache_write, r.output, r.reasoning, r.cost) == ("big-pickle", 10, 7, 1, 8, 3, None)

    state = tmp_path / "state.db"
    con = sqlite3.connect(state)
    con.execute("CREATE TABLE sessions (id TEXT, started_at REAL)")
    con.execute("CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, task TEXT, "
                "input_tokens INT, output_tokens INT, cache_read_tokens INT, cache_write_tokens INT, reasoning_tokens INT, "
                "estimated_cost_usd REAL, actual_cost_usd REAL, first_seen REAL, last_seen REAL)")
    con.execute("INSERT INTO sessions VALUES ('h1', 1794860000)")
    con.execute("INSERT INTO session_model_usage VALUES ('h1','glm-5.3','custom','',100,20,300,0,0,0,0.5,NULL,1794869000)")
    con.commit()
    con.close()
    (h,) = list(usage.parse_hermes(state))
    assert (h.model, h.input, h.cache_read, h.output, h.cost, h.ts) == ("glm-5.3", 100, 300, 20, 0.5, 1794869000.0)


def test_prices_and_aliases():
    rates = usage.parse_rates({
        "sample_spec": {"input_cost_per_token": 1},
        "claude-opus-5-5": {"input_cost_per_token": 5e-6, "output_cost_per_token": 25e-6,
                            "cache_read_input_token_cost": 5e-7, "cache_creation_input_token_cost": 6.25e-6,
                            "cache_creation_input_token_cost_above_1hr": 1e-5},
        "openrouter/some-model": {"input_cost_per_token": 3e-6, "output_cost_per_token": 3e-6},
        "openai/some-model": {"input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6},
        "no-output": {"input_cost_per_token": 1e-6},
    })
    assert usage.rate_for(rates, "claude-opus-5-5[1m]").standard.output == 25e-6
    assert usage.rate_for(rates, "some-model").standard.input == 1e-6  # The first-party provider wins.
    assert usage.rate_for(rates, "opus") is None and usage.rate_for(rates, "no-output") is None
    record = usage.Record(provider="claude", key="k", ts=NOW, model="claude-opus-5-5", session="s", input=1_000_000,
                          cache_read=1_000_000, cache_write=1_000_000, cache_write_1h=500_000, output=1_000_000)
    p = usage.price(record, rates["claude-opus-5-5"])
    assert p.source == "model" and round(p.parts["cache_write"], 4) == round(500_000 * 6.25e-6 + 500_000 * 1e-5, 4)
    assert round(p.cost, 4) == round(5 + 0.5 + p.parts["cache_write"] + 25, 4) and p.premium == 0
    assert round(p.savings, 4) == round(1_000_000 * (5e-6 - 5e-7), 4)
    reported = usage.Record(provider="opencode", key="k2", ts=NOW, model="x", session="s", input=10, cost=0.25)
    unsplit = usage.price(reported, None)
    assert (unsplit.cost, unsplit.parts["other"], unsplit.source) == (0.25, 0.25, "reported")
    scaled = usage.price(usage.Record(provider="claude", key="k3", ts=NOW, model="m", session="s", input=1_000_000,
                                      output=1_000_000, cost=60.0), rates["claude-opus-5-5"])
    assert scaled.cost == 60.0 and round(scaled.parts["output"], 6) == 50.0  # The parts get the scale of 60 / 30.


def test_speed_and_context_tiers():
    rates = usage.parse_rates({
        "claude-x": {"input_cost_per_token": 5e-6, "output_cost_per_token": 25e-6, "cache_read_input_token_cost": 5e-7,
                     "provider_specific_entry": {"us": 1.1, "fast": 6}},
        "gpt-x": {"input_cost_per_token": 5e-6, "output_cost_per_token": 30e-6, "cache_read_input_token_cost": 5e-7,
                  "input_cost_per_token_priority": 12.5e-6, "output_cost_per_token_priority": 75e-6,
                  "input_cost_per_token_above_272k_tokens": 10e-6, "output_cost_per_token_above_272k_tokens": 45e-6,
                  "input_cost_per_token_flex": 2.5e-6, "output_cost_per_token_flex": 15e-6},
    })
    claude, gpt = rates["claude-x"], rates["gpt-x"]
    assert round(claude.fast.output, 12) == 150e-6 and claude.ultrafast is None and claude.tiers == ()
    # A missing priority cache rate keeps the ratio of the standard rates: 5e-7 / 5e-6 x 12.5e-6.
    assert round(gpt.fast.cache_read, 12) == round(1.25e-6, 12)
    assert [t for t, _ in gpt.tiers] == [272_000]
    fast = usage.Record(provider="claude", key="f", ts=NOW, model="claude-x", session="s", input=1_000_000,
                        output=1_000_000, speed="fast")
    p = usage.price(fast, claude)
    assert round(p.cost, 6) == 180.0 and round(p.premium, 6) == 150.0
    small = usage.Record(provider="codex", key="s", ts=NOW, model="gpt-x", session="s", input=100_000, output=1000)
    large = usage.Record(provider="codex", key="l", ts=NOW, model="gpt-x", session="s", input=300_000, output=1000)
    assert usage.rates_at(gpt, "standard", small).input == 5e-6
    assert usage.rates_at(gpt, "standard", large).input == 10e-6  # The whole request bills at the tier.
    assert usage.rates_at(gpt, "fast", large).input == 12.5e-6  # The tier has no priority rate: the base fast rate.
    assert usage._speed("priority") == "fast" and usage._speed(None) == "standard"


def test_custom_prices_and_map_to(harness_home):
    import pytest
    with pytest.raises(ValueError):
        usage.clean_prices({"m": {"input": 1}})
    with pytest.raises(ValueError):
        usage.clean_prices({"m": {"input": -1, "output": 1}})
    saved = usage.write_prices({" my-model ": {"input": 2, "output": "", "cache_read": None} | {"output": 4},
                                "preview-x": {"map_to": "claude-x"}, "empty": {}})
    assert saved == {"my-model": {"input": 2.0, "output": 4.0}, "preview-x": {"map_to": "claude-x"}}
    assert usage.read_prices() == saved
    rates = usage.parse_rates({"claude-x": {"input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6}})
    found = [
        usage.Record(provider="opencode", key="a", ts=NOW - 60, model="my-model", session="o", input=1_000_000, cost=9.0),
        usage.Record(provider="claude", key="b", ts=NOW - 60, model="preview-x", session="c", input=1_000_000),
        usage.Record(provider="claude", key="c", ts=NOW - 60, model="claude-x", session="c", output=1_000_000),
    ]
    data = usage.summarize("7d", 0, rates, {"status": "fresh", "updated_at": NOW}, found, 1, [], [], now=NOW,
                           prices=saved)
    by_model = {m["model"]: m for m in data["models"]}
    assert set(by_model) == {"my-model", "claude-x"}  # preview-x counts as claude-x.
    assert by_model["my-model"]["cost"] == 2.0 and by_model["my-model"]["custom_price"]  # The custom price wins.
    assert by_model["claude-x"]["mapped_from"] == ["preview-x"] and round(by_model["claude-x"]["cost"], 6) == 3.0
    assert by_model["claude-x"]["rate"] == {"input": 1.0, "output": 2.0, "cache_read": 1.0, "cache_write": 1.0}
    assert data["prices"] == saved


def test_windows_and_the_summary():
    start, end, resolution, buckets = usage.window("7d", 0, now=NOW)
    assert resolution == "day" and len(buckets) == 7 and buckets[-1][0] == "2026-11-16"
    _, _, hourly, hours = usage.window("24h", -300, now=NOW)
    assert hourly == "hour" and len(hours) == 24
    rates = usage.parse_rates({"claude-opus-5-5": {"input_cost_per_token": 1e-6, "output_cost_per_token": 2e-6}})
    found = [
        usage.Record(provider="claude", key="a", ts=NOW - 3600, model="claude-opus-5-5", session="s1", input=100, output=10),
        usage.Record(provider="claude", key="b", ts=NOW - 7200, model="claude-opus-5-5", session="s2", input=100, output=10),
        usage.Record(provider="opencode", key="c", ts=NOW - 60, model="big-pickle", session="o1", input=5, output=5),
        usage.Record(provider="claude", key="old", ts=NOW - 30 * 86400, model="claude-opus-5-5", session="s3", input=9),
    ]
    data = usage.summarize("7d", 0, rates, {"status": "fresh", "updated_at": NOW}, found, 1, [], [], now=NOW)
    assert data["totals"]["records"] == 3 and data["totals"]["sessions"] == 3 and data["totals"]["unpriced_records"] == 1
    assert [p["id"] for p in data["providers"]] == ["claude", "opencode"]
    claude = data["providers"][0]
    assert claude["sessions"] == 2 and round(claude["cost"], 8) == round(2 * (100e-6 + 20e-6), 8)
    assert data["models"][-1] == {"model": "big-pickle", "provider": "opencode", "cost": 0.0, "premium": 0.0,
                                  "reported": 0.0, "tokens": 10, "input": 5, "cache_read": 0, "cache_write": 0,
                                  "output": 5, "custom_price": False, "mapped_from": [], "rate": None, "unpriced": True}
    assert sum(p["by_provider"].get("claude", {}).get("tokens", 0) for p in data["series"]) == 220


def test_scan_counts_a_copied_request_one_time(harness_home, monkeypatch, tmp_path):
    projects = tmp_path / "claude" / "projects" / "p"
    projects.mkdir(parents=True)
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now - 60))
    (projects / "one.jsonl").write_text(_claude_line("m1", "r1", stamp))
    (projects / "two.jsonl").write_text(_claude_line("m1", "r1", stamp) + "\n" + _claude_line("m2", "r2", stamp))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    monkeypatch.setattr(usage, "codex_roots", lambda: [])
    monkeypatch.setattr(usage, "opencode_roots", lambda: [])
    monkeypatch.setattr(usage, "hermes_roots", lambda: [])
    usage.scan()
    found = usage.records(now - 3600, now + 1)
    assert sorted(r.key for r in found) == ["claude:m1:r1", "claude:m2:r2"]
    usage.scan()  # No change: the files are not read again.
    assert len(usage.records(now - 3600, now + 1)) == 2


def test_the_usage_message(daemon, monkeypatch):  # noqa: F811
    c = Client(daemon)
    c.until("auth.ok")
    c.send({"type": "usage.summary", "range": "1y", "offset": 0})
    assert "'range' must be" in c.until("error")[0]["message"]
    c.send({"type": "usage.summary", "range": "7d", "offset": 0})
    reply = c.until("usage.summary", timeout=60)[0]
    assert reply["range"] == "7d" and len(reply["series"]) == 7 and "totals" in reply
    c.send({"type": "usage.prices.set", "models": {"m": {"input": 1}}})
    error = c.until("error")[0]
    assert error["ref"] == "usage.prices.set" and "needs an input price" in error["message"]
    c.send({"type": "usage.prices.set", "models": {"m": {"input": 1, "output": 2}, "n": {"map_to": "m"}}})
    assert c.until("usage.prices")[0]["models"] == {"m": {"input": 1.0, "output": 2.0}, "n": {"map_to": "m"}}
    c.send({"type": "usage.summary", "range": "7d", "offset": 0})
    assert c.until("usage.summary", timeout=60)[0]["prices"]["n"] == {"map_to": "m"}
    c.close()


def test_codex_speed_and_map_to_chains(tmp_path):
    path = tmp_path / "rollout.jsonl"
    count = {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 100, "cached_input_tokens": 40,
                                                                  "output_tokens": 10}}}
    path.write_text("\n".join(json.dumps(line) for line in [
        {"type": "session_meta", "payload": {"id": "c1"}},
        {"type": "turn_context", "payload": {"model": "gpt-x"}},
        {"timestamp": "2026-11-16T10:00:00Z", "type": "event_msg", "payload": count},
        {"type": "event_msg", "payload": {"type": "thread_settings_applied", "thread_settings": {"service_tier": "priority"}}},
        {"timestamp": "2026-11-16T10:01:00Z", "type": "event_msg", "payload": count},
    ]))
    assert [r.speed for r in usage.parse_codex(path)] == ["standard", "fast"]
    chain = {"a": {"map_to": "b"}, "b": {"map_to": "c"}, "x": {"map_to": "y"}, "y": {"map_to": "x"}}
    assert usage.resolve_model(chain, "a") == "c" and usage.resolve_model(chain, "x") == "x"
    assert usage.resolve_model(chain, "other") == "other"


def test_codex_limits(tmp_path):
    from harness_daemon import codex_limits
    snapshot = {"limitId": "codex", "planType": "plus",
                "primary": {"usedPercent": 41, "resetsAt": NOW, "windowDurationMins": 300},
                "secondary": {"usedPercent": 12.5, "resetsAt": NOW + 86400},
                "individualLimit": {"remainingPercent": 70, "resetsAt": NOW}}
    rows = codex_limits.windows(snapshot)
    assert [(r["label"], r["percent"]) for r in rows] == [("5-hour limit", 41.0), ("Weekly", 12.5),
                                                          ("Monthly credit limit", 30.0)]
    assert rows[0]["resets_at"] == "2026-11-16T23:00:00Z" and codex_limits.plan_label(snapshot) == "ChatGPT Plus"
    assert codex_limits.windows({**snapshot, "limitId": "gpt-x-mini"}) == []  # A limit of one model.
    assert codex_limits.windows({"planType": "free", "primary": {"usedPercent": 5}})[0]["label"] == "Monthly"
    day = tmp_path / "sessions" / "2026" / "11" / "16"
    day.mkdir(parents=True)
    (day / "rollout.jsonl").write_text("\n".join(json.dumps(line) for line in [
        {"timestamp": "2026-11-16T10:00:00Z", "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {
            "primary": {"used_percent": 3, "window_minutes": 300, "resets_in_seconds": 60}}}},
        {"timestamp": "2026-11-16T11:00:00Z", "type": "event_msg", "payload": {"type": "token_count", "rate_limits": {
            "primary": {"used_percent": 9, "window_minutes": 300, "resets_in_seconds": 600},
            "secondary": {"used_percent": 20, "window_minutes": 10080, "resets_at": NOW + 3600}}}},
    ]))
    limits, at = codex_limits.read_rollout(tmp_path / "sessions")
    rows = codex_limits.windows(limits, now=at)
    assert [(r["label"], r["percent"]) for r in rows] == [("5-hour limit", 9.0), ("Weekly", 20.0)]
    assert rows[0]["resets_at"] == "2026-11-16T11:10:00Z"
