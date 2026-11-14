"""The result files of a run: run.json, results.jsonl, and summary.md."""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

from harness_daemon import __version__

from .checks import CheckResult, grade, uses_text_checks
from .trial import Trial

SCHEMA = 1


def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True, timeout=10,
                              cwd=Path(__file__).resolve().parents[2]).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def run_info(model: str, trials: int, command: list[str]) -> dict[str, Any]:
    return {"schema": SCHEMA, "harness_version": __version__, "commit": _git("rev-parse", "--short", "HEAD"),
            "dirty": bool(_git("status", "--porcelain")), "model": model, "trials": trials,
            "os": platform.platform(), "python": sys.version.split()[0], "cpu": platform.processor(),
            "cpu_count": os.cpu_count(), "started_at": time.time(), "command": command}


def trial_result(trial: Trial, number: int) -> dict[str, Any]:
    task = trial.task
    status, checks = "pass", []
    if trial.error:
        status = "error"
    elif trial.timed_out:
        status = "timeout"
    else:
        required = grade(task.require, trial)
        if not all(c.passed for c in required):
            status, checks = "invalid", required
        else:
            checks = grade(task.checks, trial)
            status = "pass" if all(c.passed for c in checks) else "fail"
    return {
        "task": task.id, "behavior": task.behavior, "polarity": task.polarity, "trial": number, "status": status,
        "checks": [{"name": c.name, "passed": c.passed, "detail": c.detail} for c in checks],
        "stop_reasons": trial.stop_reasons, "tool_calls": sum(1 for e in trial.events if e.get("type") == "tool.start"),
        "error": trial.error, "text_checks": uses_text_checks(task.checks), **trial.usage(),
    }


def summary(results: list[dict[str, Any]]) -> str:
    """The pass rate of each task, of each behavior, and of each pair."""
    by_task: dict[str, list[dict]] = defaultdict(list)
    for r in results:
        by_task[r["task"]].append(r)
    lines = ["| Task | Behavior | Polarity | Pass | Valid trials | Other |", "|---|---|---|---|---|---|"]
    for task, rows in sorted(by_task.items()):
        valid = [r for r in rows if r["status"] in ("pass", "fail")]
        passed = sum(1 for r in valid if r["status"] == "pass")
        other = ", ".join(f"{s}: {n}" for s, n in _count(r["status"] for r in rows if r["status"] not in ("pass", "fail")))
        mark = " (text check)" if rows[0]["text_checks"] else ""
        lines.append(f"| {task}{mark} | {rows[0]['behavior']} | {rows[0]['polarity']} | {passed} | {len(valid)} | {other} |")
    total_valid = [r for r in results if r["status"] in ("pass", "fail")]
    rate = sum(r["status"] == "pass" for r in total_valid) / len(total_valid) if total_valid else 0.0
    lines += ["", f"Pass rate of the valid trials: {rate:.0%} ({len(total_valid)} trials)."]
    return "\n".join(lines) + "\n"


def _count(values) -> list[tuple[str, int]]:
    counts: dict[str, int] = defaultdict(int)
    for v in values:
        counts[v] += 1
    return sorted(counts.items())


def compare(results: list[dict[str, Any]], baseline: list[dict[str, Any]]) -> list[str]:
    """The tasks whose pass count changed against a baseline results.jsonl."""
    def passes(rows):
        out: dict[str, int] = defaultdict(int)
        for r in rows:
            out[r["task"]] += r["status"] == "pass"
        return out

    now, before = passes(results), passes(baseline)
    return [f"{t}: {before.get(t, 0)} -> {now.get(t, 0)}" for t in sorted(set(now) | set(before))
            if now.get(t, 0) != before.get(t, 0)]


def write(out: Path, info: dict[str, Any], results: list[dict[str, Any]]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "run.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
    (out / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in results), encoding="utf-8")
    (out / "summary.md").write_text(summary(results), encoding="utf-8")


__all__ = ["CheckResult", "compare", "run_info", "summary", "trial_result", "write"]
