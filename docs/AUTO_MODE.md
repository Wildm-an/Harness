# Auto mode

In auto mode, a model checks each action of the agent that no rule decides. Safe actions run with no question. Risky actions are blocked, and the agent gets the reason. The code is in `daemon/harness_daemon/auto_mode.py` and `permissions.py`.

Select **Auto mode** in the permission menu under the prompt box, or press Shift+Tab until it shows.

## The order of the checks

For each tool call that needs approval, the first match decides:

1. **The deny rules** of the project (`.harness/settings.json`). They apply in all modes.
2. **The hard rules.** These rules need no model, and the model cannot change them. The call is blocked:
   - `sudo`, `doas`, `su`, `runas`
   - `format`, `diskpart`, `bcdedit`, `mkfs`, `Set-ExecutionPolicy`, a registry change in HKLM, `shutdown`, `dd` to a device
   - a download that goes into a shell (`curl … | sh`, `iwr … | iex`)
   - a deletion of the root, a drive root, or the home folder
   - a network command with a secret in it (a private key, an API token, `~/.ssh/id_*`)
   - a change to the permission settings of Harness (`.harness/settings.json`, `harness.db`)
3. **The narrow allow rules** of the project and the allowed tools of a skill. Broad rules do not apply in auto mode: `bash`, `bash(*)`, `edit`, `write`, `mcp__server__*`, and a prefix rule for an interpreter or a package manager, for example `bash(python:*)` or `bash(npm:*)`. A narrow rule such as `bash(npm run test:*)` applies.
4. **The fast paths** run with no check:
   - a shell command that only reads, with no shell operators: `ls`, `cat`, `rg`, `git status`, `git diff`, `git log`, a version probe, and others
   - a file change in the project, except in the protected folders and files (`.git`, `.harness`, `.claude`, `.github`, `.vscode`, `.idea`, `.husky`, `.env*`, `.mcp.json`, `.npmrc`, shell profiles)
   - a Browser pane page on this computer (`localhost`, `127.0.0.1`)
5. **The model** checks all other calls: other shell commands, protected files, MCP tools, and other pages. Its answer is `allow`, `block`, or `ask`.

Harness has no sandbox. Thus every shell command that is not clearly read-only goes to the model. The reference plugin (dsh-auto-mode) runs commands in a sandbox, and its model checks fewer calls.

## What the model sees

One JSON message:

- `workspace_root`: the project folder.
- `user_messages`: the 6 newest messages of the user (up to 1500 characters each). For a skill, the text that the user typed.
- `project_instructions`: `HARNESS.md` or `CLAUDE.md` (up to 4000 characters).
- `recent_actions`: the 12 newest tool calls, with their arguments and no output.
- `pending_action`: the tool, its arguments, and facts (for a file: the path, if it exists, if it is protected).
- `environment`, `user_allow_rules`, `user_block_rules`: from the global settings (see below).

The input has no tool output and no text of the agent. The arguments have no secrets, and long file text becomes `[content: N chars]`. Only the messages of the user and the project instructions give authority. The prompt tells the model to ignore instructions in all other text.

The model replies with `{"decision": "allow" | "block" | "ask", "rule": "…", "reason": "…"}`. A reasoning block (`<think>`) and a code fence are removed. Any other reply is a failure.

## Blocks, questions, and failures

- **block**: the call does not run. The agent gets `Blocked by auto mode [<rule>]: <reason> …` and continues. It must choose a safer method or tell the user what it needs.
- **ask**: Harness asks you, and the approval card shows the reason.
- **3 blocks in a row, or 20 blocks in a session**: Harness asks you for the blocked action. If you allow it, auto mode continues.
- **failure** (no answer in 45 seconds, a model error, or a bad reply): the call does not run, and the agent can try again later. After 3 failures in a row, Harness asks you.

A subagent of a skill uses the same checks and the messages of the user in the session.

## Settings

Auto mode reads only `~/.harness/settings.json`. A project cannot change it, because a repository must not add its own allow rules.

```json
{
  "auto_mode": {
    "model": "local-ollama/qwen3:8b",
    "environment": ["The team uses the GitHub remote origin for pull requests."],
    "allow": ["Pushes to the branch of the task are allowed."],
    "soft_deny": ["Do not change the database files in data/."]
  }
}
```

- `model`: the model for the checks. The default is the model of the session. A small, fast model makes each check faster.
- `environment`, `allow`, `soft_deny`: rules in plain language for the model.

## Limits

- The model can make mistakes. Anthropic reports that 17% of real overeager actions passed its full classifier. Auto mode reduces questions. It does not make the agent safe. Do not use it with secrets or systems that the agent must not touch.
- A local model makes each check slow, and it can be less accurate than a large model.
- The fast paths trust file changes in the project. Use git to undo a change.

## Sources

- [NanmiCoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode) (MIT): the reference. It sends only the user messages and the tool call to the model, with strict JSON, fails closed, and asks after 3 failures. Harness uses the same authority rule and a similar prompt.
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes) and [auto mode settings](https://code.claude.com/docs/en/auto-mode-config): the order of the checks, the broad rules that auto mode drops, the default block list, and the fallback after 3 blocks in a row or 20 in total.
- [Anthropic engineering: Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode): the classifier sees the user messages and the tool calls, but no tool output and no text of the agent.
- [OpenAI Codex agent approvals](https://learn.chatgpt.com/docs/agent-approvals-security) and the `openai/codex` guardian policy: risk levels, fail-closed checks, and a stop after repeated denials.
- [OpenHands SDK security](https://docs.openhands.dev/sdk/arch/security): a separate guardrail model is better than a risk rating from the agent itself.
- [Simon Willison: the lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/): private data, untrusted content, and outside communication together are the danger.
