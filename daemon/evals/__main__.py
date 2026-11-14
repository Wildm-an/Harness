"""The eval runner of the agent harness.

    python -m evals lint
    python -m evals run --model <provider>/<model> [--smoke] [--tasks a,b] [--trials 3] [--out DIR]
                        [--baseline results.jsonl]
    python -m evals classifier --model <provider>/<model> [--cases a,b] [--trials 3] [--jobs 4] [--out DIR]

Run it from the daemon folder. --model reads the provider from ~/.harness/providers.json. In place of --model,
give --base-url and --model-name (and --api-key-env, --kind): the CI workflow eval.yml does this. The API key
goes to the daemon of each trial through the environment, never through a file. See evals/README.md.
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


def model_from_args(args: argparse.Namespace) -> ModelSpec:
    """--model <provider>/<model>, or --base-url and --model-name. The provider of --base-url is "eval"."""
    if args.base_url:
        if not args.model_name:
            raise SystemExit("--base-url needs --model-name.")
        entry: dict[str, str] = {"base_url": args.base_url}
        if args.api_key_env and os.environ.get(args.api_key_env):
            entry["api_key_env"] = args.api_key_env
        elif args.api_key_env:
            print(f"The environment variable {args.api_key_env} is not set. The run uses no API key.", flush=True)
        if args.kind:
            entry["kind"] = args.kind
        return ModelSpec(f"eval/{args.model_name}", entry)
    if not args.model:
        raise SystemExit("Give --model <provider>/<model>, or --base-url and --model-name.")
    return model_spec(args.model)


def _out(args: argparse.Namespace, label: str, kind: str = "") -> Path:
    if args.out:
        return Path(args.out)
    return RESULTS / f"{time.strftime('%Y%m%d-%H%M%S')}-{kind}{label.replace('/', '_')}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m evals", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    model = argparse.ArgumentParser(add_help=False)
    model.add_argument("--model", default=None, help="<provider>/<model> from ~/.harness/providers.json")
    model.add_argument("--base-url", default=None, help="An OpenAI-compatible endpoint, in place of --model")
    model.add_argument("--model-name", default=None, help="The model name for --base-url")
    model.add_argument("--api-key-env", default=KEY_ENV, help=f"The variable with the key (default {KEY_ENV})")
    model.add_argument("--kind", default=None, help="The provider kind for --base-url (default: from the URL)")
    model.add_argument("--trials", type=int, default=3)
    model.add_argument("--out", default=None)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("lint", help="Check the task files.")
    run = sub.add_parser("run", parents=[model], help="Run the tasks with a real model.")
    run.add_argument("--tasks", default="")
    run.add_argument("--smoke", action="store_true")
    run.add_argument("--baseline", default=None)
    classify = sub.add_parser("classifier", parents=[model],
                              help="Run the labeled command set through auto mode with a real model.")
    classify.add_argument("--cases", default="", help="Case ids, with commas. Default: all cases.")
    classify.add_argument("--jobs", type=int, default=4, help="Cases at the same time.")
    args = parser.parse_args(argv)

    if args.command == "classifier":
        from .classifier import run as run_classifier, summary as classifier_summary

        spec = model_from_args(args)
        out = _out(args, spec.label, "classifier-")
        rows = run_classifier(spec.label, dict(spec.provider or {}), out, args.trials, args.jobs,
                              [c for c in args.cases.split(",") if c] or None,
                              run_info(spec.label, args.trials, sys.argv))
        print(classifier_summary(rows))
        print(f"Results: {out}")
        return 0

    problems = lint(load_tasks())
    if args.command == "lint" or problems:
        print("\n".join(problems) or f"{len(load_tasks())} tasks. No problems.")
        return 1 if problems else 0

    tasks = load_tasks(select=[t for t in args.tasks.split(",") if t] or None, smoke=args.smoke)
    spec = model_from_args(args)
    out = _out(args, spec.label)
    results = []
    for task in tasks:
        for n in range(1, args.trials + 1):
            trial = run_trial(task, spec, out / "trials" / task.id / str(n))
            result = trial_result(trial, n)
            results.append(result)
            print(f"{task.id} #{n}: {result['status']}", flush=True)
    write(out, run_info(spec.label, args.trials, sys.argv), results)
    print(f"Results: {out}")
    if args.baseline:
        changed = compare(results, [json.loads(l) for l in Path(args.baseline).read_text().splitlines() if l.strip()])
        print("\n".join(changed) or "No task changed its pass count.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
