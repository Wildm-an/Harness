// Small per-device UI preferences (last folder, last model, theme). Never store tokens here.
// Storage can be unavailable (private mode). Then the defaults apply.
//
// The desktop app also keeps a copy of all "harness." keys in a file (src-tauri/src/prefs.rs).
// The webview writes localStorage to disk after a delay, and an update ends the app at once, so
// the newest changes could be lost. restorePrefs puts the file back into localStorage at the start.

import { isTauri } from "./tauri";

const PREFIX = "harness.";
const STORE_DELAY_MS = 250;

export function loadPref(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(PREFIX + key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Ignore: the preference is a convenience.
  }
  prefsChanged();
}

/** All "harness." keys of localStorage. */
export function appPrefs(storage: Pick<Storage, "length" | "key" | "getItem">): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    const value = storage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

/**
 * The localStorage of the start: the file wins for each key in it. A key that is only in
 * localStorage stays (its copy to the file can be lost if the app stopped at once).
 */
export function mergePrefs(local: Record<string, string>, file: Record<string, string> | null): Record<string, string> {
  return file ? { ...local, ...file } : local;
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Copy the app settings to the file soon. Call it after a change to a "harness." key of localStorage. */
export function prefsChanged(): void {
  if (!isTauri()) return;
  clearTimeout(timer);
  timer = setTimeout(() => void storePrefs(), STORE_DELAY_MS);
}

/** Copy the app settings to the file now, for example before the installer of an update runs. */
export async function storePrefs(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("prefs_store", { prefs: appPrefs(window.localStorage) });
  } catch (e) {
    console.warn("[harness] Cannot save the app settings to the file:", e);
  }
}

/** Put the saved app settings back into localStorage. Call it before the app reads a setting. */
export async function restorePrefs(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const file = await invoke<Record<string, string> | null>("prefs_load");
    const local = appPrefs(window.localStorage);
    const merged = mergePrefs(local, file);
    for (const [key, value] of Object.entries(merged)) {
      if (local[key] !== value) window.localStorage.setItem(key, value);
    }
    // The first start with the file: save it now. Else save it when localStorage had more keys.
    if (!file || Object.keys(merged).length !== Object.keys(file).length) await storePrefs();
  } catch (e) {
    console.warn("[harness] Cannot read the app settings file:", e);
  }
}
