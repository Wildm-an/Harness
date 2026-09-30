# Coding Harness Specification

Project name: TBD. This file uses "the harness" as the name.

## 1. Goal

The harness is a desktop app for agentic coding. It operates like Claude Code. It also has a Cookbook for local model setup, similar to the Odysseus Cookbook.

The harness must:

- Connect to a local model on the same device.
- Connect to a remote agent daemon on a remote machine.
- Load skills in the Claude Code `SKILL.md` format.
- Let the user start a skill with `/skill-name` in the prompt.
- Have a built-in code editor, a browser pane, and a local server screen, similar to the Claude Code desktop app.

## 2. Architecture

The harness has four components:

| Component | Runs on | Function |
|---|---|---|
| Desktop client | User device | UI only. It shows chat, diffs, and approval prompts. It does not run tools. |
| Agent daemon | Machine with the code | Agent loop, tools, skills, memory, and sessions. |
| Model endpoint | Any machine | An OpenAI-compatible server: Ollama, `llama-server`, or a cloud API. |
| Cookbook service | Inside the daemon | Hardware detection, model fit, downloads, and serve control. |

Rules:

- The client connects to one daemon at a time over a WebSocket.
- The daemon and the model endpoint can be on different machines.
- For local mode, the client starts a daemon as a sidecar process.
- For remote mode, the client connects to a daemon that already runs on the remote host.
- The same daemon code runs in local mode and remote mode.

## 3. Technology stack

| Part | Choice | Reason |
|---|---|---|
| Desktop shell | Tauri 2 | Small binary. Supports a bundled sidecar process. |
| Client UI | React + TypeScript + Vite | Large component set for chat and diff views. |
| Daemon | Python 3.11+ with FastAPI | Same stack as Odysseus. Good LLM library support. |
| Daemon packaging | PyInstaller | Makes one binary for the Tauri sidecar. |
| Storage | SQLite | Sessions, history, and settings. |
| Model client | `openai` Python SDK | One client for Ollama, `llama-server`, and cloud APIs. |
| Code editor | Monaco Editor | The editor from VS Code. Syntax colors, search, and a diff mode. |
| Browser pane | Tauri 2 child webview | Shows the running app and external sites in the main window. |
| Agent browser | Playwright with headless Chromium, in the daemon | Lets the agent inspect and operate the app on the daemon host. |

## 4. Client–daemon protocol

Transport: WebSocket at `ws://<host>:<port>/ws`. Messages are JSON. Each message has a `type` field.

### Client to daemon

| `type` | Fields | Function |
|---|---|---|
| `auth` | `token` | First message. The daemon closes the socket on a bad token. |
| `session.new` | `cwd`, `model` | Starts a session in a project folder. |
| `session.resume` | `session_id` | Loads a past session. |
| `prompt` | `text` | A normal user message. |
| `command` | `name`, `args` | A slash command. The client sends it separately from `prompt`. |
| `permission.reply` | `request_id`, `decision` | `allow_once`, `allow_always`, or `deny`. |
| `interrupt` | — | Stops the current turn. |
| `skills.list` | — | Asks for the slash menu contents. |
| `hf.search` | `query`, `filters`, `sort`, `page`, `host` | Searches Hugging Face. |
| `hf.model` | `repo_id`, `host` | Asks for model details and fit results. |
| `hf.download` | `repo_id`, `files`, `host` | Starts a download. |
| `fs.list` | `path` | Asks for a folder tree. |
| `fs.read` | `path` | Opens a file in the editor. |
| `fs.write` | `path`, `content`, `base_hash` | Saves a file from the editor. |
| `server.list` | — | Asks for the server configurations and their status. |
| `server.start` | `name` | Starts a server. |
| `server.stop` | `name` or `all` | Stops one server or all servers. |

### Daemon to client

