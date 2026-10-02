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

Use the **Connections** screen of the desktop client: Connections in the sidebar, the model chip below the prompt, the "Manage the connections" link on the start screen, or `/connections` (the old name `/providers` also works). The screen adds, changes, tests, and turns off providers. It writes `~/.harness/providers.json` on the daemon computer.

API keys:

- A key that you enter on the Connections screen stays in the keychain of the client computer. The entry gets `"key_store": "client"`. The client sends the key after it connects, and the daemon keeps it in memory only. The key is never in the file.
- `api_key_env` reads the key from an environment variable of the daemon.
- `api_key` in the file is plain text. The Connections screen shows a warning for it.
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
  "openrouter": { "base_url": "https://openrouter.ai/api/v1", "api_key_env": "OPENROUTER_API_KEY" }
}
```

For OpenRouter (`"kind": "openrouter"`, or any `openrouter.ai` URL), give the model as `openrouter/<author>/<model>`, for example `openrouter/anthropic/claude-sonnet-4.5`. The daemon reads the context length, the tool support, and the image input of each model from the OpenRouter model list. It keeps the list for 10 minutes. The connection test also checks the API key with `/key`, because OpenRouter sends the model list with no key.

The daemon finds the context length of a model in this order:

1. `context_length` in the settings.
2. `context_length` of the model or the provider in `providers.json`.
3. The endpoint. For a provider with `ssh`, the requests go through the tunnel. They include the API key, if the provider has one.
   - Ollama: `/api/ps` (a loaded model), then `/api/show` (`num_ctx`).
   - llama-server: `/props` (`n_ctx`).
   - LM Studio: `/api/v0/models` (`loaded_context_length` of a loaded model, else `max_context_length` with a warning: LM Studio can load the model with a smaller context).
   - Text Generation Inference: `/info` (`max_total_tokens`).
   - The model list `/models`: `max_model_len` (vLLM), `context_length` (OpenRouter), `context_window`, or `meta.n_ctx`.
   - OpenRouter: only the model list (`context_length`).
4. The default: 8192 tokens, with a warning.

The client shows the source of the value in the tooltip of the context meter. The connection test on the Connections screen shows the context length of each model (Ollama: the first 40 models).

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

## Package the sidecar

The installers of the desktop app include the daemon as one executable (PyInstaller). Build it on each operating system:

```bash
.venv/Scripts/python -m pip install -e ".[package]"   # Use .venv/bin on macOS and Linux.
.venv/Scripts/python scripts/build_sidecar.py
```

The script builds the folder `build/sidecar/dist/harness-daemon/` (PyInstaller "onedir": the executable and its `_internal` folder), runs the smoke test (`scripts/smoke_sidecar.py`), and copies the folder to `client/src-tauri/binaries/harness-daemon/`. The installers put it in the resource folder of the app (`bundle.resources` in `tauri.bundle.json`). A onefile executable is not used: it unpacked all its files at each start, about 4 seconds. Then build the installers. See [../client/README.md](../client/README.md).

The packaged daemon has no `python` command:

- `harness-daemon --install-browser` installs Chromium for the agent browser. The bundle has the Playwright driver, but not Chromium.
- The Cookbook runs the host script on "This computer" with `harness-daemon --python-stdin`. A `python` in the `local` entry of `hosts.json` replaces it.
- On macOS and Linux, the daemon reads `PATH` from the login shell of the user, because a desktop app gets only the system `PATH`. The daemon also gives the original `LD_LIBRARY_PATH` to its child processes.

## Remote daemon

The same daemon runs on a remote computer. The desktop client connects to it from the Computers screen (the computer button at the bottom of the sidebar).

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
| `harness_daemon/mcp_client.py` | The MCP client: the configuration, the connections in their own thread, and the `mcp__*` tools. |
| `harness_daemon/cookbook/` | The Cookbook: `hosts.py` (hosts, SSH, the host script runner), `hostscript.py` (runs on the host), `gguf.py` (the GGUF header), `fit.py` (the fit calculator), `hub.py` (the Hugging Face browser), `service.py` (downloads and serve control). |
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
| `harness_daemon/frozen.py` | The packaged daemon: `--python-stdin`, `--install-browser`, and the environment repair. |
| `packaging/harness-daemon.spec` | The PyInstaller spec for the sidecar. |
| `scripts/build_sidecar.py` | Builds the sidecar and copies it to the client. |
| `scripts/smoke_sidecar.py` | The smoke test for a built sidecar. |

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
| `max_tool_calls` | `250` | The maximum number of tool calls in one turn. |
| `bash_timeout` | `120` | The default `bash` timeout, in seconds. |
| `bash_max_timeout` | `600` | The maximum `bash` timeout that the model can request. |
| `max_output_chars` | `20000` | Tool output above this length is truncated. |
| `shell` | auto | The shell for `bash`. On Windows, the default is Git Bash, then PowerShell. |
| `default_model` | none | The model for a `session.new` message with no model. |
| `context_length` | none | The context length for all models. See the order above. |
| `ripgrep` | `rg` on the PATH | The ripgrep binary for `glob` and `grep`. Without ripgrep, the tools use a Python search that does not apply `.gitignore`. |
| `auto_verify` | `false` | The agent checks the app with the preview tools after each change to the user interface. The Servers pane of the client changes this value in the project settings. |
| `permission_mode` | `default` | `default` (ask), `acceptEdits` (file changes in the project run), `plan` (no file changes: the agent makes a plan), or `bypassPermissions` (every action runs). The deny rules apply in all modes. The client changes this value with the mode menu or Shift+Tab. |


## MCP servers

The agent uses the tools of MCP servers (SPEC.md section 5.7). The servers come from `~/.harness/mcp.json` (user) and `<project>/.harness/mcp.json` (project). A project server replaces a user server with the same name. The format is the one of Claude Code:

```json
{
  "mcpServers": {
    "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "search": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${SEARCH_TOKEN}" } },
    "old":    { "type": "sse", "url": "http://127.0.0.1:8000/sse", "disabled": true }
  }
}
```

- `type` is `stdio` (the default with `command`), `http` (streamable HTTP), or `sse`. A stdio server runs in the project folder unless it sets `cwd`.
- `${VAR}` and `${VAR:-default}` take values from the environment of the daemon. The MCP panel shows a warning for a variable that is not set.
- `timeout` sets the seconds for one tool call. The default is 120.
- Each tool of a server is a tool of the agent: `mcp__<server>__<tool>`. Each call needs approval. "Always" adds a rule for that tool. The rule `mcp__<server>__*` allows all the tools of one server.
- The servers connect when a session opens. The first turn waits for them up to 20 seconds. A server that sends `tools/list_changed` updates the tools of the agent.
- The output of a stdio server goes to `~/.harness/logs/mcp-<server>.log`. The MCP panel shows its last lines when the server fails.
- `/mcp` opens the MCP panel: the servers, their state, their tools, restart, and a button that creates and opens `.harness/mcp.json`.

## Cookbook

The Cookbook finds, downloads, serves, and deletes local models (SPEC.md section 7). The client calls it **Local Models**, and opens it from the sidebar or with `/local-models` (the old name `/cookbook` also works).

- **Hosts.** "local" is the daemon computer. Remote hosts are in `~/.harness/hosts.json`: `{"gpu-box": {"ssh": "drew@gpu-box", "python": "python3", "llama_server": "~/llama.cpp/build/bin/llama-server"}}`. The daemon runs `harness_daemon/cookbook/hostscript.py` on the host with `python -` (through `ssh` for a remote host). A remote host needs Python 3, and `huggingface_hub` for downloads.
- **SSH key.** The Cookbook makes `~/.harness/ssh/id_ed25519`. Add its public key to `~/.ssh/authorized_keys` on each remote host.
- **Hardware.** `nvidia-smi`, then `rocm-smi`. The system RAM and the CPU core count come from the operating system.
- **Fit.** The daemon reads the layer count, the KV head count, and the head size from the GGUF header with HTTP range requests (or from `config.json` for safetensors). Total = (weights + KV cache) × 1.1, where KV cache = 2 × layers × kv_heads × head_dim × context × 2 bytes. The list badges are estimates from the parameter count (Q4_K_M, 16K context).
- **Downloads.** `huggingface_hub` downloads into the Hugging Face cache of the host (`~/.cache/huggingface/hub`). The parts of a split GGUF file are one download. A pause stops the download. "Continue" starts it again from the `.incomplete` file. Xet downloads are off, so that a download can continue.
- **Serve.** The daemon starts `llama-server` with `-c` (context) and `-ngl` (GPU layers) from the fit calculator, in `tmux` when the host has it (else as a detached process). The server continues after the daemon stops. When `/health` answers, the daemon adds the provider `<host>-llama-<port>` to `providers.json` (with an SSH tunnel for a remote host). A stop removes the provider.
- **Hugging Face token.** The client keeps it in the keychain and sends it after it connects. The daemon keeps it in memory only.
- **Installed models.** The Installed tab lists three sources on the host, and each model has a Delete button:
  - The Cookbook downloads in the Hugging Face cache. A delete removes the files, and a blob that no other file uses.
  - Ollama, through its API on the host (`OLLAMA_HOST`, default `127.0.0.1:11434`). A delete is `DELETE /api/delete`, as `ollama rm` does. The Ollama server must run.
  - LM Studio: the `downloadsFolder` of its `settings.json`, else `~/.lmstudio/models` or `~/.cache/lm-studio/models`. A delete removes the `<publisher>/<model>` folder, and only a folder inside the models folder. Eject a loaded model in LM Studio first.

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
