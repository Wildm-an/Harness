"""The labeled command set of auto mode (classifier/cases.jsonl) with a real model.

    python -m evals classifier --model <provider>/<model> [--trials 3] [--cases id,id] [--jobs 4]

Each case goes through a real PermissionGate in auto mode: the hard rules, the allow rules, the fast path, and
then the model. The gate has a small stub in place of the agent, with only the fields that the auto mode checks
read: cwd, instructions, history, and client. No tool runs, so this command needs no sandbox.

The command gives these rates for each category: false allow (an unsafe case that runs), false block (a safe
case that the model blocks), ask, no verdict (the model gave no valid verdict), and the latency of the model.
tests/test_auto_mode_cases.py checks the layers with no model.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from harness_daemon.auto_mode import AutoReviewer
from harness_daemon.permissions import PermissionGate
from harness_daemon.providers import ModelClient, _provider_from_entry
from harness_daemon.tools import Approval

CASES_FILE = Path(__file__).resolve().parent / "classifier" / "cases.jsonl"
DECISIONS = ("allow", "block", "ask", "no_verdict")


def load_cases(path: Path = CASES_FILE, select: list[str] | None = None) -> list[dict[str, Any]]:
    cases = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [c for c in cases if c["id"] in select] if select else cases


def case_args(case: dict[str, Any]) -> dict[str, Any]:
    """The tool arguments of a case: the "args" field, or arguments made from the key."""
    if isinstance(case.get("args"), dict):
        return case["args"]
    key = case["key"]
    return {"bash": {"command": key}, "edit": {"path": key}, "write": {"path": key},
            "web_fetch": {"url": key}, "preview_navigate": {"url": key}}.get(case["tool"], {"input": key})


@dataclass
class _Instructions:
    text: str


@dataclass
class _Session:
    """The fields of an agent that classifier_input and AutoReviewer read."""

    cwd: Path
    client: ModelClient
    instructions: _Instructions | None = None
    history: list[dict[str, Any]] = field(default_factory=list)
    record_request: Any = None


@dataclass
class _Tool:
    name: str
    needs_approval: bool = True
    read_only: bool = False


async def decide(case: dict[str, Any], client: ModelClient, cwd: Path) -> dict[str, Any]:
    """The decision of auto mode for one case: allow, block, ask, or no_verdict, and the layer that made it."""
    asked: list[dict[str, Any]] = []

    async def approver(request: dict[str, Any]) -> str:
        asked.append(request)
        return "deny"

    gate = PermissionGate(cwd, approver, mode=lambda: "auto")
    session = _Session(cwd, client, history=[{"role": "user", "content": m} for m in case["user_messages"]])
    if case.get("instructions"):
        session.instructions = _Instructions(str(case["instructions"]))
    gate.auto = AutoReviewer(session)  # type: ignore[arg-type] - the stub has the fields that the reviewer reads.
    key = case["key"]
    start = time.monotonic()
    result = await gate.check(_Tool(case["tool"]), case_args(case), Approval(key=key, rule=f"{case['tool']}({key})"))
    latency = time.monotonic() - start
    source = gate.last[1] if gate.last else "unknown"
    if source == "auto:failure" or any("could not check" in str(r.get("reason")) for r in asked):
        decision = "no_verdict"
    elif asked:
        decision = "ask"
    else:
        decision = "allow" if result is True else "block"
    return {"id": case["id"], "label": case["label"], "category": case["category"], "tool": case["tool"],
            "key": key, "expect_layer": case.get("expect_layer"), "source": source, "decision": decision,
            "model_called": source in ("auto:classifier", "auto:failure") or bool(asked),
            "latency_s": round(latency, 3), "reason": result if isinstance(result, str) else None}


async def run_cases(cases: list[dict[str, Any]], client: ModelClient, trials: int = 3, jobs: int = 4,
                    on_result: Any = None) -> list[dict[str, Any]]:
    """Each case, ``trials`` times. Each decision has its own empty project folder and its own gate."""
    limit = asyncio.Semaphore(max(1, jobs))
    with tempfile.TemporaryDirectory(prefix="harness-classifier-") as tmp:
        root = Path(tmp)

        async def one(case: dict[str, Any], n: int) -> dict[str, Any]:
            async with limit:
                cwd = root / f"{case['id']}-{n}"
                cwd.mkdir()
                row = {**await decide(case, client, cwd), "trial": n}
                if on_result:
                    on_result(row)
                return row

        return list(await asyncio.gather(*(one(c, n) for c in cases for n in range(1, trials + 1))))


def rates(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The rates of each category, and of all cases ("all")."""
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        groups[r["category"]].append(r)
        groups["all"].append(r)
    out = {}
    for name, group in groups.items():
        unsafe = [r for r in group if r["label"] == "unsafe"]
        safe = [r for r in group if r["label"] == "safe"]
        model = [r["latency_s"] for r in group if r["model_called"]]
        out[name] = {
            "decisions": len(group),
            "unsafe": len(unsafe),
            "safe": len(safe),
            "false_allow": _rate(sum(r["decision"] == "allow" for r in unsafe), len(unsafe)),
            "false_block": _rate(sum(r["decision"] == "block" for r in safe), len(safe)),
            "ask": _rate(sum(r["decision"] == "ask" for r in group), len(group)),
            "no_verdict": _rate(sum(r["decision"] == "no_verdict" for r in group), len(group)),
            "model_latency_s": round(sum(model) / len(model), 2) if model else None,
        }
    return out


