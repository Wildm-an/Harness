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
