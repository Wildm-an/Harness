# Sandbox

The sandbox limits the commands of the `bash` tool. A sandboxed command has no network, and it can write only in the project folder, the temp folder of the session, and the folders that you allow. The code is in `daemon/harness_daemon/sandbox.py`, `tools/bash.py`, and `permissions.py`.

The sandbox is off by default, as in Claude Code.

## Platforms

| System | Backend | State |
|---|---|---|
| macOS | Seatbelt (`/usr/bin/sandbox-exec`) | Available. Apple marks `sandbox-exec` as deprecated. Claude Code and Codex still use it. |
| Linux | bubblewrap (`bwrap`) | Available when the `bubblewrap` package is installed and `bwrap` can make a user namespace. Ubuntu 24.04 can block user namespaces. |
| Windows | none | Not available yet. Commands run with no sandbox. |

The daemon checks the backend on the daemon computer. For a remote daemon, the state is the state of that computer, not of the client computer.

## Settings

Set the `sandbox` object in `~/.harness/settings.json`. The key names are the Claude Code names, so you can copy a Claude Code block. Harness reads this object only from the user file. A project settings file cannot change it: a repository must not turn the sandbox off or add a folder.

```json
"sandbox": {
  "enabled": false,
  "failIfUnavailable": false,
  "autoAllowBashIfSandboxed": true,
  "allowUnsandboxedCommands": true,
  "excludedCommands": [],
  "network": { "allowedDomains": [], "deniedDomains": [], "allowLocalBinding": false },
  "filesystem": { "allowWrite": [], "denyWrite": [], "denyRead": [], "allowRead": [] }
}
```

| Key | Default | Function |
|---|---|---|
| `enabled` | `false` | `true` turns the sandbox on. |
| `failIfUnavailable` | `false` | `true`: when the sandbox is on and the system has no backend, `bash` returns an error and the command does not run. `false`: the command runs with no sandbox. |
| `autoAllowBashIfSandboxed` | `true` | A sandboxed command runs with no question in `default` and `acceptEdits`, and with no model check in `auto`. |
| `allowUnsandboxedCommands` | `true` | `true`: the agent can run a command again outside the sandbox with `dangerouslyDisableSandbox: true`, and you approve it. `false`: the agent gets a text, and the command does not run. |
| `excludedCommands` | `[]` | Commands that always run outside the sandbox, for example `"docker compose *"`. A pattern with no `*` matches the command and the same command with more arguments. Harness checks each part of a command between `;`, `&&`, `\|\|`, `\|`, and `&`. A broad pattern such as `"docker *"` gives full access to all Docker commands. |
| `network.allowLocalBinding` | `false` | macOS only: a command can start a server on `localhost` and connect to it. On Linux, the sandbox has its own `localhost`. |
| `network.allowedDomains`, `network.deniedDomains` | `[]` | Not used yet. The network is always off in the sandbox. A domain list through a proxy comes later. |
| `filesystem.allowWrite` | `[]` | More folders that a command can write. |
| `filesystem.denyWrite` | `[]` | Paths that a command cannot write. A deny path wins over a write folder. |
| `filesystem.denyRead` | `[]` | Paths that a command cannot read. |
| `filesystem.allowRead` | `[]` | Paths in a `denyRead` folder that a command can read again. On Linux, such a path is read-only. |

A path that starts with `~/` is in your home folder. A relative path is in the project folder.

A change of `sandbox.enabled` changes the `bash` tool one time: its description gets one line, and its schema gets the parameter `dangerouslyDisableSandbox`. The cached prompt prefix is new after the change.

## The default policy

- **Writes:** the project folder, the temp folder of the session, the package caches in the home folder (`~/.npm`, `~/.cache`, `~/Library/Caches`, `~/.cargo/registry`, `~/.cargo/git`, `~/.pnpm-store`, and others), and `filesystem.allowWrite`. In a worktree, the `.git` folder of the main project also.
- **Never writes:** the protected project paths (`.git/hooks`, `.git/config`, `.harness`, `.claude`, `.github`, `.vscode`, `.idea`, `.husky`, `.mcp.json`, `.npmrc`, and others), `~/.harness`, the shell profiles and the git settings in the home folder (`~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.gitconfig`, `~/.ssh`, and others), and `filesystem.denyWrite`. Git can write the other files of `.git`, so `git commit` works.
- **Reads:** all files, less `filesystem.denyRead` and the Harness secret files: `~/.harness/daemon-token`, `~/.harness/mcp-auth.json`, and `~/.harness/providers.json`.
- **Network:** off. On macOS, the profile also blocks Unix sockets.
- **Environment:** the clean environment of all agent commands (no secret variables), and `TMPDIR`, `TMP`, and `TEMP` set to the temp folder of the session. The temp folder is `<system temp>/harness-sandbox/<session id>`.

## The permission gate

The checks run in this order: the deny rules, the plan mode block, the safety rules (`docs/AUTO_MODE.md`), then the sandbox rule.

| Mode | Sandboxed `bash` | `bash` outside the sandbox (an excluded command, a background task, or `dangerouslyDisableSandbox`) |
|---|---|---|
| `default` | Runs with no question, when `autoAllowBashIfSandboxed` is true | The allow rules, else a question. The question says: "This command runs outside the sandbox." |
| `acceptEdits` | As `default` | As `default` |
| `plan` | A question, as with no sandbox | A question |
| `auto` | Runs with no model check, when `autoAllowBashIfSandboxed` is true | The model checks it |
| `bypassPermissions` | Runs | Runs |

These rules stay in force for a sandboxed command:

- A deny rule blocks it.
- A hard rule match (for example `sudo`) asks in `default`, `acceptEdits`, `plan`, and `bypassPermissions`, and blocks in `auto`.
- With `allowUnsandboxedCommands` false, a call with `dangerouslyDisableSandbox` gets a text, and the turn continues. This applies in all modes.

When a sandboxed command fails with a nonzero exit code, the agent gets one more line after the exit code. The line tells the agent about the limits and the escape parameter.

## What stays outside the sandbox

- Background tasks (`run_in_background`) and `monitor`. They do not run with no question when the sandbox is on.
- The `read`, `edit`, `write`, `web_fetch`, and `web_search` tools. They keep their own checks.
- Hooks, MCP servers, plugins, dev servers, the terminal pane, the verify command, and the external ACP harness process.

Claude Code has the same limits.

## Limits

- Reads are broad. A command can read `~/.ssh`, unless you add it to `denyRead`. With the network off, the command cannot send the data out.
- On Linux, bubblewrap protects only paths that exist when the command starts. Harness makes the `.harness` folder of the project before a sandboxed command, so that the command cannot make `.harness/settings.json`. A deny path of `filesystem.denyWrite` that does not exist is not protected.
- Tools that need the network, for example `npm install`, `pip install`, and `git push`, fail in the sandbox. The agent can run them again with `dangerouslyDisableSandbox`, and you approve it. Or add them to `excludedCommands`.
- `docker`, browsers, and watch-mode test runners can fail in the sandbox. Use `excludedCommands`.
- A prompt injection through an MCP tool result is not limited by the sandbox.

## Status

`sandbox.sandbox_status()` gives `{"state", "backend", "reason"}`. The state is `off` (the setting is off), `unavailable` (the setting is on, but the system has no backend: the reason tells why), or `ready`.
