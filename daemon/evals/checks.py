"""The checks of a trial. Each check is code: no model grades a trial.

A check is a dict with a "type" and its fields. The result of a trial is "pass" when all its checks pass.
"""

from __future__ import annotations

import difflib
import fnmatch
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .trial import Trial, file_text, workspace_files


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str = ""


def _match(pattern: str | None, text: str) -> bool:
    return pattern is None or re.search(pattern, text, re.S) is not None


def _turn_events(trial: Trial, turn: int | None) -> list[dict[str, Any]]:
    """The events of one turn (1 is the first prompt), or all the events if ``turn`` is None."""
    if turn is None:
        return trial.events
    ends = [i for i, e in enumerate(trial.events) if e.get("type") == "turn.end"]
    if turn >= 2 and len(ends) < turn - 1:
        return []
    start = ends[turn - 2] + 1 if turn >= 2 else 0
    end = ends[turn - 1] + 1 if len(ends) >= turn else len(trial.events)
    return trial.events[start:end]


def _calls(trial: Trial, turn: int | None = None) -> list[dict[str, Any]]:
    return [e for e in _turn_events(trial, turn) if e.get("type") == "tool.start"]


def _call_matches(event: dict[str, Any], spec: dict[str, Any]) -> bool:
    """``name`` is one tool name or a list of names. ``args`` is a pattern for the JSON of the arguments."""
    names = spec.get("name")
    name_ok = event.get("name") in names if isinstance(names, list) else event.get("name") == names
    return name_ok and _match(spec.get("args"), json.dumps(event.get("input"), ensure_ascii=False))


def _requests(trial: Trial, kind: str | None) -> list[dict[str, Any]]:
    return [e for e in trial.events if e.get("type") == "permission.request" and e.get("kind") == kind]


def check_command(c: dict, trial: Trial) -> CheckResult:
    if c.get("copy_hidden") and trial.task.hidden.is_dir():
        shutil.copytree(trial.task.hidden, trial.workspace, dirs_exist_ok=True)
    command = str(c["run"]).replace("{python}", f'"{sys.executable}"')
    out = subprocess.run(command, shell=True, cwd=trial.workspace, capture_output=True, text=True,
                         timeout=int(c.get("timeout", 120)))
    tail = (out.stdout + out.stderr)[-400:]
    return CheckResult("command", out.returncode == 0, f"exit {out.returncode}: {tail}")


def check_file_contains(c: dict, trial: Trial) -> CheckResult:
    text = file_text(trial.workspace / c["path"])
    return CheckResult("file_contains", text is not None and c["text"] in text, c["path"])


def check_file_not_contains(c: dict, trial: Trial) -> CheckResult:
    text = file_text(trial.workspace / c["path"])
    return CheckResult("file_not_contains", text is None or c["text"] not in text, c["path"])


def check_file_equals(c: dict, trial: Trial) -> CheckResult:
    """``strip: true`` ignores the white space at the start and at the end, for example a last line end."""
    text = file_text(trial.workspace / c["path"])
    if c.get("strip") and text is not None:
        return CheckResult("file_equals", text.replace("\r\n", "\n").strip() == str(c["text"]).strip(), c["path"])
    return CheckResult("file_equals", text == c["text"], c["path"])


def check_file_exists(c: dict, trial: Trial) -> CheckResult:
    return CheckResult("file_exists", (trial.workspace / c["path"]).exists(), c["path"])


def check_file_absent(c: dict, trial: Trial) -> CheckResult:
    return CheckResult("file_absent", not (trial.workspace / c["path"]).exists(), c["path"])


def _hidden_copies(trial: Trial, now: dict[str, str]) -> set[str]:
    """The files that a ``copy_hidden`` check copied in. The agent did not make them."""
    if not trial.task.hidden.is_dir():
        return set()
    hidden = workspace_files(trial.task.hidden)
    return {p for p, digest in hidden.items() if now.get(p) == digest and p not in trial.baseline}


def _changed(trial: Trial) -> list[str]:
    now = workspace_files(trial.workspace)
    copies = _hidden_copies(trial, now)
    return sorted(p for p in set(now) | set(trial.baseline) if now.get(p) != trial.baseline.get(p) and p not in copies)


def check_changed(c: dict, trial: Trial) -> CheckResult:
    """Each path in ``paths`` changed: new content, a new file, or a removed file."""
    changed = _changed(trial)
    missing = [p for p in c["paths"] if p not in changed]
    return CheckResult("changed", not missing, f"not changed: {missing}")


