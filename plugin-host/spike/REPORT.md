# Phase 0 report: DeepSeek plugin bridge spike

Date: 2026-09-29. DeepSeek Harness packages: 0.2.0-rc.2 (npm tag `next`). Plan: [DeepSeek Plugin Bridge](https://claude.ai/artifact/5vXBZtQDrgqqUHkQEBsrmU).

## Result

**Go.** The real DeepSeek service packages start alone in the Node of the sidecar, and a fixture plugin in the DeepSeek format works through them. The bridge design is possible.

The survey changes 2 parts of the plan:

1. The bridge does not need Node internals or the native addon. The public `module.registerHooks` API does the module resolution.
2. The current shim list is too small for the target. With the current plan, 14 of the 28 surveyed plugins load. With 8 more shims, 19 load.

## How to run the tests

Use the Node of the Playwright driver in the daemon environment:

```bash
cd plugin-host/spike
npm install --ignore-scripts
"../../daemon/.venv/Lib/site-packages/playwright/driver/node.exe" boot.mjs
"../../daemon/.venv/Lib/site-packages/playwright/driver/node.exe" services.mjs
"../../daemon/.venv/Lib/site-packages/playwright/driver/node.exe" resolution.mjs <profile folder> hook-profile
```

`resolution.mjs` needs a profile folder with the `fixtures/community-dsh` bundle. Install it with pnpm 11 and a `file:` spec. See test 3.

## Test 1: the core services start alone (`boot.mjs`)

| Item | Result |
|---|---|
| Node | v24.21.0 (the Playwright driver in the sidecar) |
| Services | `systemPrompt`, `tools`, `commands`, `skills`, `llm`: all 5 start |
| Start time | 97 to 132 ms |
| Memory | 44 MB resident set, 9 MB heap |
| Packages | 29 packages, 13 MB, from 10 direct dependencies |

The peer lists of the packages are long, but most of those imports are types only. The runtime imports are small.

## Test 2: the service calls of the bridge (`services.mjs`)

The fixture `fixtures/hello-dsh` uses the DeepSeek plugin format: `inject`, a Schemastery `Config`, and `apply(ctx, config)`. A shim agent stands for one Harness session. All 13 checks pass:

| Check | Result |
|---|---|
| Plugin load | Active |
| `tools.schemas(agent)` | JSON schemas with `required` |
| `tools.execute` | Runs the full pipeline. `tools/post-execute` changes the content. |
| `tools/pre-execute` "deny" | An error result with the reason |
| `commands.list`, `commands.execute` | The command runs. The shim session gets `command/run` and `command/done`. |
| `systemPrompt.assemble` | The plugin section and the tool list |
| `skills.list`, `skills.get` | The registered skill and its content |
| `llm.listProviders`, `llm.stream` | A fixture adapter streams text, a tool call, usage, and finish |
| `agent/turn-stopping` (scoped) | The listener calls `agent.steer()` |
| Unload | All tools and commands of the plugin are removed |

The shim agent needs only `id`, `session.append(type, data)`, `steer()`, and a scope from `createScope(ctx, agent)`.

## Test 3: module resolution (`resolution.mjs`)

DeepSeek installs a plugin in a profile folder with `autoInstallPeers: false`. The plugin gets the host copy of each `@deepseek-ai/*` peer. DeepSeek does this with Node internals and a native addon.

| Case | Result |
|---|---|
| No hook | Fails: the profile cannot resolve the peers |
| `--expose-internals` and a resolve hook for `@deepseek-ai/*` | Works |
| No internals, and a resolve hook for `@deepseek-ai/*` and the profile | Works. The tool returns `HI!`. |

The resolve hook tries the normal resolution first. Thus a package that the plugin installs itself still wins, as in DeepSeek.

**Change to the plan (D3):** use `module.registerHooks` (Node 22.15 and later). Do not use `--expose-internals` or `node-addon-require-builtin`. This removes the dependency on Node internals, which change between Node versions.

## pnpm (decision D4)

- DeepSeek uses pnpm 11 behavior: blocked lifecycle scripts and `allowBuilds`.
- pnpm 12 is a native binary. pnpm 11.28.2 is JavaScript and runs in the sidecar Node. Its package is 5.4 MB.
- A local folder must install with a `file:` spec. A plain path makes a link, and the plugin then resolves from its source folder.

## Open questions from the plan

| Question | Answer (from the official packages) |
|---|---|
| What does `agent/pre-step` "reject" do? | The turn ends with the state `blocked`. No model call happens. (`dsh-agent-loop`, `turn()`) |
| `approval/request` payload | A waterfall. `{ agent, toolName, callId?, reason?, displayReason?, signal? }`. Result: `'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`. |
| `user-questions/request` payload | A waterfall. `{ questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }], agent?, signal?, wait? }`. Result: `{ answers: [{ id, selected[], custom? }] }`. |

## Compatibility survey

The survey used the 30 most-downloaded packages with the npm keyword `dsh-plugin` (downloads in the last month). It read the package files and ran no plugin code. 2 packages are not plugins (a launcher script and a data file), so the survey has 28 plugins.

Rules:

- **Gate:** the plugin fails the DeepSeek peer gate for 0.2.0-rc.2. DeepSeek Harness itself skips it.
- **Blocked:** the `inject` list has a service with no shim. The plugin does not start.
- **Partial:** the plugin starts, but some features do nothing: listeners for events that Harness does not send, `ctx.x` uses outside `inject`, or UI slots in the DeepSeek chat view.
- **Loads:** the plugin starts, and the static scan found no gap.

| Scenario | Gate | Blocked | Partial | Loads | Starts (partial + loads) |
|---|---|---|---|---|---|
| A: the current plan | 5 | 9 | 8 | 6 | 14 of 28 |
| B: the plan and 8 more shims | 5 | 4 | 10 | 9 | 19 of 28 (19 of the 23 that pass the gate) |

The 8 more shims in scenario B are `storageDomain`, `workspaceRegistry`, `fs`, `sandboxPolicy`, `subprocess` (phase 4), and `webServer`, `webRuntime`, `connection` (phase 5).

The services that block the most plugins in scenario A:

| Service | Plugins |
|---|---|
| `webServer` | 6 |
| `storageDomain` | 4 |
| `workspaceRegistry`, `sandboxPolicy`, `fs` | 3 each |
| `webRuntime`, `connection`, `sessionQuery`, `subprocess`, `sessionPersistence` | 2 each |

Other findings:

- 5 of the 28 plugins fail the peer gate of the current DeepSeek release. Many community plugins pin old versions.
- 13 plugins have a UI half. 7 of them use slots in the DeepSeek chat view (`conversation.*`, `tool.call.*`, `sidebar.workspaces`). The plan does not support those slots.
- 3 plugins have a `postinstall` script. With scripts off by default, the user must allow them.
- The scan is static. It can miss a service that bundled or minified code uses, and it cannot tell whether a plugin is useful in Harness. For example, `ds-harness-remote` starts, but its purpose is remote access to the DeepSeek web UI.

Per-plugin results: `survey/scenario-A.json` and `survey/scenario-B.json`. Raw data: `survey/survey.json`. Scripts: `survey/rank.py`, `survey/analyze.py`, `survey/gate.mjs`, `survey/classify2.py`.

## Recommended changes to the plan

1. **D3:** use `module.registerHooks` for module resolution. Do not use Node internals.
2. **D4:** bundle pnpm 11.28.2. Install local folders with `file:` specs.
3. **Phase 4:** add shims for `storageDomain`, `workspaceRegistry` (the Harness projects), `fs`, `sandboxPolicy`, and `subprocess`. The `fs` and `subprocess` shims must use the Harness permission gate.
4. **Phase 5:** add `webServer`, `webRuntime`, and `connection`, so that the host half of a UI plugin can serve its routes through the daemon.
5. **Success target:** "starts and passes a smoke test" for 80% of the surveyed plugins that pass the gate. Scenario B reaches 83% in the static scan. A dynamic test must confirm it.
6. **Open decision:** the DeepSeek chat-view slots are the largest gap for UI plugins (7 of 13). A later decision can add them, or keep them out.

## Not done in phase 0

- **Community plugin code did not run.** The survey is static, because third-party code runs with the rights of the user. A dynamic test needs your approval and an isolated computer or a Windows Sandbox.
- The survey used 30 plugins of about 6,350 on npm.

## Phase 1 exit test: real community plugins

Date: 2026-09-29. The plugin host of phase 1 installed each plugin from npm and loaded it in a new host process. The host ran with a temporary folder as its home, AppData, pnpm store, and npm cache. The folder was deleted after the test.

The test used the 8 surveyed plugins whose host half needs only the phase 1 services. It left out `ds-harness-remote`, because its purpose is remote access to the computer.

| Plugin | Version | State | What it registered |
|---|---|---|---|
| `dsh-plugin-guide` | 0.3.19 | Active | 1 skill |
| `dsh-defend` | 0.3.16 | Active | Tool `defend_report`, command `/defend` |
| `@agent_forge/forge-dsh` | 1.73.2 | Active | Command `/forge-status` |
| `dsh-m` | 0.5.0 | Active | 8 `dshm_*` tools, prompt text |
| `dsh-better-workspace` | 0.27.0 | Active | Nothing on the host (UI plugin) |
| `dsh-smooth-stream` | 0.6.1 | Active | Nothing on the host (UI plugin) |
| `dsh-data-cleaning-agent` | 0.9.17 | Active | 3 tools, 2 skills |
| `dsh-tauri` | 0.6.7 | Active | Nothing on the host (UI plugin) |

Smoke calls: `/defend`, `/forge-status`, `defend_report`, and `data_profile` returned results, and the 3 skills loaded with their text. The log had no errors or warnings. The test did not call the `dshm_*` tools, because they install and upgrade plugins.

Result: 8 of 8 start, and all smoke calls pass. Their events (for example the `tools/pre-execute` checks of `dsh-defend` and `forge-dsh`) reach DeepSeek tools only, until phase 2 adds the Harness tools.
