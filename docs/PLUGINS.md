# Plugins

A plugin adds features to Harness with Python code. The plugin model is a port of the model of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ("Everything is a Plugin"). DeepSeek Harness uses the Cordis framework in TypeScript. Harness uses the same ideas in Python:

1. A **bundle** is a folder with a `plugin.json` manifest. It holds one or more plugin modules.
2. A **plugin** is a Python module with an `apply(ctx, config)` function.
3. The plugin registers its features in code, with the services of `ctx`. The manifest has no list of features.
4. Each registration returns a **disposer**. When Harness unloads the plugin, it calls the disposers. The plugin needs no cleanup code.
5. **Rows** in YAML patch files turn each plugin on or off and give its config. The patch files are in layers. A later layer wins.
6. The `inject` list of a plugin gives the services that it needs. A plugin starts when all of these services exist. The row order does not set the load order.

The example bundle is in [examples/plugins/hello](../examples/plugins/hello).

## Write a plugin

The smallest bundle has two files.

`plugin.json`:

```json
{ "name": "hello", "version": "0.1.0" }
```

`plugin.py`:

```python
def apply(ctx, config):
    @ctx.tools.tool("greet", description="Greet a person by name.",
                    parameters={"name": {"type": "string", "required": True}})
    def greet(args, tool_ctx):
        return f"Hello, {args['name']}!"
```

Install the folder in the Plugins screen, or copy it into `~/.harness/plugins/`. Then start a session. The agent can now call the `greet` tool.

## The manifest: `plugin.json`

| Field | Necessary | Description |
|---|---|---|
| `name` | Yes | 1 to 64 characters: `a-z`, `0-9`, `-`, and `_`. It is the bundle name. |
| `version` | Yes | The version text, for example `"0.1.0"`. |
| `description` | No | The text for the Plugins screen. |
| `icon` | No | An SVG, PNG, JPEG, or WebP file in the bundle, 256 KiB or less. |
| `main` | No | The main module file. The default is `plugin.py`. |
| `engines.harness` | No | The Harness versions that the bundle supports, for example `">=0.1.4 <0.3"`. The operators are `>=`, `>`, `<=`, `<`, `=`, `^`, and `~`. Install stops if the version does not match. |
| `harness.patch` | No | A patch file, or a list of patch files, in the bundle. With no patch, the bundle adds one row: `{id: <name>, name: <name>}`. |

Harness reads the manifest without running plugin code.

## The plugin module

A plugin module can declare these names:

| Name | Description |
|---|---|
| `apply(ctx, config)` | Necessary. It can be `async`. It registers the features of the plugin. |
| `inject` | The services that `apply` needs, for example `["tools", "greeter"]`. |
| `provide` | The services that the plugin gives to other plugins. `apply` must call `ctx.provide(name, value)` for each one. |
| `Config` | A dict of default config values. The row config replaces these values. Harness checks that each value has the type of its default. |

A bundle can hold more modules. The row name `<bundle>/<module>` loads `<module>.py` from the bundle folder. The bundle folder is a Python package, so a module can use relative imports, for example `from . import util`.

## The services of `ctx`

| Service | Call | Result |
|---|---|---|
| `ctx.tools` | `register(tool)`, or `register(name=, description=, parameters=, run=, needs_approval=)`, or the `@tool()` decorator | A tool for the agent. `run(args, tool_ctx)` returns a string, a JSON value, or a `ToolResult`. With `needs_approval=True`, the user approves each call. |
| `ctx.commands` | `register(name, description, handler, argument_hint="")`, or the `@command()` decorator | A `/` command. `handler(invocation)` returns text to show, `Prompt(text)` to send the text to the agent, or `None`. |
| `ctx.skills` | `add_root(folder)` | A folder of skills in the SKILL.md format. A relative folder is in the bundle. |
| `ctx.prompt` | `section(text)` | Text for the system prompt. A function gives the text each time Harness builds the prompt. |
| `ctx.hooks` | `on(event, handler)`, or `ctx.on(event, handler)` | An event handler. See the events below. |
| `ctx.mcp` | `add_server(name, config)` | An MCP server, in the format of `mcp.json`. |
| `ctx.providers` | `register(name, entry)` | A model provider, in the format of `providers.json`. |

Other values of `ctx`:

- `ctx.id`: the row id.
- `ctx.bundle` and `ctx.dir`: the bundle name and folder.
- `ctx.cwd`: the project folder of the session.
- `ctx.data_dir`: a folder for the files of the plugin, `~/.harness/plugin-data/<bundle>`.
- `ctx.log`: a logger. The daemon log shows its messages.
- `ctx.effect(dispose)`: keeps a disposer for another resource, for example a thread.
- `ctx.provide(name, value)`: gives a service to other plugins.

Short parameter form: `{"name": {"type": "string", "required": True}}` becomes a JSON schema with `required: ["name"]`. A full JSON schema with `"type": "object"` stays the same.

Priority rules:

- A built-in tool, an MCP tool, or a preview tool wins over a plugin tool with the same name.
- A built-in command wins over a plugin command. A plugin command wins over a skill.
- A user skill or a project skill wins over a plugin skill.
- A server in `mcp.json` wins over a plugin MCP server.
- An entry in `providers.json` wins over a plugin provider.

Import other values from `harness_daemon.plugins`, for example `Prompt`, `ToolError`, and `ToolResult`.

## Hooks

