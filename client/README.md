# harness-client

The desktop client: Tauri 2, React, TypeScript, and Vite.

## Prerequisites

- Node.js 20 or later.
- Rust (stable), from https://rustup.rs.
- Windows: the Visual Studio C++ Build Tools and WebView2.
- The daemon virtual environment at `../daemon/.venv`. See [../daemon/README.md](../daemon/README.md).

## Run

```bash
npm install
npm run tauri dev
```

The app starts the daemon as a sidecar on `127.0.0.1` with a random port and a random token. The daemon command comes from:

1. The `HARNESS_DAEMON` environment variable (a path to a daemon executable).
2. Otherwise, `../daemon/.venv` with `python -m harness_daemon`.

The daemon stops when the app closes, because the app closes the daemon stdin.

## Connections

The Connections screen (the connection chip in the title bar) lists "This computer" and the remote daemons.

- **Direct:** the client connects to `ws://<host>:<port>/ws`, for example over Tailscale.
- **SSH tunnel:** the app starts `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<daemon port>` with `BatchMode=yes` (key login only) and `StrictHostKeyChecking=accept-new`. The app stops the tunnel when it disconnects or quits.
- The tokens are in the keychain of the operating system (`src-tauri/src/secrets.rs`). The connection list has no secrets.
- For a remote daemon, "Browse" opens a folder picker that lists the folders of the remote computer.

## Run in a browser (UI work only)

```bash
npm run dev
```

Open `http://127.0.0.1:1420`. Start a daemon (`python -m harness_daemon --port 8765`), then add it as a direct connection with its token. In a browser there is no keychain and no SSH tunnel: the token is kept only until the tab closes.

For a model with no GPU, use the scripted demo model:

```bash
python ../daemon/scripts/demo_model.py --port 11500
```

Then add `"demo": { "base_url": "http://127.0.0.1:11500/v1", "api_key": "demo" }` to `~/.harness/providers.json` and use the model `demo/scripted`.

## Test

```bash
npm test          # Unit tests (Vitest)
npm run typecheck
npm run build
```

## Files

| File | Function |
|---|---|
| `src-tauri/src/sidecar.rs` | Starts and stops the local daemon. |
| `src-tauri/src/tunnel.rs` | SSH tunnels to remote daemons. |
| `src-tauri/src/secrets.rs` | Tokens in the keychain of the operating system. |
| `src/lib/connections.ts` | The connection list, the tokens, and the target of each connection. |
| `src/daemon/connection.ts` | The WebSocket connection and the auth step. |
| `src/daemon/protocol.ts` | The message types. See `docs/PROTOCOL.md`. |
| `src/chat/state.ts` | The reducer that turns daemon events into chat items. |
| `src/components/` | The screens and the chat components. |
| `src/styles.css` | The design tokens (dark and light) and the styles. |

## Design

The design comes from the ui-ux-pro-max "Developer Tool / IDE" recommendation:

- Colors: slate surfaces, a green action color, and 4.5:1 minimum text contrast in dark and light themes.
- Fonts: IBM Plex Sans for the UI and JetBrains Mono for code. The fonts are bundled, so the app operates offline.
- Icons: Lucide SVG icons.
- Visible focus rings, 150–200 ms transitions, and `prefers-reduced-motion` support.