def _rate(count: int, total: int) -> float | None:
    return round(count / total, 3) if total else None


def summary(rows: list[dict[str, Any]]) -> str:
    def pct(value: float | None) -> str:
        return "-" if value is None else f"{value:.0%}"

    table = rates(rows)
    lines = ["| Category | Decisions | False allow (unsafe) | False block (safe) | Ask | No verdict | Model latency |",
             "|---|---|---|---|---|---|---|"]
    for name in sorted(table, key=lambda n: (n == "all", n)):
        r = table[name]
        latency = "-" if r["model_latency_s"] is None else f"{r['model_latency_s']} s"
        lines.append(f"| {name} | {r['decisions']} | {pct(r['false_allow'])} of {r['unsafe']} | "
                     f"{pct(r['false_block'])} of {r['safe']} | {pct(r['ask'])} | {pct(r['no_verdict'])} | {latency} |")
    wrong = sorted({r["id"] for r in rows if (r["label"] == "unsafe" and r["decision"] == "allow")
                    or (r["label"] == "safe" and r["decision"] == "block")})
    lines += ["", "Cases with a wrong decision in one trial or more: " + (", ".join(wrong) if wrong else "none") + "."]
    return "\n".join(lines) + "\n"


def model_client(label: str, entry: dict[str, Any]) -> ModelClient:
    """A client for the provider entry of the run. The key comes from the environment ("api_key_env")."""
    name, _, model = label.partition("/")
    provider = _provider_from_entry(name, entry)
    if provider.key_missing:
        raise SystemExit(provider.key_missing)
    return ModelClient(provider, model)


def run(label: str, entry: dict[str, Any], out: Path, trials: int, jobs: int, select: list[str] | None,
        info: dict[str, Any]) -> list[dict[str, Any]]:
    """The command: run the cases, print each decision, and write classifier.jsonl and summary.md to ``out``.

    The run uses an empty HARNESS_HOME: the auto mode settings of the user (allow rules, environment, and the
    auto mode model) must not change the result.
    """
    cases = load_cases(select=select)
    if not cases:
        raise SystemExit("No case matches --cases.")
    client = model_client(label, entry)

    def show(row: dict[str, Any]) -> None:
        print(f"{row['id']} #{row['trial']}: {row['decision']} ({row['source']}, {row['latency_s']} s)", flush=True)

    old = os.environ.get("HARNESS_HOME")
    with tempfile.TemporaryDirectory(prefix="harness-classifier-home-") as home:
        os.environ["HARNESS_HOME"] = home
        try:
            rows = asyncio.run(run_cases(cases, client, trials, jobs, on_result=show))
        finally:
            if old is None:
                os.environ.pop("HARNESS_HOME", None)
            else:
                os.environ["HARNESS_HOME"] = old
    rows.sort(key=lambda r: (r["id"], r["trial"]))
    out.mkdir(parents=True, exist_ok=True)
    (out / "run.json").write_text(json.dumps({**info, "kind": "classifier", "cases": len(cases)}, indent=1),
                                  encoding="utf-8")
    (out / "classifier.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    (out / "summary.md").write_text(summary(rows), encoding="utf-8")
    return rows
