# harness-daemon

The agent daemon: the agent loop, the tools, the permission gate, sessions, and the WebSocket server.

## Set up

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"   # Windows
.venv/bin/python -m pip install -e ".[dev]"       # macOS and Linux
.venv/Scripts/python -m playwright install chromium   # The agent browser. Use .venv/bin on macOS and Linux.
```

## Configure a model provider

Use the **Providers** screen of the desktop client: the model chip in the title bar, the "Manage the providers" link on the start screen, or `/providers`. The screen adds, changes, tests, and turns off providers. It writes `~/.harness/providers.json` on the daemon computer.

API keys:

- A key that you enter on the Providers screen stays in the keychain of the client computer. The entry gets `"key_store": "client"`. The client sends the key after it connects, and the daemon keeps it in memory only. The key is never in the file.
- `api_key_env` reads the key from an environment variable of the daemon.
- `api_key` in the file is plain text. The Providers screen shows a warning for it.
- The order: `api_key`, then `api_key_env`, then the client key.

`"enabled": false` turns a provider off. A model name with no provider uses the first provider that is on.

You can also edit the file by hand. If the file does not exist, the daemon uses Ollama on `localhost:11434`.

```json
{
  "local-ollama": {
    "base_url": "http://localhost:11434/v1",
    "api_key": "ollama",
    "models": { "qwen2.5-coder:7b": { "context_length": 32768 } }
  },
  "openrouter": { "base_url": "https://openrouter.ai/api/v1", "api_key_env": "OPENROUTER_API_KEY", "context_length": 128000 }
}
```

The daemon finds the context length of a model in this order:

1. `context_length` in the settings.
2. `context_length` of the model or the provider in `providers.json`.
3. The endpoint: Ollama `/api/ps` and `/api/show` (`num_ctx`), llama-server `/props`, or the model list (`max_model_len`).
4. The default: 8192 tokens, with a warning.

### A model on another computer, through SSH

Add `ssh` to a provider. The `base_url` is then the model address as the SSH host sees it:

```json
{
  "gpu-box": { "base_url": "http://127.0.0.1:11434/v1", "api_key": "ollama", "ssh": "drew@gpu-box" }
}
```

- `ssh` is `"host"`, `"user@host"`, `"user@host:port"`, or `{"host", "user", "port", "identity_file"}`.
- Before a model call, the daemon opens `ssh -N -L` to the model server on a free local port. It keeps the tunnel open, opens a new one if ssh stops, and closes all tunnels when it stops.
- SSH must log in with a key (`BatchMode=yes`). A new host key is accepted on the first connection.
- With the local daemon ("This computer"), the agent creates and changes files on your computer, and only the model runs on the other computer.

Ollama uses a small context (4096 tokens) unless the model or the server sets a larger one. Set `OLLAMA_CONTEXT_LENGTH` for the Ollama server, or set `context_length` in `providers.json`.

## Run

Phase 1 test. Run the agent loop in the terminal, with no WebSocket:

```bash
python scripts/agent_repl.py --cwd /path/to/project --model local-ollama/qwen2.5-coder:7b
```

Phase 2 test. Start the daemon, then connect with the CLI client:

```bash
python -m harness_daemon
python scripts/ws_client.py --port <port> --token <token> --cwd /path/to/project --model local-ollama/qwen2.5-coder:7b
```

The daemon prints `{"event": "ready", "port": ..., "token": ...}` on start. Use these values in the client.

## Remote daemon

The same daemon runs on a remote computer. The desktop client connects to it from the Connections screen.

1. Install the daemon on the remote computer (see "Set up").
2. Start it with a fixed port:

   ```bash
   python -m harness_daemon --port 8765
   ```

3. The daemon prints its token. It also keeps the token in `~/.harness/daemon-token`, so the token stays the same after a restart. `--new-token` makes a new token.
4. Select how the client connects:
   - **SSH tunnel:** keep the default address `127.0.0.1`. The desktop app opens `ssh -N -L` to the daemon port. SSH must log in with a key.
   - **Tailscale or a LAN:** add `--host` with the address of the computer on that network, for example `--host 100.64.0.5`. Never expose the daemon port to the internet.

The providers, the skills, and the sessions of a remote daemon are the ones on the remote computer.

## Test

```bash
python -m pytest
```

The tests use a fake OpenAI-compatible server (`tests/fake_openai.py`). They do not need a real model. The agent browser tests need Chromium for Playwright. Without it, pytest skips them.

## Files

| File | Function |
|---|---|
| `harness_daemon/agent.py` | The agent loop. |
| `harness_daemon/providers.py` | Providers, the tool support check, and the streaming model client. |
| `harness_daemon/provider_config.py` | Changes to `providers.json` from the Providers screen, the client keys, and the connection test. |
| `harness_daemon/tools/` | The `read`, `glob`, `grep`, `edit`, `write`, `bash`, `skill`, and `preview_*` tools. |
| `harness_daemon/browser.py` | The agent browser: a headless Chromium through Playwright, in its own thread. The page snapshot script. |
| `harness_daemon/preview.py` | The preview host of a session: the servers, the agent browser, and the URL allow list. |
| `harness_daemon/tunnels.py` | SSH tunnels to model endpoints. |
| `harness_daemon/skills.py` | The skill loader, the frontmatter parser, and the argument substitution. |
| `harness_daemon/context.py` | Context control: the token estimate, the summary, and the trim of old tool outputs. |
| `harness_daemon/prompt.py` | The system prompt and the project instruction file (`HARNESS.md`, then `CLAUDE.md`). |
| `harness_daemon/permissions.py` | Permission rules and the permission gate. |
| `harness_daemon/server.py` | The WebSocket server and the message handlers. |
| `harness_daemon/storage.py` | SQLite storage for sessions and messages. |
| `harness_daemon/config.py` | Paths and settings. |

## Skills

The daemon loads skills in the Claude Code `SKILL.md` format from these folders. A later folder has priority:

1. `~/.claude/skills/` (or `$CLAUDE_CONFIG_DIR/skills/`)
2. `~/.harness/skills/`
3. `<project>/.claude/skills/`
4. `<project>/.harness/skills/`

- The system prompt lists the name and the description of each skill that the model can start. The model loads the body with the `skill` tool.
- The user starts a skill with `/name arguments`. The daemon puts the body in the turn directly.
- The `read`, `glob`, and `grep` tools can read the skill folders, so a skill can use its reference files. The `edit` and `write` tools cannot change them.
- `allowed-tools` rules apply until the end of the turn in which the skill starts.
- A skill with `context: fork` runs in a subagent with a new context. Only its final report goes back to the main conversation.

## Settings

Global settings are in `~/.harness/settings.json`. Project settings are in `<project>/.harness/settings.json`. Project values override global values.

| Key | Default | Function |
|---|---|---|
| `max_tool_calls` | `50` | The maximum number of tool calls in one turn. |
| `bash_timeout` | `120` | The default `bash` timeout, in seconds. |
| `bash_max_timeout` | `600` | The maximum `bash` timeout that the model can request. |
| `max_output_chars` | `20000` | Tool output above this length is truncated. |
| `shell` | auto | The shell for `bash`. On Windows, the default is Git Bash, then PowerShell. |
| `default_model` | none | The model for a `session.new` message with no model. |
| `context_length` | none | The context length for all models. See the order above. |
| `ripgrep` | `rg` on the PATH | The ripgrep binary for `glob` and `grep`. Without ripgrep, the tools use a Python search that does not apply `.gitignore`. |
| `auto_verify` | `false` | The agent checks the app with the preview tools after each change to the user interface. The Servers pane of the client changes this value in the project settings. |
| `image_input` | auto | `true` or `false` overrides the image input check of the model. See "Agent preview tools". |
| `allow`, `deny` | `[]` | Permission rules. See `harness_daemon/permissions.py`. |

## Agent preview tools

The agent starts the servers of `.harness/launch.json` and operates a headless Chromium, so that it can check its own changes.

| Tool | Function | Needs approval |
|---|---|---|
| `preview_start` | Starts a server and waits until it is ready. | The first start of each command. The rule is `server(<command>)`, the same rule as the Servers pane. |
| `preview_stop` | Stops one server or all servers. | No |
| `preview_logs` | Reads the last output lines of a server. | No |
| `preview_navigate` | Opens a full URL, or a path on the current page or the running server. | Only a URL that is not a server of `launch.json`. The rule is `preview_navigate(<origin>/*)`. |
| `preview_snapshot` | Returns the page as a text tree. Each element that the agent can operate has a reference, for example `[ref=e5]`. | No |
| `preview_click` | Clicks an element by reference. | No |
| `preview_fill` | Types text into a text box, or selects an option of a select box. | No |
| `preview_console` | Returns the console errors, the failed requests, and the uncaught errors of the current page. | No |
| `preview_screenshot` | Returns a JPEG screenshot. | No |

- The browser starts on the first browser tool call, and it stops when the session closes.
- The browser blocks a page navigation to a URL that is not a server of `launch.json` and that the user did not approve. The current page stays. Page resources (scripts, styles, images) are not blocked.
- A reference is valid only on the page that the snapshot read. The numbers continue on the next page, so an old reference never selects an element of a new page.
- After each navigation, click, and fill, the daemon sends a `preview.frame` message with a small screenshot. The Browser pane of the client shows it in the agent view.
- `preview_screenshot` is only in the tool list of a model with image input. The daemon finds image input in this order: `image_input` in the settings, `image_input` of the model in `providers.json`, then the Ollama capability `vision`. The default is no image input.
- The newest screenshot of the current turn goes to the model in a user message after the tool results. Older screenshots stay in the history for the client only.
