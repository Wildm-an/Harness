"""The Usage page: the token use and the API cost estimate of the agents on the daemon computer.

The design comes from the Usage page of T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.). As T3 Code, Harness reads the
local history of each agent, and it prices the tokens with the model prices of LiteLLM ("API estimate"):

- Claude Code (also Claude Agent): ``<CLAUDE_CONFIG_DIR or ~/.claude>/projects/**/*.jsonl``, the ``assistant`` lines.
  One request is ``message.id:requestId``. A copy of a request (a resumed session) counts one time.
- Codex: ``<CODEX_HOME or ~/.codex>/sessions/**/*.jsonl``, the ``token_count`` events (``last_token_usage``).
- OpenCode: ``<OPENCODE_DATA_DIR or XDG_DATA_HOME/opencode or ~/.local/share/opencode>/opencode*.db``, the
  assistant messages (``session_message`` and the older ``message`` table).
- Hermes Agent: ``<HERMES_HOME>/state.db``, the table ``session_model_usage``.
- Harness: the run records of the built-in loop (``model_requests`` of ``harness.db``).

Harness keeps the parsed records in ``~/.harness/usage-cache.db``. A file that did not change is not read again.
The prices come from ``model_prices_and_context_window.json`` of LiteLLM, at most once a day, kept in
``~/.harness/usage-model-rates.json``. The request has no data about the user.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import re
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator

from . import acp_icons, agent_auth
from .config import harness_home, read_json, write_json

log = logging.getLogger("harness.usage")

PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
PRICES_TTL = 24 * 3600
MAX_DAYS = 92  # The longest range (90 days) and a margin for the time zone.
RANGES = {"24h": 1, "7d": 7, "30d": 30, "90d": 90}
NEVER_PRICED = {"<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable", "default"}
FIRST_PARTY = ("anthropic", "openai", "gemini", "xai", "deepseek", "meta", "mistral")


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    agent: str  # The agent id for the icon of the client (AgentIcon).
    color: str


PROVIDERS = {
    "claude": Provider("claude", "Claude Code", "claude-acp", "#d97757"),
    "codex": Provider("codex", "Codex", "codex-acp", "#8b8b8b"),
    "opencode": Provider("opencode", "OpenCode", "opencode", "#5b9bbd"),
    "hermes": Provider("hermes", "Hermes Agent", "hermes", "#8c7bd1"),
    "harness": Provider("harness", "Harness", "harness", "#4d9f8a"),
}


@dataclass
class Record:
    provider: str
    key: str  # The same request in two files has the same key: it counts one time.
    ts: float  # Seconds since 1970.
    model: str
    session: str
    input: int = 0  # With no cache.
    cache_read: int = 0
    cache_write: int = 0
    cache_write_1h: int = 0  # A part of cache_write.
    output: int = 0  # With the reasoning.
    reasoning: int = 0
    cost: float | None = None  # The cost that the agent reported. None: estimate it.


# -- the histories of the agents ----------------------------------------------------------------------------------------


def _int(value: Any) -> int:
    return value if isinstance(value, int) and value > 0 else 0


def _iso(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def claude_roots() -> list[Path]:
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return [Path(base) / "projects" if base else Path.home() / ".claude" / "projects"]


def parse_claude(path: Path) -> Iterator[Record]:
    """The requests of a Claude Code transcript."""
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"assistant"' not in line or '"usage"' not in line:
                continue
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if data.get("type") != "assistant" or not isinstance(data.get("message"), dict):
                continue
            message = data["message"]
            usage = message.get("usage")
            model = str(message.get("model") or "")
            if not isinstance(usage, dict) or not model or model in ("<synthetic>",):
                continue
            ts = _iso(data.get("timestamp"))
            if ts is None:
                continue
            creation = usage.get("cache_creation") if isinstance(usage.get("cache_creation"), dict) else {}
            details = usage.get("output_tokens_details") if isinstance(usage.get("output_tokens_details"), dict) else {}
            key = f"claude:{message.get('id') or ''}:{data.get('requestId') or ''}"
            if key == "claude::":
                key = f"claude:{path.name}:{data.get('uuid') or ts}"
            cost = data.get("costUSD")
            yield Record(
                provider="claude", key=key, ts=ts, model=model, session=str(data.get("sessionId") or path.stem),
                input=_int(usage.get("input_tokens")), cache_read=_int(usage.get("cache_read_input_tokens")),
                cache_write=_int(usage.get("cache_creation_input_tokens")),
                cache_write_1h=_int(creation.get("ephemeral_1h_input_tokens")),
                output=_int(usage.get("output_tokens")), reasoning=_int(details.get("thinking_tokens")),
                cost=float(cost) if isinstance(cost, (int, float)) and cost > 0 else None)


def codex_roots() -> list[Path]:
    base = os.environ.get("CODEX_HOME")
    return [(Path(base) if base else Path.home() / ".codex") / "sessions"]


def parse_codex(path: Path) -> Iterator[Record]:
    """The requests of a Codex rollout: each token_count event, with the model of the last turn_context."""
    model, session = "", path.stem
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for number, line in enumerate(f):
            try:
                data = json.loads(line)
            except ValueError:
                continue
            payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
            kind = data.get("type")
            if kind == "session_meta" and payload.get("id"):
                session = str(payload["id"])
            elif kind == "turn_context" and payload.get("model"):
                model = str(payload["model"])
            elif kind == "event_msg" and payload.get("type") == "token_count":
                info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                last = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else None
                ts = _iso(data.get("timestamp"))
                if not last or ts is None or not model:
                    continue
                cached = _int(last.get("cached_input_tokens"))
                yield Record(provider="codex", key=f"codex:{session}:{number}", ts=ts, model=model, session=session,
                             input=max(0, _int(last.get("input_tokens")) - cached), cache_read=cached,
                             output=_int(last.get("output_tokens")), reasoning=_int(last.get("reasoning_output_tokens")))


def opencode_roots() -> list[Path]:
    if os.environ.get("OPENCODE_DATA_DIR"):
        return [Path(os.environ["OPENCODE_DATA_DIR"])]
    xdg = os.environ.get("XDG_DATA_HOME")
    return [(Path(xdg) if xdg else Path.home() / ".local" / "share") / "opencode"]


def _readonly(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)


def parse_opencode(path: Path) -> Iterator[Record]:
    """The assistant messages of an OpenCode database. A cost of 0 is estimated from the prices."""
    db = _readonly(path)
    try:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        rows: list[tuple[str, str, int, str]] = []
        if "session_message" in tables:
            rows += db.execute("SELECT id, session_id, time_created, data FROM session_message "
                               "WHERE type = 'assistant'").fetchall()
        if "message" in tables:
            rows += db.execute("SELECT id, session_id, time_created, data FROM message").fetchall()
    finally:
        db.close()
    for message_id, session, created, raw in rows:
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if data.get("role") not in (None, "assistant"):
            continue
        tokens = data.get("tokens") if isinstance(data.get("tokens"), dict) else None
        if not tokens:
            continue
        model_info = data.get("model") if isinstance(data.get("model"), dict) else {}
        model = str(model_info.get("id") or data.get("modelID") or "")
        if not model:
            continue
        cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
        cost = data.get("cost")
        reasoning = _int(tokens.get("reasoning"))
        yield Record(provider="opencode", key=f"opencode:{message_id}", ts=(created or 0) / 1000, model=model,
                     session=str(session), input=_int(tokens.get("input")), cache_read=_int(cache.get("read")),
                     cache_write=_int(cache.get("write")), output=_int(tokens.get("output")) + reasoning,
                     reasoning=reasoning, cost=float(cost) if isinstance(cost, (int, float)) and cost > 0 else None)


def hermes_roots() -> list[Path]:
    if os.environ.get("HERMES_HOME"):
        return [Path(os.environ["HERMES_HOME"])]
    roots = [Path.home() / ".hermes"]
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        roots.insert(0, Path(os.environ["LOCALAPPDATA"]) / "hermes")
    return roots


def parse_hermes(path: Path) -> Iterator[Record]:
    """The token use of each session and model of Hermes Agent (state.db). The time is the last use of the row."""
    db = _readonly(path)
    try:
        rows = db.execute("SELECT u.session_id, u.model, u.billing_provider, u.task, u.input_tokens, u.output_tokens, "
                          "u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens, u.estimated_cost_usd, "
                          "u.actual_cost_usd, COALESCE(u.last_seen, u.first_seen, s.started_at) "
                          "FROM session_model_usage u LEFT JOIN sessions s ON s.id = u.session_id").fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        db.close()
    for session, model, billing, task, inp, out, cread, cwrite, reasoning, estimated, actual, seen in rows:
        if not model or not seen:
            continue
        cost = actual if isinstance(actual, (int, float)) and actual > 0 else \
            estimated if isinstance(estimated, (int, float)) and estimated > 0 else None
        yield Record(provider="hermes", key=f"hermes:{session}:{model}:{billing}:{task}", ts=float(seen), model=str(model),
                     session=str(session), input=_int(inp), cache_read=_int(cread), cache_write=_int(cwrite),
                     output=_int(out), reasoning=_int(reasoning), cost=float(cost) if cost else None)


def parse_harness(path: Path) -> Iterator[Record]:
    """The model requests of the built-in loop of Harness (records.py). prompt_tokens has the cached tokens."""
    db = _readonly(path)
    try:
        rows = db.execute("SELECT rowid, session_id, model, started_at, prompt_tokens, completion_tokens, cached_tokens, "
                          "reasoning_tokens FROM model_requests WHERE prompt_tokens IS NOT NULL").fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        db.close()
    for rowid, session, model, started, prompt, completion, cached, reasoning in rows:
        cached = _int(cached)
        yield Record(provider="harness", key=f"harness:{rowid}", ts=float(started), model=str(model), session=str(session),
                     input=max(0, _int(prompt) - cached), cache_read=cached, output=_int(completion),
                     reasoning=_int(reasoning))


def _files(roots: list[Path], pattern: str, since: float) -> list[Path]:
    """The files under the roots that changed since ``since``: an older file has no use in the ranges."""
    found: list[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.rglob(pattern):
            try:
                if path.is_file() and path.stat().st_mtime >= since:
                    found.append(path)
            except OSError:
                continue
    return found


def _db_mtime(path: Path) -> float:
    """The change time of a SQLite database, also of its write-ahead log."""
    times = []
    for p in (path, Path(f"{path}-wal")):
        try:
            times.append(p.stat().st_mtime)
        except OSError:
            pass
    return max(times) if times else 0.0


Source = tuple[str, Path, Callable[[Path], Iterator[Record]], float, int]  # provider, file, parser, mtime, size


def sources(since: float) -> list[Source]:
    """The history files of all the agents, with their change time and size."""
    found: list[Source] = []

    def add(provider: str, path: Path, parser: Callable[[Path], Iterator[Record]], mtime: float | None = None) -> None:
        try:
            stat = path.stat()
        except OSError:
            return
        found.append((provider, path, parser, mtime if mtime is not None else stat.st_mtime, stat.st_size))

    for path in _files(claude_roots(), "*.jsonl", since):
        add("claude", path, parse_claude)
    for path in _files(codex_roots(), "*.jsonl", since):
        add("codex", path, parse_codex)
    for root in opencode_roots():
        if root.is_dir():
            for path in root.glob("opencode*.db"):
                add("opencode", path, parse_opencode, _db_mtime(path))
    for root in hermes_roots():
        path = root / "state.db"
        if path.is_file():
            add("hermes", path, parse_hermes, _db_mtime(path))
            break
    harness_db = harness_home() / "harness.db"
    if harness_db.is_file():
        add("harness", harness_db, parse_harness, _db_mtime(harness_db))
    return found


# -- the cache of the parsed records ------------------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, provider TEXT NOT NULL, mtime REAL NOT NULL, size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records (
    file TEXT NOT NULL, provider TEXT NOT NULL, key TEXT NOT NULL, ts REAL NOT NULL, model TEXT NOT NULL,
    session TEXT NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
    cache_write_1h INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL, cost REAL);
CREATE INDEX IF NOT EXISTS records_ts ON records (ts);
CREATE INDEX IF NOT EXISTS records_file ON records (file);
"""

