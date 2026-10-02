# Coding Harness

A desktop app for agentic coding with local models. See [SPEC.md](SPEC.md) for the specification, [docs/PROTOCOL.md](docs/PROTOCOL.md) for the client–daemon protocol, and [docs/PLUGINS.md](docs/PLUGINS.md) to write a plugin.

## Layout

| Folder | Contents |
|---|---|
| `daemon/` | The agent daemon (Python). See [daemon/README.md](daemon/README.md). |
| `client/` | The desktop client (Tauri 2, React, TypeScript). See [client/README.md](client/README.md). |
| `docs/` | Protocol and design notes. |
| `examples/plugins/` | Example plugins. See [docs/PLUGINS.md](docs/PLUGINS.md). |

## Build phases

| Phase | Status |
|---|---|
| 1. Daemon core | Complete. Tests pass with a fake model. |
| 2. Protocol | Complete. Tests pass with a fake model. |
| 3. Desktop client | Complete. Tauri shell, daemon sidecar, chat screen, and streamed output. |
| 4. Permissions | Complete. Permission gate, diff review pane (side by side and unified), and permission rules panel. |
| 5. All tools and context control | Complete. `write`, `glob`, and `grep` tools, the project instruction file, and context compaction (automatic at 80%, and `/compact`). |
| 6. Skills | Complete. SKILL.md loader, `skill` tool, `/` menu, argument substitution, `allowed-tools`, `context: fork` subagents, and the Skills panel. |
| 7. Remote mode | Complete. Connections screen, direct and SSH tunnel connections, tokens in the keychain, a stable daemon token file, and a remote folder picker. |
| 8. Code editor | Complete. Pane layout (splits, tabs, drag and drop, saved for each project), Monaco editor, file tree, project search, save conflicts, agent edit updates, and chat path links. |
| 9. Servers and browser | Complete. `launch.json` with auto-detection, the Servers pane and toolbar menu, the Browser pane (Tauri child webview), project file URLs, and port forwarding for remote daemons. |
| 10. Agent preview tools | Complete. A headless Chromium through Playwright in the daemon, the nine `preview_*` tools, the navigation allow list, the agent view in the Browser pane, screenshots for models with image input, and the Auto-verify setting. |
| 11. Cookbook | Complete. Hardware detection (local and through SSH), the fit calculator from the GGUF header, the Hugging Face model browser with fit badges, downloads with pause, continue, and cancel, installed models, and llama-server serve control that adds the model to the providers. |
| 12. MCP | Complete. MCP client for stdio, streamable HTTP, and SSE servers from `~/.harness/mcp.json` and `.harness/mcp.json`, `mcp__<server>__<tool>` tools with approval (and `mcp__<server>__*` rules), tool list updates, and the MCP panel. |
| 13. Packaging | Complete. The PyInstaller sidecar (one executable, with a smoke test), the Tauri installers (MSI and NSIS, DMG, deb, rpm, and AppImage), the daemon log in `~/.harness/logs/daemon.log`, and a GitHub Actions workflow that builds the installers on each operating system. |

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- The release workflow (`.github/workflows/release.yml`) builds the Windows files from the source code of this repository. Only these files get a signature.
- Each signature needs a manual approval.

Team roles:

| Role | Members |
|---|---|
| Committers and reviewers | [Wildm-an](https://github.com/Wildm-an) |
| Approvers | [Wildm-an](https://github.com/Wildm-an) |

Privacy: Harness transfers information to other networked systems only when you ask for it, or when you configure a service that it then uses. The one exception is the update check at start, and you can turn it off. See [docs/PRIVACY.md](docs/PRIVACY.md) for each connection.

The licenses of the third-party components are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