| `type` | Fields | Function |
|---|---|---|
| `token` | `text` | Streamed model output. |
| `tool.start` | `id`, `name`, `input` | The daemon starts a tool. |
| `tool.result` | `id`, `output`, `is_error` | The tool result. |
| `permission.request` | `request_id`, `tool`, `input`, `diff` | The daemon asks for approval. |
| `skills` | `items` | List of `name`, `description`, `argument-hint`, `source`. |
| `turn.end` | `usage` | The turn is complete. Includes the token counts. |
| `prompt.suggestion` | `text` | After a turn that ends normally: the next prompt that the model predicts. The client shows it in the empty prompt box. Tab puts it in the box. The project setting `prompt_suggestions: false` switches it off. |
| `hf.results` | `items`, `page`, `has_more` | Search results with fit badges. |
| `hf.detail` | `card`, `files`, `recommended` | Model card, file list, and fit result for each quant. |
| `download.progress` | `id`, `bytes_done`, `bytes_total` | Download progress. |
| `fs.tree` | `items` | The folder tree. |
| `fs.content` | `path`, `content`, `hash` | The file contents. |
| `fs.changed` | `path`, `hash`, `by` | A file changed on disk. `by` is `agent` or `external`. |
| `fs.conflict` | `path`, `disk_hash` | The file changed after the editor opened it. The save stops. |
| `server.status` | `name`, `state`, `port`, `url` | `stopped`, `starting`, `running`, or `crashed`. |
| `server.log` | `name`, `stream`, `text` | Server output from `stdout` or `stderr`. |
| `error` | `message` | A daemon error. |

## 5. Agent daemon

### 5.1 Agent loop

1. Build the system prompt: base prompt, project instruction file, skill list, and tool schemas.
2. Send the messages to the model endpoint.
3. If the model returns tool calls, run them in order.
4. Append the tool results to the messages.
5. Repeat until the model returns no tool calls, or the user sends `interrupt`.
6. Set a maximum of 50 tool calls for each turn. Make this value configurable.

### 5.2 Tools

Keep the tool set small. Small local models make more errors with many tools.

| Tool | Function | Needs approval |
|---|---|---|
| `read` | Reads a file, with an optional line range. | No |
| `glob` | Finds files by pattern. | No |
| `grep` | Searches file contents. Uses `ripgrep` if it is available. | No |
| `edit` | Replaces an exact string in a file. | Yes |
| `write` | Creates or overwrites a file. | Yes |
| `bash` | Runs a shell command in the project folder. | Yes |
| `skill` | Loads the body of a skill. | No |
| `preview_*` | Controls servers and the agent browser. See section 8.7. | Some |

Rules:

- All paths must stay inside the session `cwd`. The daemon rejects other paths.
- `bash` has a timeout. The default is 120 seconds.
- Truncate tool output above 20,000 characters. Tell the model that the output is truncated.

### 5.3 Permission gate

- Before a tool that needs approval runs, the daemon sends `permission.request`.
- For `edit` and `write`, the request includes a unified diff.
- `allow_always` adds a rule to the project settings file.
- Store rules in `.harness/settings.json`, for example `"allow": ["bash(git status)", "bash(npm test)"]`.

### 5.4 Project instruction file

- At session start, read `HARNESS.md` in the project root.
- If `HARNESS.md` does not exist, read `CLAUDE.md`.
- Put the file contents in the system prompt.

### 5.5 Context control

- Read the context length of the model from the endpoint, or from the model settings.
- When the context reaches 80% of the limit, summarize the old turns with the model.
- Keep the system prompt, the summary, and the last 4 turns.
- The `/compact` command starts a summary at any time.

### 5.6 Model providers

Each provider is an entry in `~/.harness/providers.json`:

```json
{
  "local-ollama": { "base_url": "http://localhost:11434/v1", "api_key": "ollama" },
  "remote":       { "base_url": "http://<remote-host>:11434/v1", "api_key": "ollama" }
}
```

- Before a session starts, check that the model supports tool calls. For Ollama, use `/api/show`.
- Show a warning if the model does not support tool calls.

### 5.7 MCP

- Support MCP servers through stdio and HTTP.
- Read the server list from `.harness/mcp.json` and `~/.harness/mcp.json`.
- Add MCP tools to the tool list with the prefix `mcp__<server>__`.
- MCP tools need approval by default.

### 5.8 Plugins

- A plugin is a Python module in a bundle folder in `~/.harness/plugins/`. The model is a port of the DeepSeek Harness plugin model.
- A plugin registers tools, `/` commands, skills, system prompt sections, hooks, MCP servers, and model providers in code.
- YAML patch files in layers turn each plugin on or off and give its config.
- See [docs/PLUGINS.md](docs/PLUGINS.md).

## 6. Skills

The skill format is the same as the Claude Code format. Existing Claude Code skills must load with no changes.

### 6.1 Format

Each skill is a folder with a `SKILL.md` file. The file has YAML frontmatter and a Markdown body. The folder can also hold reference files and scripts.

Supported frontmatter fields:

| Field | Function |
|---|---|
| `name` | Command name. Defaults to the folder name. |
| `description` | The model reads this to decide when to load the skill. |
| `disable-model-invocation` | If `true`, only the user can start the skill. |
| `user-invocable` | If `false`, the skill does not show in the `/` menu. |
| `allowed-tools` | Tools that run without approval while the skill runs. |
| `argument-hint` | Autocomplete text in the `/` menu. |
| `context` | If `fork`, the skill runs in a subagent with a new context. |

