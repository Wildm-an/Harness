"""The eval runner of the agent harness.

    python -m evals lint
    python -m evals run --model <provider>/<model> [--smoke] [--tasks a,b] [--trials 3] [--out DIR]
                        [--baseline results.jsonl]

Run it from the daemon folder. --model reads the provider from ~/.harness/providers.json. The API key goes to the
daemon of each trial through the environment, never through a file. See evals/README.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from harness_daemon.config import harness_home, read_json

from .driver import ModelSpec, run_trial
from .report import compare, run_info, trial_result, write
from .tasks import load_tasks, lint

RESULTS = Path(__file__).resolve().parent / "results"
KEY_ENV = "HARNESS_EVAL_API_KEY"


def model_spec(label: str) -> ModelSpec:
    name, _, model = label.partition("/")
    entries = read_json(harness_home() / "providers.json", {})
    entry = dict(entries.get(name) or {})
    if not entry or not model:
        raise SystemExit(f"No provider {name!r} in providers.json, or no model. Use <provider>/<model>.")
    if entry.get("key_store") == "client":
        raise SystemExit(f"The key of {name} is in the desktop client. Set api_key_env for an eval run.")
    if entry.get("api_key"):
        os.environ[KEY_ENV] = str(entry.pop("api_key"))  # The trial daemons inherit it. No key in a file.
        entry["api_key_env"] = KEY_ENV
    return ModelSpec(label, entry)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("lint", help="Check the task files.")
    run = sub.add_parser("run", help="Run the tasks with a real model.")
    run.add_argument("--model", required=True)
    run.add_argument("--tasks", default="")
    run.add_argument("--smoke", action="store_true")
    run.add_argument("--trials", type=int, default=3)
    run.add_argument("--out", default=None)
    run.add_argument("--baseline", default=None)
    args = parser.parse_args(argv)

    tasks = load_tasks(select=[t for t in args.tasks.split(",") if t] if getattr(args, "tasks", "") else None,
                       smoke=getattr(args, "smoke", False))
    problems = lint(load_tasks())
    if args.command == "lint" or problems:
        print("\n".join(problems) or f"{len(load_tasks())} tasks. No problems.")
        return 1 if problems else 0

    model = model_spec(args.model)
    out = Path(args.out) if args.out else RESULTS / f"{time.strftime('%Y%m%d-%H%M%S')}-{args.model.replace('/', '_')}"
    results = []
    for task in tasks:
        for n in range(1, args.trials + 1):
            trial = run_trial(task, model, out / "trials" / task.id / str(n))
            result = trial_result(trial, n)
            results.append(result)
            print(f"{task.id} #{n}: {result['status']}", flush=True)
    write(out, run_info(args.model, args.trials, sys.argv), results)
    print(f"Results: {out}")
    if args.baseline:
        changed = compare(results, [json.loads(l) for l in Path(args.baseline).read_text().splitlines() if l.strip()])
        print("\n".join(changed) or "No task changed its pass count.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
