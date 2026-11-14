# Prompt ledger

Each block of prompt text that the agent gets has one line here. A line records the failure that the block fixes, the models that get it, when it came, and the evaluation task that measures it.

A prompt rule has a cost: more tokens, and sometimes a side effect on models that do not need it. One line of verbosity guidance cost Claude Code 3% on its evals (Anthropic, April 2026). Thus each block needs a reason, and a block with no measured effect is a candidate for an ablation.

`daemon/tests/test_prompt_ledger.py` fails when a prompt constant has no line here. The setting `prompt_ablate` (a list of the ids in the "Id" column) leaves a part or a block out for an evaluation run. The evaluation set is in `daemon/evals/`.

Status values:
- **keep**: the block stays. The reason is clear, or a test or an incident supports it.
- **reword**: the text has a contradiction or a false statement. The plan (change 7b) gives the new text.
- **gate**: the block stays for some model tiers only, after an evaluation.
- **ablate**: remove the block if the evaluation shows no loss (3 points over 3 trials, with no rise in tokens).

Model tiers (`scaffold_tier` in `model_prompts.py`): **small** (14B parameters or less in the name), **frontier** (Claude, GPT, Gemini, when not small), **standard** (all others).

## Base prompt (`prompt.py`)

| Constant | Id | Failure that it fixes | Models | Added | Eval task | Status |
|---|---|---|---|---|---|---|
| `BASE_INTRO` | `intro` | The model must know its role and its tools. | All | 2026-09 | none | keep |
| `BASE_RULES` | `rules` | Edits of unread files, scope creep, long replies, URLs that the user cannot click, a loop after an error. | All | 2026-11-04 `dfae6c3`, URL rule 2026-11-05 `55b1f81` | `read-before-edit-act`, `scope-minimal` | reword: "Then try a different approach" disagrees with tool errors that state the fix. The read rule changes after the read check (8a). |
| `BASE_TOOLS` | `tools` | Shell commands in place of the file tools. Code in a reply that changes no file. Guessed paths. | All | 2026-11-04 `dfae6c3` | `tool-choice-grep` | keep. The `bash` description repeats the shell rule: ablate the duplicate. |
| `BASE_AUTHORITY` | `authority` | Conflicts between the user message, the project files, the settings, and the memory. The model needs one order (Claude Code: the most specific instruction wins). | All | 2026-11-14 (change 6a) | `user-overrides-file` | keep |
| `PARALLEL_TOOL_CALLS` | `tool_calls` | One call for each reply, which makes the turn slow. | All but small | 2026-11-04 `dfae6c3` | none | keep |
| `SMALL_MODEL_TOOL_CALLS` | `tool_calls` | Small models break the format of parallel calls. | Small | 2026-11-05 `7109898` | none | reword: "ask the user before you read files" disagrees with `<act_dont_ask>`. |
| `BASE_TASK_LIST` | `task_list` | The user cannot follow the work. Steps marked done at the end. | All | 2026-11-05 `0c5f43a` | none | gate: test a short form for frontier models. |
| `BASE_FINISH` | `finish` | False "done" claims, a stop after a plan, no check of the change. | All | 2026-11-04 `dfae6c3` | `verify-fix-act`, `verify-no-false-claim` | keep |
| `BASE_PROMPT_TEMPLATE` | | The join of the parts above. | All | | | keep |
| `BASE_PROMPT` | | The base prompt with parallel calls. | All | | | keep |
| `PREVIEW_PROMPT` | | The agent starts servers with bash and does not use the shared browser tabs. | Sessions with the Browser pane | 2026-09-26 `576266c` | none | keep |
| `AUTO_VERIFY_PROMPT` | | The user asked for a check of each UI change. | When "Auto-verify" is on | 2026-09-26 `576266c` | none | keep |

## Family blocks (`model_prompts.py`)

| Constant | Id | Failure that it fixes | Families | Added | Eval task | Status |
|---|---|---|---|---|---|---|
| `TOOL_USE_ENFORCEMENT` | `tool_use` | The model describes a plan and makes no tool call (Hermes Agent). | gpt, gemini, gemma, grok, glm, qwen, deepseek | 2026-11-05 `7109898` | none | reword: lines 2 to 4 repeat `BASE_FINISH`. gate: test removal for gpt (the stall nudge covers it in code). |
| `EXECUTION_DISCIPLINE` | `execution` | Facts from memory in place of a tool, a question in place of an action, no check of external state (Hermes Agent). | gpt, grok, deepseek, kimi, qwen, glm, minimax, mimo, mistral | 2026-11-05 `7109898` | none | reword: "The current time and date: use bash" disagrees with the Date line. `<prerequisite_checks>`: ablate. |
| `GPT_WORKING_STYLE` | `gpt_style` | Destructive git commands, work outside the request (opencode gpt.txt). | gpt | 2026-11-05 `7109898` | `destructive-not-asked`, `scope-minimal` | keep. The subagent line: ablate after the cost text of the `agent` tool. |
| `GOOGLE_RULES` | `google` | Guessed files and libraries, interactive commands that wait (opencode gemini.txt). | gemini, gemma | 2026-11-05 `7109898` | none | keep lines 2 and 5. ablate lines 1, 3, 4, 6: they repeat the base prompt. |
| `KIMI_RULES` | `kimi` | Code in a reply with no tool call, git changes that the user did not ask for (opencode kimi.txt). | kimi | 2026-11-05 `7109898` | none | keep lines 1, 4, 6, 7. ablate lines 2, 3, 5: they repeat the base prompt. |
| `CLAUDE_COMMENTS` | `claude_comments` | Too many code comments (opencode anthropic.txt). | claude | 2026-11-05 `7109898` | none | keep |

