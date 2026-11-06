# Changes for Harness

This skill is Anthropic's `skill-creator` skill, licensed under the Apache License 2.0 (see `LICENSE.txt`). Harness changed these files on 2026-11-04:

- `SKILL.md`
  - A shorter description (Harness shows at most 300 characters of a description) and a `license` field.
  - "Claude" changed to "the agent" where the text is about the model that uses the skill.
  - A new section "Skills in Harness": the skill folders, loading, the description length, the argument placeholders, the frontmatter fields, and local models.
  - Subagent runs use the Harness `agent` tool. Timing comes from the start and end of each run, because the Harness report may not give a token count.
  - The viewer runs as a background task of the `bash` tool and stops with `task_stop`. For a remote daemon, the viewer writes a static HTML file.
  - The description optimization loop uses subagents of the session model instead of `claude -p` and `scripts/run_loop.py`.
  - "Package and Present" became "Install, validate, and share" for Harness skill folders.
  - The Claude.ai and Cowork sections became "Harness-specific notes".
- `references/schemas.md`: the timing capture note and the `executor_model` example.
- Removed `scripts/run_eval.py`, `scripts/run_loop.py`, `scripts/improve_description.py`, and `scripts/generate_report.py`, because they need the `claude` command-line program.
- `scripts/quick_validate.py`: it also accepts the frontmatter fields `argument-hint`, `disable-model-invocation`, `user-invocable`, and `context`.
- `eval-viewer/viewer.html` and `eval-viewer/generate_review.py`: the text for the user says "the Harness session" and "the agent" in place of "Claude Code" and "Claude".
- `scripts/quick_validate.py`, `scripts/utils.py`, `scripts/aggregate_benchmark.py`, and `eval-viewer/generate_review.py`: they read and write files as UTF-8, because the default code page of Windows cannot read all UTF-8 text.

All other files are the same as in the original skill.
