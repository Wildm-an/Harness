# Client–daemon protocol



This file records the protocol as the daemon implements it. SPEC.md section 4 is the base. This file adds the messages and fields that SPEC.md does not list.



Transport: WebSocket at `ws://<host>:<port>/ws`. Each message is one JSON object with a `type` field.



## Connection



1. The client opens the socket.

2. The client sends `{"type": "auth", "token": "..."}` as the first message.

3. The daemon sends `auth.ok`, or closes the socket with code `4401`.

4. The daemon closes the socket with code `4401` if the first message does not arrive in 10 seconds.



## Additions to SPEC.md



### Client to daemon



| `type` | Fields | Function |

|---|---|---|

| `session.new` | `cwd`, `model`, `provider` (optional) | `model` is `<provider>/<model>` or `<model>`. A bare model uses `provider`, or the first provider in `providers.json`. If `model` is empty, the daemon uses `default_model` from the settings. |

| `session.list` | `cwd` (optional), `limit` (optional) | Asks for the stored sessions, newest first. With `cwd`, only the sessions of that folder (case-insensitive on Windows). `limit` is 50 by default, and at most 500. |
| `session.leave` | — | The client shows the start screen. The current session closes, or stays open in the background if a turn or its shell runs. |
| `term.open` | `cols`, `rows`, `id` (optional), `since` (optional) | Shows the shell of the terminal pane: the running shell of the session, or a new shell in the project folder. `since` is the number of the last output that the client has for the shell `id`. |
| `term.input` | `id`, `data` | Sends typed text to the shell. |
| `term.resize` | `id`, `cols`, `rows` | Changes the size of the terminal. |
| `projects.list` | — | Asks for the saved projects, the last used first. This needs no session. |
| `projects.save` | `path`, `name` (optional), `id` (optional), `create` (optional) | Adds a project, or changes the project `id`. `path` must be absolute. With `create`, the daemon makes a missing folder. Two projects cannot use the same folder. |
| `projects.delete` | `id` | Removes a project from the list. The folder, its files, and its sessions stay. |

| `fs.dirs` | `path` (optional), `hidden` (optional) | Asks for the folders in a folder of the daemon host. The default is the home folder. This needs no session: the client uses it to select a project folder on a remote daemon. |
| `context.get` | none | Asks for the context breakdown of the session. The reply is `context.usage`. |
| `fs.find` | `query` | File and folder names for the "@" menu of the prompt box. The reply is `fs.found`. |
| `fs.search` | `query`, `regex` (optional), `case` (optional), `glob` (optional) | Searches the project for the editor. Without `regex`, `query` is plain text. Without `case`, the search ignores case. |
| `fs.unwatch` | `path` | The editor closed a file. The daemon stops the change reports for it. |
| `server.list` | — | Asks for the servers of `.harness/launch.json`. |
| `server.save` | `servers` | Writes `.harness/launch.json`: the approved proposal, or a changed list. |
| `server.start` | `name` | Starts a server. The first start of each command needs approval (`permission.request` with `tool: "server"` and the rule `server(<command>)`). |
| `server.stop` | `name`, or `all: true` | Stops one server or all servers. |
| `server.restart` | `name` | Stops a server, then starts it. |
| `server.logs` | `name` | Asks for the stored log lines of a server (up to 1000). |
| `skills.get` | `name` | Asks for one skill: the SKILL.md text and the files in its folder. |
| `permissions.get` | — | Asks for the permission rules of the session project. |