### 6.2 Argument substitution

| Placeholder | Value |
|---|---|
| `$ARGUMENTS` | All text after the command name. |
| `$0`, `$1`, ... | One argument by position. |
| `${CLAUDE_SKILL_DIR}` | The skill folder. |
| `${CLAUDE_PROJECT_DIR}` | The project root. |

Also accept `${HARNESS_SKILL_DIR}` and `${HARNESS_PROJECT_DIR}` with the same values.

### 6.3 Skill locations

The daemon scans these folders on the machine where it runs:

1. `~/.harness/skills/`
2. `~/.claude/skills/`
3. `<project>/.harness/skills/`
4. `<project>/.claude/skills/`

If two skills have the same name, the project skill wins. Show the source of each skill in the `/` menu.

### 6.4 Model invocation

1. At session start, parse only the frontmatter of each skill.
2. Put the name and description of each model-invocable skill in the system prompt.
3. The model calls the `skill` tool to load the full body.
4. The model reads reference files only when the body tells it to.

### 6.5 User invocation with `/`

1. When the user types `/` at the start of the prompt, the client sends `skills.list`.
2. The client shows a menu of built-in commands and user-invocable skills.
3. The menu filters as the user types.
4. On send, the client sends a `command` message.
5. The daemon substitutes the arguments and injects the skill body into the turn.
6. The daemon does not ask the model to call the `skill` tool for a slash command.

### 6.6 Built-in commands

Built-in commands have priority over skills with the same name.

| Command | Function |
|---|---|
| `/clear` | Starts a new context in the same session. |
| `/compact` | Summarizes the context. |
| `/model` | Changes the model. |
| `/skills` | Lists the skills and their sources. |
| `/plugins` | Opens the Plugins screen. |
| `/cookbook` | Opens the Cookbook panel. |
| `/servers` | Opens the Servers pane. |
| `/preview` | Starts the default server and opens it in the Browser pane. |
| `/help` | Lists the commands. |

## 7. Cookbook

The Cookbook helps the user select, download, and serve local models.

### 7.1 Hardware detection

- Detect the GPU model, the VRAM, the system RAM, and the CPU core count.
- Use `nvidia-smi` for NVIDIA. Use `rocm-smi` for AMD.
- Run the detection on the daemon host, or on a remote host through SSH.

### 7.2 Fit calculator

For each model, quant, and context size, calculate:

- Weight size from the file size of the GGUF.
- KV cache size: `2 × layers × kv_heads × head_dim × context × bytes_per_value`.
- Total VRAM: weights + KV cache + 10% overhead.

Show one of three results: fits in VRAM, fits with CPU offload, or does not fit. Show the maximum context that fits in VRAM.

### 7.3 Hugging Face model browser

The Cookbook shows the models that are available on Hugging Face. Use the `HfApi` class from `huggingface_hub`.

**Search and filters**

- Search by text, for example `qwen coder`.
- Filter by library: `gguf` by default. Also allow `safetensors` for vLLM.
- Filter by task: `text-generation` by default.
- Filter by parameter count, for example 7B, 14B, or 32B.
- Sort by downloads, likes, trending, or last update.
- Show 25 results on each page, with more pages on request.

**Model list**

Each result shows:

- The repository name and the author.
- The parameter count and the license.
- The download count, the like count, and the last update date.
- A fit badge from the fit calculator: fits, offload, or does not fit.
- A lock icon for gated models.

**Model detail view**

- Show the model card (`README.md`) as rendered Markdown.
- List each GGUF file with its quant type and file size. Use `model_info(..., files_metadata=True)`.
- Show the fit result for each quant on the selected host.
- Mark the recommended quant: the largest quant that fits in VRAM with a 16K context.
- Show a "Download" button for each file.

**Filter by fit**

- A "Show only models that fit" option hides models that do not fit on the selected host.
- The fit check uses the hardware of the selected host, local or remote.

**Hugging Face token**

- The user can add a Hugging Face token on the Settings screen.
- Store the token in the operating system keychain.
- The daemon needs the token for gated models, such as some Llama and Gemma models.
- For a gated model without access, show a link to the model page. The user accepts the license there.

**Cache**

- Cache search results for 10 minutes.
- Cache model details for 1 hour.
- The browser operates without a token for public models.

### 7.4 Downloads