## Notes in the conversation (`agent.py`, `loop_guards.py`)

These texts arrive as `[Harness: ...]` messages or tool results. They do not change the system prompt.

| Constant | Failure that it fixes | Models | Added | Eval task | Status |
|---|---|---|---|---|---|
| `PLAN_ON_NOTE` | The model changes files in plan mode. | All | 2026-11-05 `7109898` | `plan-mode-read-only` | keep |
| `PLAN_OFF_NOTE` | The model still acts as in plan mode. | All | 2026-11-05 `7109898` | `plan-accept-then-act` | keep |
| `PLAN_START_NOTE` | No task list for work of many steps. | All tiers (`task_reminders`) | 2026-11-05 `0c5f43a` | none | reword: "This task has more than one step" is false for a short question. gate: test removal for frontier. |
| `PLAN_STEER_NOTE` | A message of the user during the work does not reach the task list. | All tiers | 2026-11-05 `0c5f43a` | none | gate: test removal for frontier. |
| `PLAN_OPEN_NOTE` | A new prompt leaves the old open steps on the list. | All tiers | 2026-11-05 `0c5f43a` | none | gate: test removal for frontier. |
| `PLAN_STALE_NOTE` | Many steps done and marked completed only at the end. | All tiers | 2026-11-06 `6207ec3` | none | gate: keep for small and standard. Test removal for frontier. |
| `PLAN_CLOSE_NOTE` | The turn ends with an open task list. The client shows it as running. | All | 2026-11-09 `7faedda` | none | keep |
| `PLAN_CLOSE_END_NOTE` | The same, at the end of the turn. It costs one model call. | All | 2026-11-09 `7faedda` | none | keep. Record the cost. |
| `MEMORY_NOTE` | The user changed the memory during the session. | All | 2026-11-05 `7109898` | none | keep |
| `MEMORY_OFF_NOTE` | The user turned the memory off during the session. | All | 2026-11-05 `7109898` | none | keep |
| `MEMORY_CHECK_NOTE` | A long turn saves no fact that the user said. It costs one model call. | All | 2026-11-11 `c19b361` | `memory-save`, `memory-no-save` | ablate: measure the cost. |
| `STALL_NUDGE` | A reply that says what the model will do now, with no tool call. | All | 2026-11-05 `7109898` | none | keep |
| `STALL_NOTICE` | The user must see why the turn continued. Client text, not model text. | | 2026-11-05 `7109898` | | keep |
| `CUT_REPLY_NOTE` | The output limit cut a reply, and the turn ended as if the reply were complete. | All | 2026-11-14 (change 3) | none | keep |
| `CUT_EMPTY_NOTE` | Reasoning used all of the output limit. | All | 2026-11-14 (change 3) | none | keep |
| `CUT_CALL_ERROR` | A tool call that the output limit cut gave only "not valid JSON". | All | 2026-11-14 (change 3) | none | keep |
| `CUT_CALL_MAYBE` | The same, with no finish reason from the server. | All | 2026-11-14 (change 3) | none | keep |
| `CUT_NOTICE` | Client text for a continuation. | | 2026-11-14 (change 3) | | keep |
| `FILTER_NOTICE` | Client text for a filtered reply. | | 2026-11-14 (change 3) | | keep |
| `CUT_LIMIT_ERROR` | Client text when the cap of continuations stops the turn. | | 2026-11-14 (change 3) | | keep |
| `NO_IMAGE_NOTE` | The model has no image input and the user pasted an image. | Models with no image input | 2026-11-03 `13669ef` | none | keep |
| `NO_IMAGE_NOTICE` | Client text for the same case. | | 2026-11-03 `13669ef` | | keep |
| `REJECTED_IMAGE_NOTICE` | Client text when the endpoint rejects an image. | | 2026-11-03 `13669ef` | | keep |
| `FORK_REPORT_REQUEST` | A fork skill ends with no report for the main agent. | All | 2026-09-26 `7e55d83` | none | keep |
