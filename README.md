# Coding Harness

A desktop app for agentic coding with local models. See [SPEC.md](SPEC.md) for the specification and [docs/PROTOCOL.md](docs/PROTOCOL.md) for the client–daemon protocol.

## Layout

| Folder | Contents |
|---|---|
| `daemon/` | The agent daemon (Python). See [daemon/README.md](daemon/README.md). |
| `client/` | The desktop client (Tauri 2, React, TypeScript). See [client/README.md](client/README.md). |
| `docs/` | Protocol and design notes. |

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
| 8–13 | Not started. |
