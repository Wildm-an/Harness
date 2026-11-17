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
    assert usage.rate_for(rates, "claude-opus-5-5[1m]").output == 25e-6
    assert usage.rate_for(rates, "some-model").input == 1e-6  # The first-party provider wins.
    assert usage.rate_for(rates, "opus") is None and usage.rate_for(rates, "no-output") is None
    record = usage.Record(provider="claude", key="k", ts=NOW, model="claude-opus-5-5", session="s", input=1_000_000,
                          cache_read=1_000_000, cache_write=1_000_000, cache_write_1h=500_000, output=1_000_000)
    cost, parts, savings, priced = usage.price(record, rates["claude-opus-5-5"])
    assert priced and round(parts["cache_write"], 4) == round(500_000 * 6.25e-6 + 500_000 * 1e-5, 4)
    assert round(cost, 4) == round(5 + 0.5 + parts["cache_write"] + 25, 4)
    assert round(savings, 4) == round(1_000_000 * (5e-6 - 5e-7), 4)
    reported = usage.Record(provider="opencode", key="k2", ts=NOW, model="x", session="s", input=10, cost=0.25)
    assert usage.price(reported, None)[0] == 0.25 and usage.price(reported, None)[3]


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
    assert data["models"][-1] == {"model": "big-pickle", "provider": "opencode", "cost": 0.0, "tokens": 10, "input": 5,
                                  "cache_read": 0, "cache_write": 0, "output": 5, "unpriced": True}
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
    c.close()
