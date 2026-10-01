// Tauri calls. In a normal browser (for example `npm run dev` with no Tauri), these are not available.

export interface DaemonInfo {
  host: string;
  port: number;
  token: string;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function localDaemonInfo(restart = false): Promise<DaemonInfo> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DaemonInfo>(restart ? "restart_daemon" : "daemon_info");
}

/** Shows the folder dialog. Returns null if the user cancels. */
export async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}

/** Shows a folder or a file in Explorer (Finder on macOS). Only for the daemon on this computer. */
export async function revealInExplorer(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** Opens a file of this computer in its default app, for example the settings file in an editor. */
export async function openLocalPath(path: string): Promise<void> {
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}

/** The version of the desktop app. */
export async function appVersionOf(): Promise<string> {
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** Opens an http or https URL in the system browser. */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export interface TunnelSpec {
  id: string;
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  identityFile?: string;
  remotePort: number;
}

/** Opens an SSH tunnel to a remote daemon. Returns the local port. */
export async function tunnelOpen(spec: TunnelSpec): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("tunnel_open", { spec });
}

export async function tunnelClose(id: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("tunnel_close", { id });
}

export async function secretGet(key: string): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("secret_get", { key });
}

export async function secretSet(key: string, value: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("secret_set", { key, value });
}

export async function secretDelete(key: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("secret_delete", { key });
}

export interface ForwardSpec {
  daemonHost: string;
  daemonPort: number;
  token: string;
  sessionId: string;
  server: string;
}

/** A local port for a server on a remote daemon (SPEC.md section 8.6). */
export async function forwardOpen(spec: ForwardSpec): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("forward_open", { spec });
}

export async function forwardCloseAll(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("forward_close_all");
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserEvent {
  id: string; // The tab.
  url: string;
  loading: boolean;
  title?: string; // Only in a title change.
}

/** The webviews of the Browser pane: one for each tab. Each call does nothing outside the desktop app. */
export const browserView = {
  async open(id: string, url: string, bounds: Bounds) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_open", { id, url, bounds });
  },
  async bounds(id: string, bounds: Bounds) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_bounds", { id, bounds });
  },
  async visible(id: string, visible: boolean) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_visible", { id, visible });
  },
  async navigate(id: string, url: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_navigate", { id, url });
  },
  async history(id: string, action: "back" | "forward" | "reload") {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_history", { id, action });
  },
  async devtools(id: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_devtools", { id });
  },
  async clearData(id: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_clear_data", { id });
  },
  async close(id: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_close", { id });
  },
  /** Close the webviews of all tabs: the page of the app loaded again, and its tabs are gone. */
  async closeAll() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_close_all");
  },
  /** Page loads and title changes in the tabs. Returns a function that stops the listener. */
  async onEvent(fn: (event: BrowserEvent) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<BrowserEvent>("browser-event", (e) => fn(e.payload));
  },
  /** A page asks for a new window, for example a link with target="_blank". */
  async onNewTab(fn: (event: { id: string; url: string }) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<{ id: string; url: string }>("browser-new-tab", (e) => fn(e.payload));
  },
};