| `permissions.set` | `allow`, `deny` | Replaces the permission rules. The daemon rejects a rule that is not `tool` or `tool(pattern)`. |
| `providers.list` | — | Asks for the providers of `~/.harness/providers.json` on the daemon computer. This needs no session. |
| `providers.save` | `name`, `base_url`, `kind`, `context_length`, `ssh`, `key`, `api_key_env`, `previous_name` | Adds a provider, or changes the provider `previous_name` (also a rename). `kind` is `auto`, `ollama`, or `openai`. `key` is `keep`, `client` (the key is in the keychain of the client), `env` (with `api_key_env`), or `none`. Other fields of the entry, for example `models`, stay the same. |
| `providers.delete` | `name` | Deletes a provider. The last provider cannot be deleted. |
| `providers.enable` | `name`, `enabled` | Turns a provider on or off. The daemon does not use a provider that is off. |
| `providers.keys` | `keys` | API keys from the keychain of the client: `{"<provider>": "<key>"}`. `null` removes a key. The daemon keeps the keys in memory only. |
| `providers.test` | the `providers.save` fields, `ref`, `api_key` (optional) | Tests the form values: `GET <base_url>/models`. `api_key` is a key that is not saved yet. With no `api_key`, the daemon uses the saved key. |
| `models.list` | — | Asks for the models of each provider that is on. |
| `mcp.list` | — | Asks for the MCP servers of the session. |
| `mcp.restart` | `name` (optional) | Reads the MCP configuration again and connects again: one server, or all servers with no name. Not during a turn. |
| `mcp.init` | — | Creates `.harness/mcp.json` of the project from a template, if it does not exist. |
| `plugins.list` | — | Asks for the plugins. It works with no session. See [PLUGINS.md](PLUGINS.md). |
| `plugins.install` | `source`, `kind` (optional), `replace` (optional), `approved_builds` (optional) | Installs a bundle. `kind` is `harness` (the default: a folder or a git URL) or `deepseek` (an npm name, a git address, a URL, or a local path). `replace` updates an installed Harness bundle. `approved_builds` holds the build-script keys that the user allowed for a DeepSeek install. Not during a turn. |
| `plugins.remove` | `name`, `kind` (optional) | Deletes an installed bundle. Not during a turn. |
| `plugins.set_bundle` | `name`, `enabled`, `kind` (optional) | Turns a bundle on or off. Not during a turn. |
| `plugins.set_plugin` | `id`, `enabled`, `kind` (optional) | Turns one plugin row on or off. Not during a turn. |
| `plugins.reload` | — | Loads the plugins of the session again. A running DeepSeek plugin host starts again. Not during a turn. |
| `cookbook.hosts` | — | Asks for the Cookbook hosts and the public SSH key. |
| `cookbook.host.save` | `name`, `ssh`, `python`, `llama_server`, `previous` (optional) | Adds or changes a host in `~/.harness/hosts.json`. For `local`, only `llama_server`. |
| `cookbook.host.delete` | `name` | Deletes a remote host. |
| `cookbook.ssh_key` | — | Makes the SSH key in `~/.harness/ssh/`, if it does not exist. |
| `cookbook.hardware` | `host`, `refresh` (optional) | Asks for the hardware of a host. The daemon keeps the result for 5 minutes. |
| `hf.token` | `token` | The Hugging Face token from the keychain of the client, or `null`. Memory only. |
| `hf.search` | `query`, `filters`, `sort`, `page`, `host` | `filters` has `library` (`gguf` or `safetensors`), `task`, `params` (`3B`, `7B`, `14B`, `32B`, `70B`, or null), and `fit_only`. `sort` is `downloads`, `likes`, `trending`, or `updated`. 25 results on each page. |
| `hf.model` | `repo_id`, `host` | Asks for the model details and the fit result of each file on the host. |
| `hf.download` | `repo_id`, `files`, `host` | Starts a download. Give all parts of a split GGUF file. |
| `downloads.list` | — | Asks for the downloads of the daemon. |
| `download.pause`, `download.resume`, `download.cancel` | `id` | Controls a download. A cancel removes the unfinished files. |
| `models.installed` | `host` | Asks for the models on the host: the Hugging Face cache, Ollama, and LM Studio. |
| `models.delete` | `host`, `source`, `repo_id`, `files`, `name` | Deletes models. `source` is `hf` (the default: `repo_id` and `files`), `ollama` (`name`: the model, as `ollama rm` does), or `lmstudio` (`name`: `<publisher>/<model>`, the daemon deletes its folder). The reply is `installed`. |
| `serve.list` | `host` | Asks for the models that llama-server serves on the host. |
| `serve.start` | `host`, `repo_id`, `file`, `context` (optional), `port` (optional) | Starts llama-server for a downloaded GGUF file. With no context, the daemon uses the largest context that fits in VRAM (4K to 32K), or 8K with CPU offload. |
| `serve.stop` | `host`, `name` | Stops a served model and removes its provider. |
| `serve.output` | `host`, `name` | Asks for the last lines of the llama-server log. |
| `settings.get` | — | Asks for the project settings that the client can change. |
| `settings.set` | `auto_verify`, `permission_mode` | Changes project settings in `.harness/settings.json`. `permission_mode` is `default`, `acceptEdits`, `plan`, or `bypassPermissions`. The other keys of the file stay the same. The next model call uses the new value. |



