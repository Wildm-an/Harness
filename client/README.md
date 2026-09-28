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
2. The bundled sidecar: `harness-daemon` next to the app executable. The installers put it there.
3. Otherwise, `../daemon/.venv` with `python -m harness_daemon`.

The daemon stops when the app closes, because the app closes the daemon stdin.

The development daemon (3) writes its log to the terminal. The other daemons write it to `~/.harness/logs/daemon.log`. The log of the previous start is `daemon.log.1`.

## Package

The installers include the daemon sidecar. Build them on each operating system, because PyInstaller cannot cross-compile.

1. Build the sidecar. See "Package the sidecar" in [../daemon/README.md](../daemon/README.md).

   ```bash
   ../daemon/.venv/Scripts/python ../daemon/scripts/build_sidecar.py
   ```

2. Build the installers:

   ```bash
   npm run package
   ```

`npm run package` is `tauri build` with `src-tauri/tauri.bundle.json`, which adds the sidecar (`bundle.externalBin`). The development config does not name the sidecar, so `npm run tauri dev` works without it. The installers are in `src-tauri/target/release/bundle/`:

| Operating system | Installers |
|---|---|
| Windows | `msi/` (WiX) and `nsis/` (a setup `.exe` for the current user). WebView2 installs if it is not on the computer. |
| macOS | `dmg/` and `macos/` (the `.app`). macOS 11 or later. |
| Linux | `deb/`, `rpm/`, and `appimage/`. |

The GitHub Actions workflow `.github/workflows/release.yml` builds all the installers. A tag `v*` also makes a draft release.

The installers are not signed. Windows SmartScreen shows a warning. On macOS, a downloaded app that is not signed does not open: remove the quarantine attribute with `xattr -dr com.apple.quarantine /Applications/Harness.app`, or add signing (the Tauri `APPLE_*` environment variables).

After an install, the agent browser needs Chromium. Run the installed sidecar with `--install-browser`, for example `"%LOCALAPPDATA%\Harness\harness-daemon.exe" --install-browser` on Windows. The agent gets the same command in the error message when Chromium is not installed.

## Connections

The Connections screen (the connection chip in the title bar) lists "This computer" and the remote daemons.

- **Direct:** the client connects to `ws://<host>:<port>/ws`, for example over Tailscale.
- **SSH tunnel:** the app starts `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<daemon port>` with `BatchMode=yes` (key login only) and `StrictHostKeyChecking=accept-new`. The app stops the tunnel when it disconnects or quits.
- The tokens are in the keychain of the operating system (`src-tauri/src/secrets.rs`). The connection list has no secrets.
- For a remote daemon, "Browse" opens a folder picker that lists the folders of the remote computer.

## Panes and the editor

- The main window has tab groups: Chat, Editor, Diff, Rules, and Skills. Drag a tab to another group, or to a side of a group to make a split. The menu of each group (⋮) has the same actions for the keyboard. Drag a handle, or use the arrow keys on it, to change the size.
- The app saves the layout for each project. On a window under 900 px, all panes are tabs of one group.
- The editor (Monaco, bundled) reads and saves files through the daemon. It works the same way with a remote daemon.
  - `Ctrl+S` saves. `Ctrl+L` adds the selected lines to the prompt as `@path:10-25`.
  - A clean tab loads a change from the agent at once. A tab with unsaved changes shows a choice: compare, load the disk version, or keep your version.
  - A save stops if the file changed after the editor read it. The editor then shows the same choice.
  - The lines that the agent changed in the current turn have a green mark.
  - A file path in the chat, such as `src/app.py:42`, opens the file at that line.

## Servers and the browser

