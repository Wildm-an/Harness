// App updates with tauri-plugin-updater (docs/RELEASE.md). The update address goes in
// tauri.conf.json when the public repository exists. Until then, a check gives a clear message.
//
// The app checks only when the user can see its window (checkWhenShown), if the setting "Check for
// updates when the app opens" is on (the default). The state is shared: the dot on the Settings button, the popup at the
// bottom left, and Settings > General > Updates read it.

import { useSyncExternalStore } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { loadPref, savePref, storePrefs } from "./prefs";
import { isTauri } from "./tauri";

/** Save the app settings file and the window state. A failure does not stop the update. */
async function keepSettings(): Promise<void> {
  await storePrefs();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("prepare_update");
  } catch (e) {
    console.warn("[harness] Cannot save the window state before the update:", e);
  }
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" } // This is the newest version.
  | { kind: "available"; update: Update }
  // step "download": the app downloads the update. percent is null when the size is not known.
  // step "install": the download is complete. The installer runs, then the app starts again.
  | { kind: "installing"; version: string; step: "download" | "install"; percent: number | null }
  | { kind: "error"; message: string };

const LAUNCH_DELAY_MS = 4000; // The app and the daemon start first.
const RECHECK_GAP_MS = 30 * 60 * 1000; // The shortest time between two quiet checks.
const CHECK_AT_START_PREF = "updates.check_at_start";

/** True if the app looks for a new version when it starts. The default is on. */
export function checkAtStart(): boolean {
  return loadPref(CHECK_AT_START_PREF, "on") !== "off";
}

export function setCheckAtStart(on: boolean): void {
  savePref(CHECK_AT_START_PREF, on ? "on" : "off");
}

let state: UpdateState = { kind: "idle" };
const listeners = new Set<() => void>();

function setState(next: UpdateState): void {
  state = next;
  listeners.forEach((fn) => fn());
}

export function getUpdateState(): UpdateState {
  return state;
}

/** The update state, for a component. It draws again when the state changes. */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

/** The new version, if an update is available or installs now. */
export function availableVersion(s: UpdateState): string | null {
  if (s.kind === "available") return s.update.version;
  if (s.kind === "installing") return s.version;
  return null;
}

/** The text of an updater error for the user. */
export function updateErrorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/endpoint/i.test(text)) return "This build has no update address yet. Updates start with the first public release.";
  // The update address answers 404 until the first release is published on GitHub.
  if (/valid release JSON/i.test(text)) return "No published release was found yet. Check again after the next release.";
  return `The update check failed: ${text}`;
}

/**
 * Look for a new version. ``quiet``: the check at launch. An error then shows nothing, because the
 * user did not ask for the check (for example, there is no network, or no update address yet).
 */
export async function checkForUpdate(quiet = false): Promise<void> {
  if (state.kind === "checking" || state.kind === "installing") return;
  setState({ kind: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    setState(update ? { kind: "available", update } : { kind: "none" });
  } catch (e) {
    setState(quiet ? { kind: "idle" } : { kind: "error", message: updateErrorText(e) });
  }
}

/** True if the user can see the app window: not hidden in the tray, and not minimized. */
async function windowShown(): Promise<boolean> {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    return (await win.isVisible()) && !(await win.isMinimized());
  } catch {
    return true; // The window state is not known. The document state above is then the answer.
  }
}

let watching = false;
let ready = false; // False during the launch delay.
let lastCheck = 0;

/** A quiet check, if the setting is on, the user can see the window, and no check ran in the last RECHECK_GAP_MS. */
async function checkIfShown(): Promise<void> {
  if (!ready || !checkAtStart()) return;
  if (state.kind === "available" || state.kind === "installing") return;
  if (lastCheck && Date.now() - lastCheck < RECHECK_GAP_MS) return;
  if (!(await windowShown())) return;
  lastCheck = Date.now();
  await checkForUpdate(true);
}

/**
 * The quiet checks of the desktop app. The app does not check while its window is hidden (for example,
 * after a start at sign-in, the window stays in the tray). The first check runs a few seconds after the
 * window shows. A later check runs each time the user opens the window again, at most one each RECHECK_GAP_MS.
 */
export function checkWhenShown(): void {
  if (watching || !isTauri()) return;
  watching = true;
  const onShow = () => void checkIfShown();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onShow);
  window.addEventListener("focus", onShow);
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(({ payload }) => payload && onShow()))
    .catch(() => undefined);
  window.setTimeout(() => {
    ready = true;
    onShow();
  }, LAUNCH_DELAY_MS);
}

/** Download and install the update, then start the new version. Windows closes the app for the installer. */
export async function installUpdate(): Promise<void> {
  if (state.kind !== "available") return;
  const { update } = state;
  const version = update.version;
  setState({ kind: "installing", version, step: "download", percent: null });
  let total = 0;
  let done = 0;
  try {
    await update.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        done += event.data.chunkLength;
        setState({ kind: "installing", version, step: "download", percent: total ? Math.min(100, Math.round((done / total) * 100)) : null });
      } else if (event.event === "Finished") setState({ kind: "installing", version, step: "install", percent: 100 });
    });
    // On Windows, the install ends the app at once: save the settings and the window state first.
    await keepSettings();
    await update.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    setState({ kind: "error", message: `The update did not install: ${e instanceof Error ? e.message : String(e)}` });
  }
}
