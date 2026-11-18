"""The subscription limits of Codex (the Limits tab of the Usage page), as T3 Code (MIT) reads them.

- The main source: ``codex app-server`` (the JSON-RPC server of the Codex CLI on the PATH) with the requests
  ``initialize`` and ``account/rateLimits/read``. Codex reads its own ChatGPT sign-in. Harness never reads the
  credentials of Codex. The check sends no prompt, so it uses no tokens.
- The fallback, with no ``codex`` program (Codex Agent runs through the ACP adapter): the ``rate_limits`` of the last
  ``token_count`` event in the newest rollout under ``<CODEX_HOME or ~/.codex>/sessions``. This value is from the
  last turn, so the label says when Codex reported it.

The windows follow T3 Code: ``primary`` is the 5-hour window (30 days on the Free and Go plans), ``secondary`` is the
weekly window, and a limit id other than "codex" is a limit of one model, which does not show.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from . import __version__

log = logging.getLogger("harness.codex_limits")

TTL = 300.0  # Seconds between two checks (T3 Code waits 5 minutes).
TIMEOUT = 30.0
SESSION_MINS = 5 * 60
WEEK_MINS = 7 * 24 * 60
MONTH_MINS = 30 * 24 * 60
_PLANS = {"plus": "Plus", "pro": "Pro", "team": "Team", "business": "Business", "enterprise": "Enterprise",
          "edu": "Edu", "free": "Free", "go": "Go"}


def codex_binary() -> str | None:
    return shutil.which("codex")


def _no_window() -> dict[str, Any]:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}  # type: ignore[attr-defined]


def _iso(epoch: Any) -> str | None:
    if isinstance(epoch, bool) or not isinstance(epoch, (int, float)) or epoch <= 0:
        return None
    return dt.datetime.fromtimestamp(float(epoch), dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _label(mins: float) -> str:
    if mins >= MONTH_MINS:
        return "Monthly"
    if mins >= WEEK_MINS:
        return "Weekly"
    if mins == SESSION_MINS:
        return "5-hour limit"  # The name of Claude Code /usage, for the same window.
    hours = mins / 60
    return f"{hours:g}-hour limit" if hours >= 1 else "Session"


def _field(window: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in window and window[name] is not None:
            return window[name]
    return None


def windows(snapshot: Any, now: float | None = None) -> list[dict[str, Any]]:
    """The rows of LimitRows (label, percent, resets_at, severity) of a rate limit snapshot. It reads the camelCase
    fields of the app server and the snake_case fields of a rollout (``resets_in_seconds`` is from ``now``)."""
    if not isinstance(snapshot, dict):
        return []
    limit_id = _field(snapshot, "limitId", "limit_id")
    if limit_id and limit_id != "codex":
        return []
    plan = str(_field(snapshot, "planType", "plan_type") or "").lower()
    monthly_plan = plan in ("free", "go")
    out: list[dict[str, Any]] = []
    for key, fallback in (("primary", MONTH_MINS if monthly_plan else SESSION_MINS), ("secondary", WEEK_MINS)):
        window = snapshot.get(key)
        if not isinstance(window, dict):
            continue
        used = _field(window, "usedPercent", "used_percent")
        if isinstance(used, bool) or not isinstance(used, (int, float)):
            continue
        mins = _field(window, "windowDurationMins", "window_minutes", "windowMinutes")
        mins = float(mins) if isinstance(mins, (int, float)) and not isinstance(mins, bool) and mins > 0 else fallback
        resets = _iso(_field(window, "resetsAt", "resets_at"))
        after = _field(window, "resets_in_seconds", "resetsInSeconds")
        if resets is None and isinstance(after, (int, float)) and now is not None:
            resets = _iso(now + float(after))
        out.append({"label": _label(mins), "percent": max(0.0, min(100.0, float(used))), "resets_at": resets,
                    "severity": "normal"})
    individual = _field(snapshot, "individualLimit", "individual_limit")
    if isinstance(individual, dict):
        remaining = _field(individual, "remainingPercent", "remaining_percent")
        if isinstance(remaining, (int, float)) and not isinstance(remaining, bool):
            out.append({"label": "Monthly credit limit", "percent": max(0.0, min(100.0, 100.0 - float(remaining))),
                        "resets_at": _iso(_field(individual, "resetsAt", "resets_at")), "severity": "normal"})
    return out


def plan_label(snapshot: Any) -> str:
    plan = str(_field(snapshot, "planType", "plan_type") or "") if isinstance(snapshot, dict) else ""
    return f"ChatGPT {_PLANS.get(plan.lower(), plan.capitalize())}" if plan else "subscription"


def read_app_server(binary: str) -> dict[str, Any]:
    """Ask ``codex app-server`` for the rate limits. It blocks: call it in a thread. The result is the
    ``account/rateLimits/read`` result: ``rateLimits`` and ``rateLimitsByLimitId``."""
    proc = subprocess.Popen([binary, "app-server"], cwd=str(Path.home()), stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
                            errors="replace", **_no_window())
    assert proc.stdin is not None and proc.stdout is not None
    timer = threading.Timer(TIMEOUT, proc.kill)  # A silent server must not hold the thread.
    timer.start()

    def send(msg: dict[str, Any]) -> None:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()

    def reply(request_id: int) -> dict[str, Any]:
        assert proc.stdout is not None
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("id") == request_id and "method" not in msg:
                if isinstance(msg.get("error"), dict):
                    error = msg["error"]
                    raise RuntimeError(f"Codex could not read the usage (JSON-RPC {error.get('code')}): "
                                       f"{error.get('message') or 'no message'}")
                result = msg.get("result")
                return result if isinstance(result, dict) else {}
        raise RuntimeError("Codex stopped before it gave the usage.")

    try:
        send({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "harness", "title": "Harness", "version": __version__},
            "capabilities": {"experimentalApi": True}}})
        reply(1)
        send({"method": "initialized"})
        send({"id": 2, "method": "account/rateLimits/read"})
        return reply(2)
    finally:
        timer.cancel()
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def _sessions_root() -> Path:
    base = os.environ.get("CODEX_HOME")
    return (Path(base) if base else Path.home() / ".codex") / "sessions"


def read_rollout(root: Path | None = None, newest: int = 5) -> tuple[dict[str, Any], float] | None:
    """The last ``rate_limits`` of the newest rollouts, with the time of its event. It blocks."""
    root = root or _sessions_root()
    if not root.is_dir():
        return None
    files = []
    for path in root.rglob("*.jsonl"):
        try:
            files.append((path.stat().st_mtime, path))
        except OSError:
            continue
    for _, path in sorted(files, reverse=True)[:newest]:
        found: tuple[dict[str, Any], float] | None = None
        try:
            with path.open("r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if '"rate_limits"' not in line:
                        continue
                    try:
                        data = json.loads(line)
                    except ValueError:
                        continue
                    payload = data.get("payload") if isinstance(data, dict) else None
                    limits = payload.get("rate_limits") if isinstance(payload, dict) else None
                    if isinstance(limits, dict) and limits:
                        stamp = data.get("timestamp")
                        try:
                            at = dt.datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
                        except ValueError:
                            at = path.stat().st_mtime
                        found = (limits, at)
        except OSError:
            continue
        if found:
            return found
    return None


_cache: tuple[float, dict[str, Any] | None] | None = None
_lock = asyncio.Lock()


async def limits(force: bool = False) -> dict[str, Any] | None:
    """The Codex row of the Limits tab: {"name", "windows", "reported_at"}, or None when Codex reports no limits.
    ``reported_at``: the ISO time of the rollout event (the fallback), else None (a check now)."""
    global _cache
    async with _lock:
        if not force and _cache is not None and time.time() - _cache[0] < TTL:
            return _cache[1]
        result: dict[str, Any] | None = None
        binary = codex_binary()
        if binary:
            try:
                data = await asyncio.to_thread(read_app_server, binary)
                by_id = data.get("rateLimitsByLimitId") if isinstance(data.get("rateLimitsByLimitId"), dict) else {}
                snapshot = by_id.get("codex") or data.get("rateLimits")
                rows = windows(snapshot)
                if rows:
                    result = {"name": f"Codex · {plan_label(snapshot)}", "windows": rows, "reported_at": None}
            except Exception as e:  # noqa: BLE001 - the limits are extra information.
                log.info("The Codex limits are not available from the app server: %s", e)
        if result is None:
            found = await asyncio.to_thread(read_rollout)
            if found:
                snapshot, at = found
                rows = windows(snapshot, now=at)
                if rows:
                    stamp = dt.datetime.fromtimestamp(at, dt.timezone.utc).isoformat().replace("+00:00", "Z")
                    result = {"name": f"Codex · {plan_label(snapshot)}", "windows": rows, "reported_at": stamp}
        _cache = (time.time(), result)
        return result
