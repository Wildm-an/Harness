# Evals of the agent harness

A prompt line or a tool description changes how the agent acts. A unit test with the fake model does not show that change. This folder holds tasks that a real model runs through the real daemon, with code that grades the outcome.

| File | Function |
|---|---|
| `tasks/<id>/task.yaml` | The task: prompts, permission mode, the answers to the cards, and the checks. `tasks.py` lists the keys. |
| `tasks/<id>/workspace/` | The project files at the start of a trial. |
| `tasks/<id>/hidden/` | Optional. Files that a `command` check copies in after the trial, for example hidden tests. |
| `classifier/cases.jsonl` | The labeled command set of auto mode (`tests/test_auto_mode_cases.py`). |
| `driver.py` | Starts a daemon with its own `HARNESS_HOME`, sends the prompts over the WebSocket protocol, and answers the cards. |
| `checks.py` | The check types. No model grades a trial. |
| `report.py` | `run.json`, `results.jsonl`, and `summary.md`. |

## Run

From the `daemon` folder:

```bash
python -m evals lint
```

```bash
python -m evals run --model <provider>/<model> --smoke --trials 1
```

```bash
python -m evals run --model <provider>/<model> --trials 3 --baseline evals/results/<old run>/results.jsonl
```

`--model` reads the provider from `~/.harness/providers.json`. An inline API key goes to the trial daemons through the environment variable `HARNESS_EVAL_API_KEY`. No key goes to a file. A provider with its key in the desktop client cannot run: set `api_key_env` for it.

The results go to `evals/results/<time>-<model>/`. Git ignores this folder. Each trial folder has `events.jsonl` (all the messages of the session), `approvals.jsonl`, `daemon.log`, and the workspace `ws/`.

## Safety

The agent runs real shell commands. Harness has no sandbox. The runner denies each command that a hard rule of auto mode catches, and each trial has its own home folders. That does not make a run safe. Run real-model evals in a container, a virtual machine, or a CI runner.

## Read the results

- One trial proves nothing. Use 3 trials, or 5 before a release, and compare the pass counts.
- A difference of less than 3 points over 3 trials is in the noise.
- `invalid`: a `require` check failed, for example no compaction in a compaction task. It is not a failure of the agent.
- A task with a `final_text` check is marked "(text check)". A text check is weaker than a check of files or tool calls.

## Add a task

Take the task from a real failure of the agent. Write the smallest workspace that shows the failure. Give the task a pair: a task where the agent must act, and one where it must not. Check the outcome (files, tool calls, cards), not the exact sequence of tool calls. Then run `python -m evals lint`.