- Download with `huggingface_hub`. Show progress in the client.
- Download split GGUF files (`-00001-of-0000N`) as one model.
- Let the user pause, continue, and cancel a download.
- Store models in `~/.cache/huggingface`.
- Show the installed models, with their disk size and a "Delete" button.

### 7.5 Serve control

- Start and stop `llama-server` with the settings from the fit calculator.
- Run the process in `tmux` so that it continues after the daemon stops.
- After the model starts, add it to `providers.json`.
- Show the server log in the client.

### 7.6 Remote hosts

- Generate an SSH key in `~/.harness/ssh/`.
- Show the public key. The user adds it to `~/.ssh/authorized_keys` on the remote host.
- Run hardware detection, downloads, and serve control through SSH.

## 8. Desktop client

### 8.1 Screens

- **Chat** — Messages, streamed output, tool cards, and the prompt box with the `/` menu.
- **Diff review** — Side-by-side diff for each approval request.
- **Editor** — Built-in code editor. See section 8.5.
- **Browser** — Embedded browser. See section 8.6.
- **Servers** — Local server startup screen. See section 8.7.
- **Connections** — Local daemon and remote daemons. Each entry has a host, a port, and a token.
- **Providers** — Model endpoints and a connection test.
- **Cookbook** — Hardware, Hugging Face model browser, fit results, downloads, installed models, and running servers.
- **Skills** — Installed skills, sources, and a file viewer.
- **Settings** — Theme, permission rules, and defaults.

### 8.2 Local mode

- The client starts the daemon sidecar on `127.0.0.1` with a random port.
- The client makes a random token for each start.

### 8.3 Remote mode

- The user adds a remote daemon on the Connections screen.
- Connect through Tailscale or an SSH tunnel.

### 8.4 Pane layout

- The main window holds panes: Chat, Diff, Editor, Browser, and Servers.
- The user can put panes side by side, stack them, or close them.
- The client saves the layout for each project.
- Default layout: Chat on the left. Editor and Browser as tabs on the right.

### 8.5 Code editor

The editor reads and writes files through the daemon. Thus it operates the same way in local mode and remote mode.

**Features**

- A file tree of the session folder, with the `.gitignore` files applied.
- Tabs for open files.
- Syntax colors, bracket match, search, and replace in each file.
- Search across the project. The daemon runs `ripgrep`.
- Save with `Ctrl+S` or `Cmd+S`.
- A "modified" mark on tabs with unsaved changes.
- Go to a line from a path in the chat, for example `src/app.py:42`.

**Agent edits**

- When the agent changes an open file, the daemon sends `fs.changed`.
- If the tab has no unsaved changes, the editor loads the new contents.
- If the tab has unsaved changes, the editor shows a choice: keep my version, load the disk version, or compare.
- The editor marks the lines that the agent changed in the current turn.

**Save conflicts**

- Each `fs.write` message includes the hash of the file when the editor opened it.
- If the file on disk has a different hash, the daemon sends `fs.conflict` and does not save.
- The editor then shows a diff of the two versions.

**Context from the editor**

- The user can select lines and send them to the chat as a reference, for example `@src/app.py:10-25`.
- The daemon adds the selected lines to the next prompt.

### 8.6 Browser pane

The Browser pane is for the user. The agent uses a separate headless browser in the daemon. See section 8.7.

**Features**

- An address bar, back, forward, and refresh.
- Open the running app from the Servers pane with one click.
- Open external sites.
- Open project files: HTML, PDF, images, and video. Click a path in the chat to open it.
- A device size menu: desktop, tablet, and phone.
- An option to keep cookies and local storage when a server restarts.
- A button that opens the browser developer tools.

**Remote mode**

- A server on a remote machine listens on that machine, not on the user device.
- The daemon forwards each server port to the client through the WebSocket connection.
- The client maps the port to `http://127.0.0.1:<local-port>` and opens that address in the Browser pane.
- The daemon forwards only the ports of servers in `launch.json`.

### 8.7 Servers pane and local server startup

**Configuration file**

The daemon stores server configurations in `.harness/launch.json` in the project root:

```json
{
  "servers": [
    {
      "name": "web",
      "command": "npm run dev",
      "cwd": ".",
      "port": 5173,
      "ready_pattern": "Local:.*http",
      "env": { "NODE_ENV": "development" },
      "default": true
    },
    {
      "name": "api",
      "command": "uvicorn app:app --reload --port 8000",
      "cwd": "backend",
      "port": 8000,
      "health_url": "http://127.0.0.1:8000/health"
    }
  ]
}
```

**Auto-detection**