- The Servers pane (and the Servers menu in the toolbar) lists the servers of `.harness/launch.json`: start, stop, restart, stop all, the live log (stdout and stderr), "Open in browser", and "Edit configuration". If the file does not exist, the pane shows the servers that the daemon proposes. The daemon writes the file only when you save the proposal.
- `/servers` opens the pane. `/preview` starts the default server and opens it in the Browser pane.
- The Browser pane is a separate Tauri webview over the pane area (`src-tauri/src/browser.rs`). Its pages cannot call Tauri commands: the capability names only the `main` webview. It has its own data folder, so a clear of its cookies does not clear the app settings.
- The browser webview is drawn above the page, so it hides while a menu, a dialog, or a tab drag is open (`src/lib/overlay.ts`).
- A server on a remote daemon opens through a local port: the app forwards each TCP connection over a WebSocket to the daemon (`src-tauri/src/forward.rs`).
- A chat link to an HTML, PDF, image, or video file opens it in the Browser pane.
- Outside the desktop app, the Browser pane uses an iframe.

## Run in a browser (UI work only)

```bash
npm run dev
```

Open `http://127.0.0.1:1420`. Start a daemon (`python -m harness_daemon --port 8765`), then add it as a direct connection with its token. In a browser there is no keychain and no SSH tunnel: the token is kept only until the tab closes.

For a model with no GPU, use the scripted demo model:

```bash
python ../daemon/scripts/demo_model.py --port 11500
```

Then add a provider on the Providers screen with the URL `http://127.0.0.1:11500/v1` and "No key", and use the model `<name>/scripted`. You can also add `"demo": { "base_url": "http://127.0.0.1:11500/v1", "api_key": "demo" }` to `~/.harness/providers.json`.

## Test

```bash
npm test          # Unit tests (Vitest)
npm run typecheck
npm run build
```

## Files

| File | Function |
|---|---|
| `src-tauri/src/sidecar.rs` | Starts and stops the local daemon, and writes its log. |
| `src-tauri/tauri.bundle.json` | The config addition for the installers: the daemon sidecar. |
| `src-tauri/src/tunnel.rs` | SSH tunnels to remote daemons. |
| `src-tauri/src/secrets.rs` | Tokens in the keychain of the operating system. |
| `src-tauri/src/browser.rs` | The Browser pane webview. |
| `src-tauri/src/forward.rs` | Port forwarding for servers on a remote daemon. |
| `src/servers/` | The servers state, the Servers pane, and the toolbar menu. |
| `src/browser/` | The Browser pane. |
| `src/layout/` | The pane layout model (pure functions) and the workspace component. |
| `src/editor/` | The editor state, the Monaco pane, the file tree, and the project search. |
| `src/lib/monaco.ts` | The Monaco setup: local workers, themes, and no semantic TypeScript checks. |
| `src/lib/connections.ts` | The connection list, the tokens, and the target of each connection. |
| `src/daemon/connection.ts` | The WebSocket connection and the auth step. |
| `src/daemon/protocol.ts` | The message types. See `docs/PROTOCOL.md`. |
| `src/chat/state.ts` | The reducer that turns daemon events into chat items. |
| `src/components/` | The screens and the chat components. |
| `src/styles.css` | The design tokens (dark and light) and the styles. |

## Design

The layout follows the Claude Code desktop app (the Code tab):

- A sidebar with "New session", the Cookbook, the Providers, the sessions by day, and the connection. On a window under 900 px, the sidebar covers the page.
- The start screen is a prompt box. Type the first task, select the project and the model in the chips below the text, and press Enter. The session starts, and the task goes to the agent. An empty box starts the session with no task.
- A top bar with the session title, the project folder, the Servers menu, and icon buttons for the panes.
- A plain transcript: the user messages are bubbles, and each tool call is one row with a status dot and the Claude Code tool name (Read, Update, Bash). Click a row to see its input and output.
- A permission request has three numbered choices: 1 Yes, 2 Yes and do not ask again, and 3 No. The keys 1, 2, 3, and Esc select them.
- A rounded prompt box with the model and the context use below the text.
- Colors: warm neutral surfaces, a clay action color, green for the states that are good, and 4.5:1 minimum text contrast in dark and light themes.
- Fonts: IBM Plex Sans for the UI and JetBrains Mono for code. The fonts are bundled, so the app operates offline.
- Icons: Lucide SVG icons.
- Visible focus rings, 150–200 ms transitions, and `prefers-reduced-motion` support.