### Daemon to client



| `type` | Fields | Function |

|---|---|---|

| `auth.ok` | `version`, `host` | The token is correct. `host` has `hostname`, `platform`, `user`, `home`, and `sep` of the daemon computer. |
| `fs.dirs` | `path`, `parent`, `items`, `roots`, `is_project` | Reply to `fs.dirs`. `items` are folders only (`name`, `path`). `roots` are the drives on Windows, or `/`. `is_project` is true if the folder has `.git`, `HARNESS.md`, `CLAUDE.md`, `package.json`, or `pyproject.toml`. |

| `session.ready` | `session_id`, `cwd`, `model`, `title`, `warnings`, `history`, `summary`, `context_length`, `context_source`, `context_tokens`, `instructions` | Reply to `session.new` and `session.resume`. `context_source` tells where the context length came from: `settings`, `providers.json`, `default`, or an endpoint (for example `llama-server` or `Ollama num_ctx`). `summary` replaces the messages before `history` (null if there is no summary). `instructions` is `HARNESS.md`, `CLAUDE.md`, or null. `history` holds the messages of the current context, in OpenAI chat format. A `tool` message also has `is_error`, and `diff` for a file change. The daemon does not send these fields to the model. |

| `projects` | `items`, `saved` | Reply to the `projects.*` messages. Each item has `id`, `name`, `path`, `exists`, `sessions` (the number of stored sessions in the folder), `created_at`, and `last_used`. `saved` is the id after `projects.save`. `session.new` adds its folder as a project if it is not one. The first daemon start with projects adds the folders of the stored sessions. |
| `context.usage` | `tokens`, `length`, `compact_at`, `source`, `parts` | The size of each part of the next request: `system`, `instructions`, `skills`, `summary`, `tools`, `mcp_tools`, and `messages`. The parts are estimates, scaled so that their sum is `tokens` (the endpoint count of the last request, when the endpoint gives it). |
| `fs.found` | `query`, `items` | Reply to `fs.find`: at most 40 project paths, best match first. A folder ends with `/`. |
| `sessions` | `items`, `cwd` | Reply to `session.list`. `cwd` is the value from the request, or null. Each item has `id`, `cwd`, `provider`, `model`, `title`, `created_at`, and `updated_at`. |
| `term.opened` | `id`, `new`, `replay`, `seq`, `reset` | Reply to `term.open`. `replay` is the output after `since`. If `reset` is true, `replay` is all the kept output (up to 256 KB), and the client clears its screen first. `seq` is the number of the last output. |
| `term.output` | `id`, `data`, `seq` | Shell output. `seq` goes up by 1 for each message. |
| `term.exit` | `id`, `code` | The shell stopped. The next `term.open` starts a new shell. |
| `sessions.running` | `items` | The sessions of the connection that have a running turn. Each item has `session_id` and `waiting` (the turn waits for a permission decision). The daemon sends it when the list changes. |

| `command.result` | `name`, and `text`, `items`, `model`, `warnings`, `action`, or `panel` | Reply to a built-in command. `action: "open_panel"` tells the client to open `panel`. |

| `fs.saved` | `path`, `hash` | Reply to a `fs.write` that succeeded. |

| `servers` | `items` | Reply to `server.list`. |