If `launch.json` does not exist, the daemon reads the project and proposes a configuration:

| File found | Proposed command |
|---|---|
| `package.json` with a `dev` script | `npm run dev` (or `pnpm` or `yarn`, from the lock file) |
| `vite.config.*` | `npx vite` |
| `next.config.*` | `npx next dev` |
| `manage.py` | `python manage.py runserver` |
| `app.py` or `main.py` with FastAPI | `uvicorn <module>:app --reload` |
| `app.py` with Flask | `flask run` |
| `index.html` only | `python -m http.server 8080` |

The user approves the proposal before the daemon writes `launch.json`.

**Servers pane**

- A list of each configured server, with its state, port, and URL.
- Start, stop, and restart buttons for each server.
- A "Stop all" button.
- A live log view for each server, with separate colors for `stdout` and `stderr`.
- An "Open in browser" button for each running server.
- An "Edit configuration" button that opens `launch.json` in the editor.
- A dropdown in the session toolbar that shows the same controls.

**Server startup rules**

- The daemon starts each server as a child process in the `cwd` of the configuration.
- A server is `running` when its output matches `ready_pattern`, or when `health_url` returns HTTP 200.
- If the port is in use, the daemon tells the user and does not start the server.
- If a server stops with an error, the state changes to `crashed`. The pane shows the last 50 log lines.
- When the session closes, the daemon stops the servers that it started.
- The first start of each command needs approval. After approval, the command goes in the permission rules.

**Agent preview tools**

The agent uses a headless Chromium through Playwright in the daemon. These tools let the agent check its own changes.

| Tool | Function | Needs approval |
|---|---|---|
| `preview_start` | Starts a server from `launch.json`. | First time only |
| `preview_stop` | Stops a server. | No |
| `preview_logs` | Reads the last server log lines. | No |
| `preview_navigate` | Opens a URL of a running server. | No |
| `preview_snapshot` | Returns the page as an accessibility tree with element references. | No |
| `preview_click` | Clicks an element by reference. | No |
| `preview_fill` | Types text into an element by reference. | No |
| `preview_console` | Returns the browser console errors. | No |
| `preview_screenshot` | Returns a screenshot. Only for models with image input. | No |

Rules:

- The agent browser can open only the URLs of servers in `launch.json`.
- For other URLs, the agent needs approval.
- Use `preview_snapshot` before `preview_screenshot`. Text costs less context, and most local models have no image input.
- An "Auto-verify" setting tells the agent to check the app after each UI change. The default is off. The user can set it for each project.
- The Browser pane can show the agent browser page, so the user can see the agent actions.

## 9. Security

- The daemon binds to `127.0.0.1` by default.
- The daemon requires a token on every connection.
- Do not expose the daemon port to the internet.
- `bash` runs in the project folder. An optional Docker sandbox mode runs `bash` in a container.
- Store API keys and the Hugging Face token in the operating system keychain through Tauri. Do not store them in plain text.
- The Browser pane runs in a separate webview. Pages in it cannot call Tauri commands.
- The daemon forwards only the server ports from `launch.json`.
- The editor can open only files inside the session folder.
- Plugin code runs in the daemon process with the rights of the daemon. A project patch file can name only the modules of installed bundles.

## 10. Build phases

Complete each phase and test it before the next phase starts.

1. **Daemon core** — Agent loop, one provider, and the `read`, `edit`, and `bash` tools. Test from a Python script.
2. **Protocol** — WebSocket server and all message types. Test with a WebSocket CLI client.
3. **Desktop client** — Tauri shell, chat screen, and streamed output.
4. **Permissions** — Permission gate and diff review screen.
5. **All tools and context control** — Remaining tools, project instruction file, and compaction.
6. **Skills** — Loader, `skill` tool, `/` menu, and argument substitution.
7. **Remote mode** — Connections screen and remote daemon support.
8. **Code editor** — Pane layout, file tree, Monaco editor, save conflicts, and agent edit updates.
9. **Servers and browser** — `launch.json`, auto-detection, Servers pane, Browser pane, and port forward.
10. **Agent preview tools** — Playwright browser and the `preview_*` tools.
11. **Cookbook** — Hardware detection, fit calculator, Hugging Face model browser, downloads, and serve control.
12. **MCP** — MCP client and tool approval.
13. **Packaging** — PyInstaller sidecar and Tauri installers for Windows, macOS, and Linux.

## 11. Out of scope for version 1

- Multiple agents in parallel.
- Git worktree isolation.
- Language server features, such as autocomplete and go to definition.
- Voice input.
