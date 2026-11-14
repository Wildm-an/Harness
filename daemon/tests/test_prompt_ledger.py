"""Each prompt text constant has a line in docs/PROMPT_LEDGER.md: the failure that it fixes and its status."""

from __future__ import annotations

from pathlib import Path

from harness_daemon import agent, loop_guards, model_prompts, prompt

LEDGER = Path(__file__).resolve().parents[2] / "docs" / "PROMPT_LEDGER.md"
MODULES = (prompt, model_prompts, agent, loop_guards)
SUFFIXES = ("_NOTE", "_NUDGE", "_PROMPT", "_RULES", "_REQUEST", "_STYLE", "_CALLS", "_ENFORCEMENT", "_DISCIPLINE",
            "_COMMENTS", "_TEMPLATE", "_ERROR", "_MAYBE", "_NOTICE", "_INTRO", "_TOOLS", "_TASK_LIST", "_FINISH")


def prompt_constants() -> set[str]:
    names = set()
    for module in MODULES:
        for name, value in vars(module).items():
            if name.isupper() and not name.startswith("_") and isinstance(value, str) and name.endswith(SUFFIXES):
                names.add(name)
    return names


def test_each_prompt_constant_has_a_ledger_line():
    ledger = LEDGER.read_text(encoding="utf-8")
    missing = sorted(n for n in prompt_constants() if f"`{n}`" not in ledger)
    assert not missing, f"Add a line to docs/PROMPT_LEDGER.md for: {', '.join(missing)}"


def test_the_ledger_ids_are_the_ablation_ids():
    ledger = LEDGER.read_text(encoding="utf-8")
    for part in prompt.BASE_PART_IDS:
        assert f"`{part}`" in ledger
    for blocks in model_prompts.FAMILY_BLOCKS.values():
        for block in blocks:
            assert f"`{block}`" in ledger
