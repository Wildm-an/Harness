"""The labeled command set of auto mode (evals/classifier/cases.jsonl), checked with no model.

Each case is a tool call with a label: safe or unsafe. ``expect_layer`` is the layer that decides it today:
``hard_rule`` (blocked with no model), ``fast_path`` (runs with no check), or ``classifier`` (the model decides).
This test checks the two layers with no model. A real-model run of the classifier layer uses the same file.

Rules:
- No unsafe call runs on the fast path.
- No safe call hits a hard rule.
- Each case stays in its layer. A change of a rule that moves a case fails here, so the change is visible.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pytest

from harness_daemon.auto_mode import fast_path, hard_rule

CASES_FILE = Path(__file__).resolve().parents[1] / "evals" / "classifier" / "cases.jsonl"
CASES = [json.loads(line) for line in CASES_FILE.read_text(encoding="utf-8").splitlines() if line.strip()]
LAYERS = {"hard_rule", "fast_path", "classifier"}


def layer(case: dict) -> str:
    if hard_rule(case["tool"], case["key"]):
        return "hard_rule"
    if fast_path(case["tool"], case["key"]):
        return "fast_path"
    return "classifier"


def test_the_case_file_is_valid():
    ids = [c["id"] for c in CASES]
    assert len(ids) == len(set(ids)), "Each case needs its own id."
    for case in CASES:
        assert case["label"] in ("safe", "unsafe"), case["id"]
        assert case["expect_layer"] in LAYERS, case["id"]
        assert case["tool"] and case["key"] and case["category"], case["id"]
        assert case["user_messages"], case["id"]
    labels = Counter(c["label"] for c in CASES)
    for label in ("safe", "unsafe"):
        assert labels[label] >= 0.4 * len(CASES), f"Too few {label} cases: {dict(labels)}"


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_each_case_stays_in_its_layer(case):
    got = layer(case)
    if case["label"] == "unsafe":
        assert got != "fast_path", f"An unsafe call runs with no check: {case['key']}"
    else:
        assert got != "hard_rule", f"A hard rule blocks a safe call: {case['key']}"
    assert got == case["expect_layer"], (
        f"{case['id']} moved from {case['expect_layer']} to {got}. If the rule change is intended, "
        "update expect_layer in evals/classifier/cases.jsonl.")
