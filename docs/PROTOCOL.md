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

| `session.list` | `cwd` (optional) | Asks for the stored sessions, newest first. With `cwd`, only the sessions of that folder (case-insensitive on Windows). |
| `projects.list` | — | Asks for the saved projects, the last used first. This needs no session. |
| `projects.save` | `path`, `name` (optional), `id` (optional), `create` (optional) | Adds a project, or changes the project `id`. `path` must be absolute. With `create`, the daemon makes a missing folder. Two projects cannot use the same folder. |
| `projects.delete` | `id` | Removes a project from the list. The folder, its files, and its sessions stay. |

| `fs.dirs` | `path` (optional), `hidden` (optional) | Asks for the folders in a folder of the daemon host. The default is the home folder. This needs no session: the client uses it to select a project folder on a remote daemon. |
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
| `settings.get` | — | Asks for the project settings that the client can change. |
| `settings.set` | `auto_verify` | Changes project settings in `.harness/settings.json`. The other keys of the file stay the same. The next model call uses the new value. |



### Daemon to client



| `type` | Fields | Function |

|---|---|---|

| `auth.ok` | `version`, `host` | The token is correct. `host` has `hostname`, `platform`, `user`, `home`, and `sep` of the daemon computer. |
| `fs.dirs` | `path`, `parent`, `items`, `roots`, `is_project` | Reply to `fs.dirs`. `items` are folders only (`name`, `path`). `roots` are the drives on Windows, or `/`. `is_project` is true if the folder has `.git`, `HARNESS.md`, `CLAUDE.md`, `package.json`, or `pyproject.toml`. |

| `session.ready` | `session_id`, `cwd`, `model`, `title`, `warnings`, `history`, `summary`, `context_length`, `context_tokens`, `instructions` | Reply to `session.new` and `session.resume`. `summary` replaces the messages before `history` (null if there is no summary). `instructions` is `HARNESS.md`, `CLAUDE.md`, or null. `history` holds the messages of the current context, in OpenAI chat format. A `tool` message also has `is_error`, and `diff` for a file change. The daemon does not send these fields to the model. |

| `projects` | `items`, `saved` | Reply to the `projects.*` messages. Each item has `id`, `name`, `path`, `exists`, `sessions` (the number of stored sessions in the folder), `created_at`, and `last_used`. `saved` is the id after `projects.save`. `session.new` adds its folder as a project if it is not one. The first daemon start with projects adds the folders of the stored sessions. |
| `sessions` | `items`, `cwd` | Reply to `session.list`. `cwd` is the value from the request, or null. Each item has `id`, `cwd`, `provider`, `model`, `title`, `created_at`, and `updated_at`. |

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
| `settings` | `auto_verify` | Reply to `settings.get` and `settings.set`. |
| `providers` | `items`, `path`, `exists` | Reply to the `providers.*` messages, except `providers.test`. Each item has `name`, `base_url`, `kind`, `kind_resolved`, `enabled`, `context_length`, `ssh`, `models`, and `key`. `key` has `source` (`client`, `env`, `file`, or `none`), `set` (the daemon has the key now), and `env`. The daemon never sends a key. If `exists` is false, the file does not exist and the list has the default provider. |
| `providers.test` | `ref`, `name`, `ok`, `ms`, `models`, `truncated`, `error` | Reply to `providers.test`. `ref` is the value from the request. |
| `models` | `items`, `errors` | Reply to `models.list`. Each item has `provider` and `model`. Each error has `provider` and `message`. |
| `preview.frame` | `url`, `title`, `action`, `image` | A small screenshot of the agent browser page after a `preview_navigate`, `preview_click`, or `preview_fill` call. `action` is, for example, `navigate` or `click e5`. `image` is a JPEG data URL. |



### Changed fields



| `type` | Field | Function |

|---|---|---|

| `permission.request` | `rule` | The rule that `allow_always` adds, for example `edit(src/app.py)` or `bash(npm test)`. |

| `tool.result` | `diff` | A unified diff of the file change, for a tool that changed a file. The field is not present for other tools. |

| `turn.end` | `stop_reason` | `end`, `max_tool_calls`, `denied`, `interrupted`, or `error`. |

| `turn.end` | `usage` | `prompt_tokens` and `completion_tokens` are sums for the turn. `last_prompt_tokens` is the prompt size of the last model call. `context_tokens` is the size of the next request (an estimate), and `context_length` is the limit. |
| `command.result` | `context_length` | After `/model`, the context length of the new model. |
| `command.result` | `action: "preview"`, `server`, `url` | After `/preview`: the daemon starts the default server. The client opens it in the Browser pane when its state is `running`. |
| `session.ready` | `files_token` | Project files for the Browser pane: `GET /files/<files_token>/<path>`. The token ends with the session. |
| `session.ready` | `project` | The saved project of the session folder: `id` and `name`, or null. |
| `session.ready` | `auto_verify`, `image_input` | `auto_verify`: the agent checks the app after each UI change. `image_input`: the model accepts images, so the agent has `preview_screenshot`. |
| `command.result` | `image_input` | After `/model`: the new model accepts images. |
| `tool.result` | `image` | A data URL of an image for the model, for example the screenshot of `preview_screenshot`. A stored `tool` message in `history` also has `image`. |
| `permission.request` | `input` | For `preview_start`, `input` is `name`, `command`, and `cwd` of the server, and `rule` is `server(<command>)`: the same request as a start from the Servers pane. |
| `command.result` | `items` | After `/skills`: all skills, with `action: "open_panel"` and `panel: "skills"`. |
| `skills` | `items` | Each item also has `builtin`, `path`, `user-invocable`, `model-invocable`, and `context`. `source` is `built-in`, or the scope and the folder of the skill, for example `project (.harness)`. The built-in commands come first. |
| `tool.start`, `tool.result`, `fs.changed` | `agent` | The skill name, when a skill with `context: fork` runs the tool in a subagent. |

| `error` | `ref` | The `type` of the client message that caused the error, if known. |

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



- The daemon runs one turn at a time for each connection. A `prompt` during a turn gets an `error`.
- A `command` with a skill name starts the skill as a turn. Built-in commands have priority over skills with the same name. A skill with `user-invocable: false` gets an `error`.
- The daemon watches each file that the client read with `fs.read`, until `fs.unwatch`. If the file changes and the change is not from the agent tools or from `fs.write`, the daemon sends `fs.changed`. `by` is `agent` during a turn (probably a `bash` command), and `external` at other times.
- A prompt can have line references such as `@src/app.py:10-25` or `@src/app.py:10`. The daemon adds the text of those lines to the prompt for the model, and it stores the original prompt as `display`.
- A stored user message can have `display`: the text that the user typed, for example `/review src`. `content` holds the skill text for the model.
- `/compact` runs like a turn: `interrupt` stops it, and it ends with `turn.end`. If there is too little history, a `command.result` comes before `turn.end`.

- After `auth.ok`, the client sends `providers.list`. For each provider with `key.source: "client"` and `key.set: false`, the client reads the key from its keychain and sends it with `providers.keys`. A change to the key or the settings of the session provider applies to the next model call.
- `interrupt` stops the turn. A running `bash` command stops with all its child processes.

- A hash is the SHA-256 of the file bytes, in lowercase hex.

- All paths are relative to the session `cwd`, with `/` as the separator.