| Event | The handler gets | The handler can |
|---|---|---|
| `tool.before` | `ToolCall` with `name`, `args`, and `cwd` | Change `args`. Call `block(reason)` to stop the call. The agent gets the reason as an error. |
| `tool.after` | `ToolCall` with `result` | Read or replace `result`. |
| `turn.start` | `TurnEvent` with `text` and `cwd` | Change `text` before the agent gets it. |
| `turn.end` | `TurnEvent` with `stop` | Read the stop reason. |

Handlers can be `async`. They run in the order of registration. An error in a handler goes to the daemon log. It does not stop the turn.

## Rows and patch layers

A patch file is a YAML list of patches:

```yaml
- insert:                    # Adds rows.
    - id: hello              # The row id. It is unique.
      name: hello            # The module: <bundle> or <bundle>/<module>.
      config: { greeting: Hi }
      disabled: false
- id: hello                  # Changes the keys of an existing row.
  config: { greeting: Hey }  # "config" replaces the full value. It does not merge.
```

Harness applies the layers in this order. A later layer wins for each row:

1. The patch files of each bundle that is on, in the bundle order.
2. The user layer: `~/.harness/plugins.patch.yml`.
3. The project layer: `<project>/.harness/plugins.patch.yml`.

A row can name only the modules of installed bundles. Thus a project file cannot run code that is in the project.

When you turn a row on or off in the Plugins screen, Harness writes `disabled` to the project layer if that layer already sets `disabled` for the row. Otherwise, it writes to the user layer. Harness writes the file again, so comments in that file are removed.

## Install, turn off, and remove

- The Plugins screen (the sidebar, or `/plugins`) installs a bundle from a folder or a git URL. The git forms are `https://…`, `git@…`, `ssh://…`, and `github:user/repo#ref`.
- Install copies the folder, or clones the repository, into `~/.harness/plugins/<name>/`. It does not run plugin code.
- You can also copy a bundle folder into `~/.harness/plugins/` by hand. A new folder is on.
- `~/.harness/plugins.json` keeps the bundle order, the on or off state of each bundle, and the install source.
- The update button installs the bundle again from its source.
- Remove deletes the bundle folder, its state, and the user-layer overrides of its rows.
- After a change, the plugins of the open session load again. A changed plugin file has an effect when you select "Load the plugins again", or in the next session.

## DeepSeek Harness plugins

Harness also runs plugins made for DeepSeek Harness, without changes. These plugins are npm bundles: a `package.json` with `dsh.bundle.patch`, and JavaScript modules for the Cordis framework. The plan and its phases are in [plugin-host/spike/REPORT.md](../plugin-host/spike/REPORT.md).

### How it works

- A Node process, the **plugin host** ([plugin-host/](../plugin-host)), loads the bundles. It uses the Node of the Playwright driver, so users do not install Node.
- The host loads the real DeepSeek service packages: `tools`, `commands`, `systemPrompt`, `skills`, and `llm`. Thus a plugin gets the same API and behavior as in DeepSeek Harness 0.2.0-rc.2.
- The daemon talks to the host with JSON-RPC on stdin and stdout. One host serves all sessions. Each session is one agent in the host.
- In a session, the tools, `/` commands, skills, and prompt sections of the DeepSeek plugins are next to the Harness plugins. The daemon reads them again before each turn.
- The host starts when a session opens and a DeepSeek bundle is installed. Its log is `~/.harness/logs/plugin-host.log`.

### Install

1. Open the Plugins screen, and select **DeepSeek**.
2. Type an npm name (for example `dsh-plugin-guide`), a git address, a URL of a `.tgz` file, or a local folder.
3. Select **Install**.

The host installs the bundle with pnpm 11 into `~/.harness/dsh/`, with the DeepSeek profile settings. If the npm registry cannot be reached, it tries `https://registry.npmmirror.com/`.

- **Version gate:** a bundle that declares `@deepseek-ai/dsh*` peers for another DeepSeek Harness version does not install, the same as in DeepSeek Harness.
- **Build scripts:** pnpm does not run the build scripts of a package. If a package needs them, the Plugins screen lists them. Select **Allow the scripts and install** to run them. The approval is in `~/.harness/dsh/pnpm-workspace.yaml`.
- **Turn off:** the bundle switch changes the bundle list in `~/.harness/dsh/package.json`. The row switch writes `disabled` into `~/.harness/dsh/cordis.patch.yml`.

### Rules

- A DeepSeek tool needs your approval for each call, as an MCP tool does. The rule is the tool name, for example `greet`.
- A Harness tool wins over a DeepSeek tool with the same name. A Harness plugin command wins over a DeepSeek command.
- A skill in a folder wins over a DeepSeek skill with the same name.

### Limits of this version (phase 1)

- The host has the core services only. A plugin that needs another service (for example `webServer`, `fs`, or `agents`) waits, and the Plugins screen names the missing services. Later phases add more services.
- The agent events (`agent/pre-step`, `agent/turn-stopping`, and others) and the tool events for Harness tools do not reach DeepSeek plugins yet. The tool events for DeepSeek tools work.
- LLM adapters of DeepSeek plugins do not show as providers yet.
- The UI half of a bundle does not load.
- A remote daemon that runs from source needs `npm install` in `plugin-host/`.

## Security

Plugin code runs in the daemon process or in the plugin host process. It has the same rights as the daemon. It is not in a sandbox. Install only plugins that you trust.

## Limits

- The sidecar is a frozen PyInstaller build. A plugin cannot install packages with pip. A plugin can use its own files, the Python standard library modules in the sidecar, and the packages of the daemon, for example `httpx` and `yaml`. With a daemon from source, all installed packages are available.
- These features of DeepSeek Harness are not in this version: plugin UI panels in the client, groups of rows, `!!js` expressions in patch files, profiles, and an agent tool that manages plugins.
