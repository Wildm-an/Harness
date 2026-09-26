# harness-daemon

The agent daemon: the agent loop, the tools, the permission gate, sessions, and the WebSocket server.

## Set up

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"   # Windows
.venv/bin/python -m pip install -e ".[dev]"       # macOS and Linux
```

## Configure a model provider

Create `~/.harness/providers.json`. If the file does not exist, the daemon uses Ollama on `localhost:11434`.

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

The tests use a fake OpenAI-compatible server (`tests/fake_openai.py`). They do not need a real model.

## Files

| File | Function |
|---|---|
| `harness_daemon/agent.py` | The agent loop. |
| `harness_daemon/providers.py` | Providers, the tool support check, and the streaming model client. |
| `harness_daemon/tools/` | The `read`, `glob`, `grep`, `edit`, `write`, and `bash` tools. |
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
| `allow`, `deny` | `[]` | Permission rules. See `harness_daemon/permissions.py`. |