| `context.compacted` | `reason`, `removed_messages`, `trimmed_outputs`, `summary`, `context_tokens`, `context_length` | The daemon summarized old turns (`reason` is `auto` or `manual`), or removed old tool outputs. |
| `skill` | the `skills` item fields, `allowed-tools`, `content`, `files` | Reply to `skills.get`. `content` is the full SKILL.md text. `files` are relative to the skill folder. |
| `fs.results` | `query`, `items`, `truncated` | Reply to `fs.search`. Each item has `path`, `line`, and `text`. The limit is 500 items. |
| `servers` | `items`, `path`, `config`, `error`, `proposal` | Reply to `server.list` and `server.save`. `config` is `exists`, `missing`, or `invalid`. If it is `missing`, `proposal` holds the servers that the daemon found in the project. Each item has the `server.status` fields and `command`, `cwd`, `default`, `ready_pattern`, and `health_url`. |
| `server.status` | `error`, `last_lines` | Additions to SPEC.md: `error` explains a stop (for example, the port is in use). A `crashed` status has the `last_lines` (50) of the log. |
| `server.log` | `name`, `stream`, `text` | `text` can hold several lines. The daemon sends the new lines about 10 times a second. |
| `server.logs` | `name`, `lines` | Reply to `server.logs`. Each line has `stream` and `text`. |
| `permissions` | `path`, `allow`, `deny` | Reply to `permissions.get` and `permissions.set`. `path` is the settings file, relative to the project. |
| `settings` | `auto_verify`, `permission_mode` | Reply to `settings.get` and `settings.set`. |
| `mcp` | `items`, `problems`, `paths` | The MCP servers of the session. The daemon sends it when a server state or a tool list changes, and as the reply to `mcp.list`. Each item has `name`, `scope` (`plugin`, `user`, or `project`), `transport`, `target` (the command or the URL), `state` (`starting`, `connected`, `failed`, `disabled`, or `stopped`), `error`, `server_name`, `tools` (`name`, `agent_name`, `description`), and `log` (the last output lines of a failed server). `problems` holds the configuration errors and warnings. |
| `mcp.init` | `path`, `created` | Reply to `mcp.init`. `path` is relative to the project. |
| `plugins` | `loaded`, `bundles`, `orphans`, `warnings`, `paths`, `counts`, `installed` (optional), `removed` (optional) | Reply to the `plugins.*` messages. `loaded` is true when the plugins of a session are loaded. Each bundle has `name`, `version`, `description`, `icon` (a data URL), `dir`, `enabled`, `source`, `problem`, and `rows`. Each row has `id`, `name`, `bundle`, `state` (`active`, `disabled`, `failed`, `pending`, or `idle` with no session), `error`, `disabled`, `config`, `layer`, `overrides`, `inject`, `provide`, `tools`, and `commands`. `orphans` holds the rows of bundles that are not installed. `deepseek` holds the DeepSeek plugins: `available`, `reason` (when not available), `running`, `runtime`, `node`, `home`, `user_patch`, `bundles` (`name`, `version`, `description`, `dir`, `enabled`, `problem`, `client`, `icon`, `rows`), `orphans`, and `warnings`. A DeepSeek row has `id`, `name`, `disabled`, `state` (`active`, `disabled`, `pending`, `failed`, or `disposed`), and `error`. `installed_kind` is `harness` or `deepseek`. |
| `cookbook.hosts` | `items`, `public_key`, `key_path` | Reply to the `cookbook.host*` and `cookbook.ssh_key` messages. Each item has `name`, `ssh`, `remote`, `python`, `llama_server`, and `label`. `public_key` is null if there is no key. |
| `hardware` | `host`, `info` | `info` has `hostname`, `platform`, `gpus` (`name`, `vendor`, `vram_total`, `vram_used`), `ram_total`, `cpu_cores`, `python`, `huggingface_hub`, `llama_server`, `tmux`, and `hf_cache`. Sizes are in bytes. |
| `hf.token` | `set` | Reply to `hf.token`. |
| `hf.results` | `items`, `page`, `has_more`, `query`, `hardware` | Search results. Each item has `repo_id`, `author`, `name`, `params`, `license`, `downloads`, `likes`, `last_modified`, `gated`, `library`, `architecture`, `context_length`, and `fit` (`fits`, `offload`, `no`, or null: an estimate). |
| `hf.detail` | `repo_id`, `url`, `item`, `card`, `gated`, `access`, `shape`, `shape_error`, `files`, `recommended`, `host`, `hardware` | Model details. Each file group has `name`, `label`, `files`, `size`, `quant`, `format`, `parts`, and `fit` (`result`, `context`, `weights`, `kv_cache`, `total`, `estimate`, `max_context_vram`, `gpu_layers`). `recommended` is the largest group that fits in VRAM with a 16K context. |
| `downloads` | `items` | Reply to `downloads.list`: `download.progress` items. |
| `download.progress` | `id`, `host`, `repo_id`, `files`, `state`, `bytes_done`, `bytes_total`, `file`, `error`, `started` | Sent to all connections. `state` is `queued`, `running`, `paused`, `done`, `error`, or `cancelled`. |
| `installed` | `host`, `repos`, `cache`, `ollama`, `lmstudio` | Each repo has `repo_id`, `files` (`name`, `size`, `path`), and `size`. `ollama` has `url`, `running`, `installed`, and `models` (`name`, `size`, `modified`, `parameters`, `quantization`). `lmstudio` has `folder` (null if there is none) and `models` (`id`, `path`, `files`, `size`). |
| `serves` | `host`, `items` | Each item has `name`, `port`, `model_path`, `alias`, `context`, `gpu_layers`, `state` (`starting`, `running`, or `crashed`), and `provider`. |
| `serve.status` | `host`, `name`, `state`, `port`, `provider`, `model`, `error` | Sent to all connections. With `state: "running"`, `model` is `<provider>/<alias>` for `/model`. |
| `serve.output` | `host`, `name`, `text` | Reply to `serve.output`. |
| `providers` | `items`, `path`, `exists` | Reply to the `providers.*` messages, except `providers.test`. Each item has `name`, `base_url`, `kind`, `kind_resolved`, `enabled`, `context_length`, `ssh`, `models`, and `key`. `key` has `source` (`client`, `env`, `file`, or `none`), `set` (the daemon has the key now), and `env`. The daemon never sends a key. If `exists` is false, the file does not exist and the list has the default provider. |
| `providers.test` | `ref`, `name`, `ok`, `ms`, `models`, `truncated`, `contexts`, `error` | Reply to `providers.test`. `ref` is the value from the request. `ms` is the time of `GET /models`. `contexts` maps a model to `{length, source, warning?}`. A model with no known context length is not in it. |
| `models` | `items`, `errors` | Reply to `models.list`. Each item has `provider` and `model`. Each error has `provider` and `message`. |
| `preview.frame` | `url`, `title`, `action`, `image` | A small screenshot of the agent browser page after a `preview_navigate`, `preview_click`, or `preview_fill` call. `action` is, for example, `navigate` or `click e5`. `image` is a JPEG data URL. |