def _agent_files(trial: Trial, globs: list[str]) -> list[str]:
    """The workspace files that match one of the globs, with no hidden copies, no .git, and no caches."""
    now = workspace_files(trial.workspace)
    copies = _hidden_copies(trial, now)
    return sorted(p for p in now if p not in copies and any(fnmatch.fnmatchcase(p, g) for g in globs))


def _pattern_hits(c: dict, trial: Trial) -> list[str]:
    pattern = re.compile(c["pattern"], re.M | (re.I if c.get("ignore_case") else 0))
    return [p for p in _agent_files(trial, c.get("paths") or ["*"])
            if (text := file_text(trial.workspace / p)) is not None and pattern.search(text)]


def check_pattern_absent(c: dict, trial: Trial) -> CheckResult:
    """No file in ``paths`` has a match of ``pattern``. ``paths`` are globs ("*" also matches "/"). Default: all."""
    hits = _pattern_hits(c, trial)
    return CheckResult("pattern_absent", not hits, f"{c['pattern']} in {hits}")


def check_pattern_present(c: dict, trial: Trial) -> CheckResult:
    """One file in ``paths`` or more has a match of ``pattern``."""
    hits = _pattern_hits(c, trial)
    return CheckResult("pattern_present", bool(hits), f"{c['pattern']} in {hits}")


def memory_files(trial: Trial) -> list[Path]:
    """The memory files of the trial daemon (its HARNESS_HOME is <trial>/home), with no MEMORY.md index."""
    home = trial.workspace.parent / "home"
    return sorted(p for p in home.glob("projects/*/memory/*.md") if p.name != "MEMORY.md")


def check_memory_files(c: dict, trial: Trial) -> CheckResult:
    """The number of memory files is ``min`` (default 0) or more, and ``max`` (default no limit) or less."""
    count = len(memory_files(trial))
    ok = count >= int(c.get("min", 0)) and ("max" not in c or count <= int(c["max"]))
    return CheckResult("memory_files", ok, f"{count} memory files")


def check_unchanged(c: dict, trial: Trial) -> CheckResult:
    changed = _changed(trial)
    paths = c.get("paths")
    bad = [p for p in changed if paths is None or p in paths or any(p.startswith(x.rstrip("/") + "/") for x in paths)]
    return CheckResult("unchanged", not bad, f"changed: {bad}")


def check_changed_only(c: dict, trial: Trial) -> CheckResult:
    extra = [p for p in _changed(trial) if p not in c["paths"]]
    return CheckResult("changed_only", not extra, f"other changes: {extra}")


def check_max_changed_lines(c: dict, trial: Trial) -> CheckResult:
    total = 0
    for path in _changed(trial):
        before = trial.baseline_text.get(path, "").splitlines()
        after = (file_text(trial.workspace / path) or "").splitlines()
        total += sum(1 for line in difflib.unified_diff(before, after, lineterm="", n=0)
                     if line[:1] in "+-" and not line.startswith(("+++", "---")))
    return CheckResult("max_changed_lines", total <= int(c["n"]), f"{total} changed lines")


def check_tool_called(c: dict, trial: Trial) -> CheckResult:
    """``turn`` (optional) counts only the calls of that turn. 1 is the first turn."""
    count = sum(1 for e in _calls(trial, c.get("turn")) if _call_matches(e, c))
    ok = count >= int(c.get("min", 1)) and ("max" not in c or count <= int(c["max"]))
    return CheckResult("tool_called", ok, f"{c.get('name')}: {count} calls")


def check_tool_not_called(c: dict, trial: Trial) -> CheckResult:
    count = sum(1 for e in _calls(trial, c.get("turn")) if _call_matches(e, c))
    return CheckResult("tool_not_called", count == 0, f"{c.get('name')}: {count} calls")


def check_tool_before(c: dict, trial: Trial) -> CheckResult:
    calls = _calls(trial)
    first = next((i for i, e in enumerate(calls) if _call_matches(e, c["first"])), None)
    then = next((i for i, e in enumerate(calls) if _call_matches(e, c["then"])), None)
    return CheckResult("tool_before", then is not None and first is not None and first < then,
                       f"first at {first}, then at {then}")


def check_tool_after_last(c: dict, trial: Trial) -> CheckResult:
    calls = _calls(trial)
    last = max((i for i, e in enumerate(calls) if _call_matches(e, c["last"])), default=None)
    after = [i for i, e in enumerate(calls) if _call_matches(e, c["then"])]
    return CheckResult("tool_after_last", last is not None and any(i > last for i in after),
                       f"last at {last}, then at {after}")


