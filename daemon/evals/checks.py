"""The checks of a trial. Each check is code: no model grades a trial.

A check is a dict with a "type" and its fields. The result of a trial is "pass" when all its checks pass.
"""

from __future__ import annotations

import difflib
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


def _calls(trial: Trial) -> list[dict[str, Any]]:
    return [e for e in trial.events if e.get("type") == "tool.start"]


def _call_matches(event: dict[str, Any], spec: dict[str, Any]) -> bool:
    return event.get("name") == spec.get("name") and _match(spec.get("args"), json.dumps(event.get("input"), ensure_ascii=False))


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
    text = file_text(trial.workspace / c["path"])
    return CheckResult("file_equals", text == c["text"], c["path"])


def check_file_exists(c: dict, trial: Trial) -> CheckResult:
    return CheckResult("file_exists", (trial.workspace / c["path"]).exists(), c["path"])


def check_file_absent(c: dict, trial: Trial) -> CheckResult:
    return CheckResult("file_absent", not (trial.workspace / c["path"]).exists(), c["path"])


def _changed(trial: Trial) -> list[str]:
    now = workspace_files(trial.workspace)
    return sorted(p for p in set(now) | set(trial.baseline) if now.get(p) != trial.baseline.get(p))


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
    count = sum(1 for e in _calls(trial) if _call_matches(e, c))
    ok = count >= int(c.get("min", 1)) and ("max" not in c or count <= int(c["max"]))
    return CheckResult("tool_called", ok, f"{c.get('name')}: {count} calls")


def check_tool_not_called(c: dict, trial: Trial) -> CheckResult:
    count = sum(1 for e in _calls(trial) if _call_matches(e, c))
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
    return CheckResult("event", any(e.get("type") == c["event"] for e in trial.events), c["event"])


CHECKS: dict[str, Callable[[dict, Trial], CheckResult]] = {
    "command": check_command, "file_contains": check_file_contains, "file_not_contains": check_file_not_contains,
    "file_equals": check_file_equals, "file_exists": check_file_exists, "file_absent": check_file_absent,
    "unchanged": check_unchanged, "changed_only": check_changed_only, "max_changed_lines": check_max_changed_lines,
    "tool_called": check_tool_called, "tool_not_called": check_tool_not_called, "tool_before": check_tool_before,
    "tool_after_last": check_tool_after_last, "max_tool_calls": check_max_tool_calls,
    "asked_user": check_asked_user, "not_asked_user": check_not_asked_user, "plan_submitted": check_plan_submitted,
    "permission_requested": check_permission_requested, "permission_not_requested": check_permission_not_requested,
    "stop_reason": check_stop_reason, "final_text": check_final_text, "event": check_event,
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
    return any(c.get("type") == "final_text" for c in checks)


__all__ = ["CHECKS", "CheckResult", "grade", "uses_text_checks", "Path"]