### Changed fields



| `type` | Field | Function |

|---|---|---|

| `permission.request` | `rule` | The rule that `allow_always` adds, for example `edit(src/app.py)` or `bash(npm test)`. |

| `tool.result` | `diff` | A unified diff of the file change, for a tool that changed a file. The field is not present for other tools. |

| `turn.end` | `stop_reason` | `end`, `max_tool_calls`, `denied`, `interrupted`, or `error`. |

| `turn.end` | `usage` | `prompt_tokens` and `completion_tokens` are sums for the turn. `last_prompt_tokens` is the prompt size of the last model call. `context_tokens` is the size of the next request (an estimate), and `context_length` is the limit. |
| `command.result` | `context_length`, `context_source` | After `/model`, the context length of the new model and its source. |
| `command.result` | `action: "preview"`, `server`, `url` | After `/preview`: the daemon starts the default server. The client opens it in the Browser pane when its state is `running`. |
| `session.ready` | `files_token` | Project files for the Browser pane: `GET /files/<files_token>/<path>`. The token ends with the session. |
| `session.ready` | `project` | The saved project of the session folder: `id` and `name`, or null. |
| `session.ready` | `auto_verify`, `image_input` | `auto_verify`: the agent checks the app after each UI change. `image_input`: the model accepts images, so the agent has `preview_screenshot`. |
| `session.ready` | `running`, `partial`, `requests` | `running` is true if the session has a running turn. Then `history` includes the turn so far, `partial` is the reply text that streams now (or null), and `requests` holds the open `permission.request` messages. |
| The events of a session | `session_id` | The daemon adds the session id to each event of a session: the turn events, and the events of its servers, MCP servers, and agent browser. |
| `command.result` | `image_input` | After `/model`: the new model accepts images. |
| `tool.result` | `image` | A data URL of an image for the model, for example the screenshot of `preview_screenshot`. A stored `tool` message in `history` also has `image`. |
| `permission.request` | `input` | For `preview_start`, `input` is `name`, `command`, and `cwd` of the server, and `rule` is `server(<command>)`: the same request as a start from the Servers pane. |
| `command.result` | `items` | After `/skills`: all skills, with `action: "open_panel"` and `panel: "skills"`. |
| `skills` | `items` | Each item also has `builtin`, `path`, `user-invocable`, `model-invocable`, and `context`. `source` is `built-in`, or the scope and the folder of the skill, for example `project (.harness)`. The built-in commands come first. |
| `tool.start`, `tool.result`, `fs.changed` | `agent` | The skill name, when a skill with `context: fork` runs the tool in a subagent. |