def check_max_tool_calls(c: dict, trial: Trial) -> CheckResult:
    count = len(_calls(trial))
    return CheckResult("max_tool_calls", count <= int(c["n"]), f"{count} calls")


def check_asked_user(c: dict, trial: Trial) -> CheckResult:
    return CheckResult("asked_user", bool(_requests(trial, "question")))


def check_not_asked_user(c: dict, trial: Trial) -> CheckResult:
    return CheckResult("not_asked_user", not _requests(trial, "question"))


def check_plan_submitted(c: dict, trial: Trial) -> CheckResult:
    return CheckResult("plan_submitted", bool(_requests(trial, "plan")))


def _permission(e: dict, c: dict) -> bool:
    return e.get("tool") == c.get("tool") and _match(c.get("pattern"), json.dumps(e.get("input"), ensure_ascii=False))


def check_permission_requested(c: dict, trial: Trial) -> CheckResult:
    return CheckResult("permission_requested", any(_permission(e, c) for e in _requests(trial, None)))


def check_permission_not_requested(c: dict, trial: Trial) -> CheckResult:
    hits = [e.get("input") for e in _requests(trial, None) if _permission(e, c)]
    return CheckResult("permission_not_requested", not hits, f"requests: {hits}")


def check_stop_reason(c: dict, trial: Trial) -> CheckResult:
    last = trial.stop_reasons[-1] if trial.stop_reasons else None
    return CheckResult("stop_reason", last == c["value"], f"stop reason {last}")


def check_final_text(c: dict, trial: Trial) -> CheckResult:
    """A text check: weaker than the other checks. The summary marks the tasks that use it."""
    text = trial.final_text
    ok = (("matches" not in c or re.search(c["matches"], text, re.S | re.I) is not None)
          and ("not_matches" not in c or re.search(c["not_matches"], text, re.S | re.I) is None))
    return CheckResult("final_text", ok, text[-200:])


def check_event(c: dict, trial: Trial) -> CheckResult:
    """An event of the type ``event`` occurred. ``min`` (optional): {field: number}. The event must have each
    field at that number or more, for example {removed_messages: 1} for a compaction that removed turns."""
    least = c.get("min") or {}

    def ok(e: dict[str, Any]) -> bool:
        return e.get("type") == c["event"] and all(isinstance(e.get(k), (int, float)) and e[k] >= v
                                                   for k, v in least.items())

    return CheckResult("event", any(ok(e) for e in trial.events), c["event"])


def check_any_of(c: dict, trial: Trial) -> CheckResult:
    """One check in ``checks`` passes, or more."""
    results = grade(c["checks"], trial)
    return CheckResult("any_of", any(r.passed for r in results),
                       "; ".join(f"{r.name}: {'pass' if r.passed else 'fail'}" for r in results))


CHECKS: dict[str, Callable[[dict, Trial], CheckResult]] = {
    "command": check_command, "file_contains": check_file_contains, "file_not_contains": check_file_not_contains,
    "file_equals": check_file_equals, "file_exists": check_file_exists, "file_absent": check_file_absent,
    "unchanged": check_unchanged, "changed_only": check_changed_only, "max_changed_lines": check_max_changed_lines,
    "tool_called": check_tool_called, "tool_not_called": check_tool_not_called, "tool_before": check_tool_before,
    "tool_after_last": check_tool_after_last, "max_tool_calls": check_max_tool_calls,
    "asked_user": check_asked_user, "not_asked_user": check_not_asked_user, "plan_submitted": check_plan_submitted,
    "permission_requested": check_permission_requested, "permission_not_requested": check_permission_not_requested,
    "stop_reason": check_stop_reason, "final_text": check_final_text, "event": check_event,
    "changed": check_changed, "pattern_absent": check_pattern_absent, "pattern_present": check_pattern_present,
    "memory_files": check_memory_files, "any_of": check_any_of,
}


def grade(checks: list[dict[str, Any]], trial: Trial) -> list[CheckResult]:
    results = []
    for check in checks:
        try:
            results.append(CHECKS[check["type"]](check, trial))
        except Exception as e:  # noqa: BLE001 - a broken check fails, with the reason.
            results.append(CheckResult(check.get("type", "?"), False, f"{type(e).__name__}: {e}"))
    return results


def uses_text_checks(checks: list[dict[str, Any]]) -> bool:
    return any(c.get("type") == "final_text" or uses_text_checks(c.get("checks") or []) for c in checks)


__all__ = ["CHECKS", "CheckResult", "grade", "uses_text_checks", "Path"]