_scan_lock = threading.Lock()


def _cache() -> sqlite3.Connection:
    db = sqlite3.connect(harness_home() / "usage-cache.db", timeout=30)
    db.executescript(_SCHEMA)
    return db


def scan(errors: list[dict[str, str]] | None = None) -> None:
    """Read the files that changed since the last scan. It blocks: call it in a thread."""
    since = time.time() - MAX_DAYS * 86400
    with _scan_lock:
        db = _cache()
        try:
            known = {row[0]: (row[1], row[2]) for row in db.execute("SELECT path, mtime, size FROM files")}
            current = sources(since)
            seen = set()
            for provider, path, parser, mtime, size in current:
                name = str(path)
                seen.add(name)
                if known.get(name) == (mtime, size):
                    continue
                try:
                    rows = [(name, r.provider, r.key, r.ts, r.model, r.session, r.input, r.cache_read, r.cache_write,
                             r.cache_write_1h, r.output, r.reasoning, r.cost) for r in parser(path) if r.ts >= since]
                except (OSError, sqlite3.Error) as e:
                    if errors is not None:
                        errors.append({"provider": provider, "message": f"Could not read {path.name}: {e}"})
                    continue
                db.execute("DELETE FROM records WHERE file = ?", (name,))
                db.executemany("INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
                db.execute("INSERT OR REPLACE INTO files VALUES (?,?,?,?)", (name, provider, mtime, size))
            for name in set(known) - seen:  # A file that is gone, or older than the longest range.
                db.execute("DELETE FROM records WHERE file = ?", (name,))
                db.execute("DELETE FROM files WHERE path = ?", (name,))
            db.execute("DELETE FROM records WHERE ts < ?", (since,))
            db.commit()
        finally:
            db.close()


def records(start: float, end: float) -> list[Record]:
    """The records in [start, end). A request with copies counts one time: the largest count of each kind."""
    db = _cache()
    try:
        rows = db.execute(
            "SELECT provider, key, MIN(ts), MAX(model), MAX(session), MAX(input), MAX(cache_read), MAX(cache_write), "
            "MAX(cache_write_1h), MAX(output), MAX(reasoning), MAX(cost) FROM records "
            "WHERE ts >= ? AND ts < ? GROUP BY key", (start, end)).fetchall()
    finally:
        db.close()
    return [Record(provider=r[0], key=r[1], ts=r[2], model=r[3], session=r[4], input=r[5], cache_read=r[6],
                   cache_write=r[7], cache_write_1h=r[8], output=r[9], reasoning=r[10], cost=r[11]) for r in rows]


# -- the prices (LiteLLM) -----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Rate:
    input: float  # USD for one token.
    output: float
    cache_read: float
    cache_write: float  # 5 minutes.
    cache_write_1h: float


def _rates_path() -> Path:
    return harness_home() / "usage-model-rates.json"


def parse_rates(data: Any) -> dict[str, Rate]:
    """The rates of the LiteLLM price file, by model id (lower case), with the aliases of T3 Code: "provider/model"
    also gives "model" (a first-party provider wins), and "anthropic.X" (Bedrock) gives "X"."""
    rates: dict[str, Rate] = {}
    aliases: dict[str, tuple[int, Rate]] = {}
    if not isinstance(data, dict):
        return rates
    for name, entry in data.items():
        if not isinstance(entry, dict) or name == "sample_spec":
            continue
        inp, out = entry.get("input_cost_per_token"), entry.get("output_cost_per_token")
        if not isinstance(inp, (int, float)) or not isinstance(out, (int, float)):
            continue
        read = entry.get("cache_read_input_token_cost")
        write = entry.get("cache_creation_input_token_cost")
        write_1h = entry.get("cache_creation_input_token_cost_above_1hr")
        read = float(read) if isinstance(read, (int, float)) else float(inp)
        write = float(write) if isinstance(write, (int, float)) else float(inp)
        rate = Rate(float(inp), float(out), read, write, float(write_1h) if isinstance(write_1h, (int, float)) else write)
        key = name.strip().lower()
        rates[key] = rate
        bare = None
        rank = 99
        if "/" in key:
            prefix, bare = key.split("/", 1)
            rank = FIRST_PARTY.index(prefix) if prefix in FIRST_PARTY else 50
        elif key.startswith("anthropic."):
            bare, rank = key.removeprefix("anthropic."), 60
        if bare and (bare not in aliases or rank < aliases[bare][0]):
            aliases[bare] = (rank, rate)
    for bare, (_, rate) in aliases.items():
        rates.setdefault(bare, rate)
    return rates


def rate_for(rates: dict[str, Rate], model: str) -> Rate | None:
    key = re.sub(r"\[.*?\]$", "", model.strip().lower())
    if not key or key in NEVER_PRICED:
        return None
    for candidate in (key, re.sub(r"-\d{8}$", "", key), key.split("/", 1)[-1]):
        if candidate in rates:
            return rates[candidate]
    return None


_rates: dict[str, Rate] | None = None
_rates_status: dict[str, Any] = {"status": "unavailable", "updated_at": None}


async def load_rates(force: bool = False) -> tuple[dict[str, Rate], dict[str, Any]]:
    """The rates: the copy of today, else a new download, else an old copy."""
    global _rates, _rates_status
    saved = await asyncio.to_thread(read_json, _rates_path(), {})
    fetched = saved.get("fetched_at") if isinstance(saved, dict) else None
    fresh = isinstance(fetched, (int, float)) and time.time() - fetched < PRICES_TTL
    if _rates is not None and fresh and not force:
        return _rates, _rates_status
    if fresh and not force and isinstance(saved.get("data"), dict):
        _rates = parse_rates(saved["data"])
        _rates_status = {"status": "fresh", "updated_at": fetched}
        return _rates, _rates_status
    from .nethttp import async_client

    try:
        async with async_client(timeout=30, follow_redirects=True) as client:
            response = await client.get(PRICES_URL)
            response.raise_for_status()
            data = response.json()
        _rates = parse_rates(data)
        if _rates:
            now = time.time()
            await asyncio.to_thread(write_json, _rates_path(), {"fetched_at": now, "data": data})
            _rates_status = {"status": "fresh", "updated_at": now}
            return _rates, _rates_status
    except Exception as e:  # noqa: BLE001 - no network: an old copy, or no prices.
        log.info("Could not download the model prices: %s", e)
    if isinstance(saved, dict) and isinstance(saved.get("data"), dict):
        _rates = parse_rates(saved["data"])
        _rates_status = {"status": "cached", "updated_at": fetched}
    else:
        _rates, _rates_status = {}, {"status": "unavailable", "updated_at": None}
    return _rates, _rates_status


# -- the summary --------------------------------------------------------------------------------------------------------


def window(range_id: str, offset_min: int, now: float | None = None) -> tuple[float, float, str, list[tuple[str, str, float]]]:
    """The start and the end of the range, the resolution, and the buckets (key, label, start). ``offset_min``: the
    minutes of the local time of the client east of UTC."""
    now = time.time() if now is None else now
    tz = dt.timezone(dt.timedelta(minutes=offset_min))
    local = dt.datetime.fromtimestamp(now, tz)
    buckets: list[tuple[str, str, float]] = []
    if range_id == "24h":
        top = local.replace(minute=0, second=0, microsecond=0)
        for i in range(23, -1, -1):
            at = top - dt.timedelta(hours=i)
            hour = at.hour % 12 or 12
            buckets.append((at.strftime("%Y-%m-%dT%H"), f"{hour} {'AM' if at.hour < 12 else 'PM'}", at.timestamp()))
        return now - 24 * 3600, now + 1, "hour", buckets
    days = RANGES.get(range_id, 30)
    today = local.replace(hour=0, minute=0, second=0, microsecond=0)
    for i in range(days - 1, -1, -1):
        at = today - dt.timedelta(days=i)
        buckets.append((at.strftime("%Y-%m-%d"), f"{at.strftime('%b')} {at.day}", at.timestamp()))
    return buckets[0][2], now + 1, "day", buckets


def _empty_totals() -> dict[str, Any]:
    return {"tokens": 0, "input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "reasoning": 0, "cost": 0.0,
            "cache_savings": 0.0, "sessions": 0, "records": 0, "unpriced_records": 0}


def price(record: Record, rate: Rate | None) -> tuple[float, dict[str, float], float, bool]:
    """The cost of one request, its parts, the cache savings, and True when it has a price."""
    parts = {"input": 0.0, "cache_read": 0.0, "cache_write": 0.0, "output": 0.0, "other": 0.0}
    savings = 0.0
    if rate is not None:
        parts["input"] = record.input * rate.input
        parts["cache_read"] = record.cache_read * rate.cache_read
        five = max(0, record.cache_write - record.cache_write_1h)
        parts["cache_write"] = five * rate.cache_write + record.cache_write_1h * rate.cache_write_1h
        parts["output"] = record.output * rate.output
        savings = record.cache_read * max(0.0, rate.input - rate.cache_read)
    estimate = sum(parts.values())
    if record.cost is not None:  # The agent reported the cost: it wins, and the parts get its scale.
        if estimate > 0:
            parts = {k: v * record.cost / estimate for k, v in parts.items()}
        else:
            parts["other"] = record.cost
        return record.cost, parts, savings, True
    return estimate, parts, savings, rate is not None


def summarize(range_id: str, offset_min: int, rates: dict[str, Rate], pricing: dict[str, Any],
              found: list[Record], scan_ms: int, errors: list[dict[str, str]], limits: list[dict[str, Any]],
              now: float | None = None) -> dict[str, Any]:
    start, end, resolution, buckets = window(range_id, offset_min, now)
    tz = dt.timezone(dt.timedelta(minutes=offset_min))
    keys = {key for key, _, _ in buckets}
    series = {key: {"key": key, "label": label, "by_provider": {}} for key, label, _ in buckets}
    totals = _empty_totals()
    categories = {"input": 0.0, "cache_read": 0.0, "cache_write": 0.0, "output": 0.0, "other": 0.0}
    providers: dict[str, dict[str, Any]] = {}
    sessions: dict[str, set[str]] = {}
    models: dict[tuple[str, str], dict[str, Any]] = {}
    for record in found:
        if not (start <= record.ts < end):
            continue
        rate = rate_for(rates, record.model)
        cost, parts, savings, priced = price(record, rate)
        tokens = record.input + record.cache_read + record.cache_write + record.output
        local = dt.datetime.fromtimestamp(record.ts, tz)
        bucket = local.strftime("%Y-%m-%dT%H" if resolution == "hour" else "%Y-%m-%d")
        if bucket not in keys:
            continue
        p = providers.setdefault(record.provider, _empty_totals())
        m = models.setdefault((record.provider, record.model), {
            "model": record.model, "provider": record.provider, "cost": 0.0, "tokens": 0, "input": 0, "cache_read": 0,
            "cache_write": 0, "output": 0, "priced": False})
        for target in (totals, p):
            target["tokens"] += tokens
            target["input"] += record.input
            target["cache_read"] += record.cache_read
            target["cache_write"] += record.cache_write
            target["output"] += record.output
            target["reasoning"] += record.reasoning
            target["cost"] += cost
            target["cache_savings"] += savings
            target["records"] += 1
            target["unpriced_records"] += 0 if priced else 1
        m["cost"] += cost
        m["tokens"] += tokens
        for name in ("input", "cache_read", "cache_write", "output"):
            m[name] += getattr(record, name)
        m["priced"] = m["priced"] or priced
        for name, value in parts.items():
            categories[name] += value
        sessions.setdefault(record.provider, set()).add(record.session)
        point = series[bucket]["by_provider"].setdefault(record.provider, {"cost": 0.0, "tokens": 0})
        point["cost"] += cost
        point["tokens"] += tokens
    out_providers = []
    for pid, values in providers.items():
        info = PROVIDERS.get(pid) or Provider(pid, pid, pid, "#8b8b8b")
        values["sessions"] = len(sessions.get(pid, set()))
        out_providers.append({**values, "id": pid, "name": info.name, "agent": info.agent,
                              "icon": None if info.agent == "harness" else acp_icons.icon(info.agent), "color": info.color})
    out_providers.sort(key=lambda p: (-p["cost"], -p["tokens"]))
    totals["sessions"] = sum(p["sessions"] for p in out_providers)
    out_models = [{**{k: v for k, v in m.items() if k != "priced"}, "unpriced": not m["priced"]} for m in models.values()]
    out_models.sort(key=lambda m: (-m["cost"], -m["tokens"]))
    return {
        "range": range_id, "resolution": resolution, "generated_at": time.time() if now is None else now,
        "scan_ms": scan_ms, "pricing": pricing, "totals": totals, "category_cost": categories,
        "providers": out_providers, "series": [series[key] for key, _, _ in buckets], "models": out_models,
        "limits": limits, "errors": errors,
    }


async def limits() -> list[dict[str, Any]]:
    """The subscription limits of the agents (the Limits tab): now Claude Code, with its sign-in (agent_auth.py)."""
    out = []
    state = await agent_auth.STATES.check(agent_auth.CLAUDE_ID)
    if state and state.get("usage"):
        out.append({"provider": "claude", "name": f"Claude Code · {state.get('label') or 'subscription'}",
                    "agent": agent_auth.CLAUDE_ID, "icon": acp_icons.icon(agent_auth.CLAUDE_ID), "windows": state["usage"]})
    return out


async def summary(range_id: str, offset_min: int, refresh: bool = False) -> dict[str, Any]:
    """The data of the Usage page for a range."""
    if range_id not in RANGES:
        raise ValueError(f"The range must be one of: {', '.join(RANGES)}.")
    errors: list[dict[str, str]] = []
    began = time.monotonic()
    await asyncio.to_thread(scan, errors)
    scan_ms = int((time.monotonic() - began) * 1000)
    rates, pricing = await load_rates(force=refresh)
    start, end, _, _ = window(range_id, offset_min)
    found = await asyncio.to_thread(records, start, end)
    try:
        windows = await limits()
    except Exception as e:  # noqa: BLE001 - the limits are extra information.
        log.info("The subscription limits are not available: %s", e)
        windows = []
    return await asyncio.to_thread(summarize, range_id, offset_min, rates, pricing, found, scan_ms, errors, windows)