| `error` | `ref` | The `type` of the client message that caused the error, if known. |
| `error` | `data` | Details for the client, if any. A DeepSeek install that needs build scripts has `data.pending_builds` (the keys that pnpm printed) and `data.source`. |

| `fs.tree` | `path`, `items` | `fs.list` returns one folder level. Each item has `name`, `path`, and `type` (`file` or `dir`). The list does not include files that `.gitignore` excludes. |

| `fs.write` | `base_hash` | Use `null` for a new file. |



## Other endpoints

| Endpoint | Function |
|---|---|
| `GET /files/<files_token>/<path>` | A project file for the Browser pane (read only). A folder serves its `index.html`. HTML and SVG get `Content-Security-Policy: sandbox`, so a page cannot read other daemon URLs. |
| `WS /forward` | Port forwarding for a remote daemon. Messages: `{"type": "auth", "token"}`, then `{"type": "forward", "session_id", "server"}`. The daemon replies `{"type": "forward.ok"}`, and then binary messages carry the TCP bytes. Only the ports of servers in `launch.json` can be reached. |

## Event order in a turn



1. `token` messages, zero or more.

2. For each tool call: `tool.start`, then `permission.request` if necessary, then `tool.result`.

3. `fs.changed` after each tool call that changed a file.

4. Steps 1 to 3 repeat until the model gives no tool calls.

5. `turn.end`, one time.



`error` can come before `turn.end` if the model endpoint fails.



## Rules



- The daemon runs one turn at a time for each session. A `prompt` during a turn gets an `error`.
- The client can go to another session (`session.new`, `session.resume`) or to the start screen (`session.leave`) during a turn. The turn continues in the background, and the client gets no events of it. A later `session.resume` of that session shows the turn again. When a turn in the background ends, the session closes: its servers, MCP servers, and agent browser stop. A session with a running shell stays open until the shell stops. When the connection closes, all turns and shells stop.
- The terminal pane runs an interactive shell: PowerShell on Windows (ConPTY), or `$SHELL` on other systems. The `terminal_shell` setting selects another shell. Each session has one shell.
- A tool that fails with an unexpected error gives an error result to the model. The turn continues. A `glob` or `grep` search stops after 30 seconds with an error result.
- A `command` with a skill name starts the skill as a turn. Built-in commands have priority over skills with the same name. A skill with `user-invocable: false` gets an `error`.
- The daemon watches each file that the client read with `fs.read`, until `fs.unwatch`. If the file changes and the change is not from the agent tools or from `fs.write`, the daemon sends `fs.changed`. `by` is `agent` during a turn (probably a `bash` command), and `external` at other times.
- A prompt can have references: lines (`@src/app.py:10-25`), a file (`@src/app.py`), a folder (`@src/`), or a session (`@session:<id>`). The daemon adds the referenced text to the prompt for the model, and it stores the original prompt as `display`. A `prompt` can have `display`: the text that the user sees, for example with the name of a session in place of its id.
- A stored user message can have `display`: the text that the user typed, for example `/review src`. `content` holds the skill text for the model.
- `/compact` runs like a turn: `interrupt` stops it, and it ends with `turn.end`. If there is too little history, a `command.result` comes before `turn.end`.

- After `auth.ok`, the client sends `providers.list`. For each provider with `key.source: "client"` and `key.set: false`, the client reads the key from its keychain and sends it with `providers.keys`. A change to the key or the settings of the session provider applies to the next model call.
- An unexpected error in a turn sends `error`, then `turn.end` with `stop_reason: "error"`.
- `interrupt` stops the turn. A running `bash` command stops with all its child processes.

- A hash is the SHA-256 of the file bytes, in lowercase hex.

- All paths are relative to the session `cwd`, with `/` as the separator.

