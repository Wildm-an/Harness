// App updates with tauri-plugin-updater (docs/RELEASE.md). The update address goes in
// tauri.conf.json when the public repository exists. Until then, a check gives a clear message.
//
// The app checks only when the user can see its window (checkWhenShown), if the setting "Check for
// updates when the app opens" is on (the default). Each open of the window checks: a click on the tray
// icon, "Open Harness" in the tray menu, a second start of the app, and a restore from the tray or
// the taskbar. The state is shared: the dot on the Settings button, the popup at the bottom left,
// and the Updates page of Settings read it.

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
const LAST_CHECKED_PREF = "updates.last_checked";

/** The desktop app sends this event when the user opens the window: the tray icon, the tray menu, a second start. */
export const APP_OPENED_EVENT = "app-opened";

/** The time of the last check that got an answer (ms since 1970), or null before the first one. */
export function lastChecked(): number | null {
  const n = Number(loadPref(LAST_CHECKED_PREF, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

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
    savePref(LAST_CHECKED_PREF, String(Date.now()));
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

/**
 * A quiet check, if the setting is on and the user can see the window. ``opened``: the user opened
 * the window, so the check runs at once. Else (the window only got the focus) no check ran in the last RECHECK_GAP_MS.
 */
async function checkIfShown(opened = false): Promise<void> {
  if (!ready || !checkAtStart()) return;
  if (state.kind === "available" || state.kind === "installing") return;
  if (!opened && lastCheck && Date.now() - lastCheck < RECHECK_GAP_MS) return;
  if (!(await windowShown())) return;
  lastCheck = Date.now();
  await checkForUpdate(true);
}

/**
 * The quiet checks of the desktop app. The app does not check while its window is hidden (for example,
 * after a start at sign-in, the window stays in the tray). The first check runs a few seconds after the
 * window shows. A later check runs each time the user opens the window again (the user asked for this):
 * the tray icon, the tray menu, a second start, or a restore of the window. The focus alone checks at
 * most once each RECHECK_GAP_MS.
 */
export function checkWhenShown(): void {
  if (watching || !isTauri()) return;
  watching = true;
  const onShow = () => void checkIfShown();
  const onOpen = () => void checkIfShown(true);
  if (typeof document !== "undefined") {
    // A minimized or hidden window has a hidden document: "visible" again is an open of the window.
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && onOpen());
  }
  window.addEventListener("focus", onShow);
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen(APP_OPENED_EVENT, onOpen))
    .catch(() => undefined);
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(({ payload }) => payload && onShow()))
    .catch(() => undefined);
  window.setTimeout(() => {
    ready = true;
    onShow();
  }, LAUNCH_DELAY_MS);
}

/** Download and install the update, then start the new version. Windows closes the app for the installer. */
// The question before an install while the agent works (UpdateGuard.tsx). False: the install does not start.
let installGuard: (() => Promise<boolean>) | null = null;

export function setInstallGuard(guard: (() => Promise<boolean>) | null): void {
  installGuard = guard;
}

export async function installUpdate(): Promise<void> {
  if (state.kind !== "available") return;
  if (installGuard && !(await installGuard())) return;
  if (state.kind !== "available") return; // The state can change while the dialog is open.
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
