"""The eval tasks: one folder for each task, with task.yaml, a workspace/ folder, and an optional hidden/ folder.

task.yaml keys:
- id, behavior (the harness behavior that the task measures), polarity ("act" or "no_act"), pair (an id or null)
- turns: the prompts, in order
- permission_mode: the mode of the session (default "default")
- approvals: {"allow": [rules], "deny": [rules], "default": "allow" | "deny"} for permission cards
- answers: {"question": {question text: answer} or "skip", "plan": "accept" | "reject" | "revise", "plan_mode": mode}
- settings: project settings for .harness/settings.json of the workspace (for example max_tool_calls)
- setup: shell commands that run in the workspace before the trial (for example "git init")
- timeout_s: the time limit of the trial
- require: checks that must pass for a valid trial (else the trial is "invalid", not "fail")
- checks: the checks of the outcome (checks.py)
- smoke: true for the smoke set (--smoke)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

TASKS_DIR = Path(__file__).resolve().parent / "tasks"
POLARITIES = ("act", "no_act")


@dataclass(frozen=True)
class Task:
    id: str
    folder: Path
    behavior: str
    polarity: str
    turns: list[str]
    checks: list[dict[str, Any]]
    pair: str | None = None
    permission_mode: str = "default"
    approvals: dict[str, Any] = field(default_factory=dict)
    answers: dict[str, Any] = field(default_factory=dict)
    settings: dict[str, Any] = field(default_factory=dict)
    setup: list[str] = field(default_factory=list)
    timeout_s: int = 300
    require: list[dict[str, Any]] = field(default_factory=list)
    smoke: bool = False

    @property
    def workspace(self) -> Path:
        return self.folder / "workspace"

    @property
    def hidden(self) -> Path:
        return self.folder / "hidden"


def load_task(folder: Path) -> Task:
    data = yaml.safe_load((folder / "task.yaml").read_text(encoding="utf-8")) or {}
    return Task(
        id=str(data.get("id") or folder.name), folder=folder, behavior=str(data.get("behavior") or ""),
        polarity=str(data.get("polarity") or ""), turns=[str(t) for t in data.get("turns") or []],
        checks=list(data.get("checks") or []), pair=data.get("pair"),
        permission_mode=str(data.get("permission_mode") or "default"), approvals=dict(data.get("approvals") or {}),
        answers=dict(data.get("answers") or {}), settings=dict(data.get("settings") or {}),
        setup=[str(c) for c in data.get("setup") or []], timeout_s=int(data.get("timeout_s") or 300),
        require=list(data.get("require") or []), smoke=bool(data.get("smoke")),
    )


def load_tasks(root: Path = TASKS_DIR, select: list[str] | None = None, smoke: bool = False) -> list[Task]:
    tasks = [load_task(f) for f in sorted(root.iterdir()) if (f / "task.yaml").is_file()]
    if select:
        tasks = [t for t in tasks if t.id in select]
    if smoke:
        tasks = [t for t in tasks if t.smoke]
    return tasks


def lint(tasks: list[Task]) -> list[str]:
    """Problems in the task files. Empty: all tasks are valid."""
    from .checks import CHECKS

    problems: list[str] = []
    ids = {t.id for t in tasks}
    for t in tasks:
        if t.id != t.folder.name:
            problems.append(f"{t.id}: the id must be the folder name ({t.folder.name}).")
        if t.polarity not in POLARITIES:
            problems.append(f"{t.id}: polarity must be act or no_act.")
        if not t.behavior:
            problems.append(f"{t.id}: no behavior.")
        if not t.turns:
            problems.append(f"{t.id}: no turns.")
        if not t.checks:
            problems.append(f"{t.id}: no checks.")
        if t.pair and t.pair not in ids:
            problems.append(f"{t.id}: the pair {t.pair} does not exist.")
        if not t.workspace.is_dir():
            problems.append(f"{t.id}: no workspace folder.")
        for check in [*t.checks, *t.require]:
            if check.get("type") not in CHECKS:
                problems.append(f"{t.id}: unknown check type {check.get('type')!r}.")
    return problems
