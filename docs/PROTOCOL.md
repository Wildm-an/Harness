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

| `session.list` | `cwd` (optional) | Asks for the stored sessions, newest first. |

| `fs.dirs` | `path` (optional), `hidden` (optional) | Asks for the folders in a folder of the daemon host. The default is the home folder. This needs no session: the client uses it to select a project folder on a remote daemon. |
| `skills.get` | `name` | Asks for one skill: the SKILL.md text and the files in its folder. |
| `permissions.get` | — | Asks for the permission rules of the session project. |

| `permissions.set` | `allow`, `deny` | Replaces the permission rules. The daemon rejects a rule that is not `tool` or `tool(pattern)`. |



### Daemon to client



| `type` | Fields | Function |

|---|---|---|

| `auth.ok` | `version`, `host` | The token is correct. `host` has `hostname`, `platform`, `user`, `home`, and `sep` of the daemon computer. |
| `fs.dirs` | `path`, `parent`, `items`, `roots`, `is_project` | Reply to `fs.dirs`. `items` are folders only (`name`, `path`). `roots` are the drives on Windows, or `/`. `is_project` is true if the folder has `.git`, `HARNESS.md`, `CLAUDE.md`, `package.json`, or `pyproject.toml`. |

| `session.ready` | `session_id`, `cwd`, `model`, `title`, `warnings`, `history`, `summary`, `context_length`, `context_tokens`, `instructions` | Reply to `session.new` and `session.resume`. `summary` replaces the messages before `history` (null if there is no summary). `instructions` is `HARNESS.md`, `CLAUDE.md`, or null. `history` holds the messages of the current context, in OpenAI chat format. A `tool` message also has `is_error`, and `diff` for a file change. The daemon does not send these fields to the model. |

| `sessions` | `items` | Reply to `session.list`. Each item has `id`, `cwd`, `provider`, `model`, `title`, `created_at`, and `updated_at`. |

| `command.result` | `name`, and `text`, `items`, `model`, `warnings`, `action`, or `panel` | Reply to a built-in command. `action: "open_panel"` tells the client to open `panel`. |

| `fs.saved` | `path`, `hash` | Reply to a `fs.write` that succeeded. |

| `servers` | `items` | Reply to `server.list`. |

| `context.compacted` | `reason`, `removed_messages`, `trimmed_outputs`, `summary`, `context_tokens`, `context_length` | The daemon summarized old turns (`reason` is `auto` or `manual`), or removed old tool outputs. |
| `skill` | the `skills` item fields, `allowed-tools`, `content`, `files` | Reply to `skills.get`. `content` is the full SKILL.md text. `files` are relative to the skill folder. |
| `permissions` | `path`, `allow`, `deny` | Reply to `permissions.get` and `permissions.set`. `path` is the settings file, relative to the project. |



### Changed fields



| `type` | Field | Function |

|---|---|---|

| `permission.request` | `rule` | The rule that `allow_always` adds, for example `edit(src/app.py)` or `bash(npm test)`. |

| `tool.result` | `diff` | A unified diff of the file change, for a tool that changed a file. The field is not present for other tools. |

| `turn.end` | `stop_reason` | `end`, `max_tool_calls`, `denied`, `interrupted`, or `error`. |

| `turn.end` | `usage` | `prompt_tokens` and `completion_tokens` are sums for the turn. `last_prompt_tokens` is the prompt size of the last model call. `context_tokens` is the size of the next request (an estimate), and `context_length` is the limit. |
| `command.result` | `context_length` | After `/model`, the context length of the new model. |
| `command.result` | `items` | After `/skills`: all skills, with `action: "open_panel"` and `panel: "skills"`. |
| `skills` | `items` | Each item also has `builtin`, `path`, `user-invocable`, `model-invocable`, and `context`. `source` is `built-in`, or the scope and the folder of the skill, for example `project (.harness)`. The built-in commands come first. |
| `tool.start`, `tool.result`, `fs.changed` | `agent` | The skill name, when a skill with `context: fork` runs the tool in a subagent. |

| `error` | `ref` | The `type` of the client message that caused the error, if known. |

| `fs.tree` | `path`, `items` | `fs.list` returns one folder level. Each item has `name`, `path`, and `type` (`file` or `dir`). The list does not include files that `.gitignore` excludes. |

| `fs.write` | `base_hash` | Use `null` for a new file. |



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
- A stored user message can have `display`: the text that the user typed, for example `/review src`. `content` holds the skill text for the model.
- `/compact` runs like a turn: `interrupt` stops it, and it ends with `turn.end`. If there is too little history, a `command.result` comes before `turn.end`.

- `interrupt` stops the turn. A running `bash` command stops with all its child processes.

- A hash is the SHA-256 of the file bytes, in lowercase hex.

- All paths are relative to the session `cwd`, with `/` as the separator.

