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

/** The wheel of the daemon of this app version (base64), for "Update daemon". */
export async function daemonWheel(): Promise<{ filename: string; data: string }> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<{ filename: string; data: string }>("daemon_wheel");
}

/** Shows the folder dialog. Returns null if the user cancels. */
export async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}

/** Shows the file dialog for one or more files, starting in ``folder``. Returns [] if the user cancels. */
export async function pickFiles(folder?: string): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: false, multiple: true, defaultPath: folder });
  if (Array.isArray(result)) return result;
  return typeof result === "string" ? [result] : [];
}

/** Shows the file dialog for one file. Returns null if the user cancels. */
export async function pickFile(filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: false, multiple: false, filters });
  return typeof result === "string" ? result : null;
}

/** Shows the save dialog. Returns null if the user cancels. */
export async function pickSavePath(defaultPath: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return (await save({ defaultPath, filters })) ?? null;
}

/**
 * Asks where to save a file, and saves it. ``data`` is base64. Returns the path, or null if the user
 * cancels. In a normal browser, the browser downloads the file.
 */
export async function saveBase64File(name: string, data: string, filter: { name: string; extensions: string[] }): Promise<string | null> {
  if (!isTauri()) {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return name;
  }
  const path = await pickSavePath(name, [filter]);
  if (!path) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_file", { path, data });
  return path;
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
  /** fresh: clear the cookies and storage of all tabs before the page loads ("Keep cookies: Until quit"). */
  async open(id: string, url: string, bounds: Bounds, fresh = false) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_open", { id, url, bounds, fresh });
  },
  /** Saves a PNG screenshot of the visible part of a tab. */
  async screenshot(id: string, path: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_screenshot", { id, path });
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
  /** A PNG screenshot of the visible part of a tab, as a data URL (the annotation bar). Windows only. */
  async capture(id: string): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("browser_capture", { id });
  },
  /** Runs a script of the app in the page of a tab, for example the annotation mode (annotate.ts). */
  async evalScript(id: string, script: string) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_eval", { id, script });
  },
  /** The annotation script of a page sent data. ``data`` is the encoded text after "#" (annotate.ts). */
  async onAnnotation(fn: (event: { id: string; data: string }) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<{ id: string; data: string }>("browser-annotation", (e) => fn(e.payload));
  },
};
