// App updates with tauri-plugin-updater (docs/RELEASE.md). The update address goes in
// tauri.conf.json when the public repository exists. Until then, a check gives a clear message.
//
// The app checks once, a few seconds after it starts (checkOnLaunch), if the setting "Check for updates
// at start" is on (the default). The state is shared: the dot on the Settings button, the popup at the
// bottom left, and Settings > General > Updates read it.

import { useSyncExternalStore } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { loadPref, savePref } from "./prefs";
import { isTauri } from "./tauri";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" } // This is the newest version.
  | { kind: "available"; update: Update }
  | { kind: "installing"; version: string; percent: number | null }
  | { kind: "error"; message: string };

const LAUNCH_DELAY_MS = 4000; // The app and the daemon start first.
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

let launched = false;

/** The quick check after the app starts. It runs once, only in the desktop app, and only if the setting is on. */
export function checkOnLaunch(): void {
  if (launched || !isTauri() || !checkAtStart()) return;
  launched = true;
  window.setTimeout(() => void checkForUpdate(true), LAUNCH_DELAY_MS);
}

/** Download and install the update, then start the new version. Windows closes the app for the installer. */
export async function installUpdate(): Promise<void> {
  if (state.kind !== "available") return;
  const { update } = state;
  const version = update.version;
  setState({ kind: "installing", version, percent: null });
  let total = 0;
  let done = 0;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        done += event.data.chunkLength;
        setState({ kind: "installing", version, percent: total ? Math.min(100, Math.round((done / total) * 100)) : null });
      }
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    setState({ kind: "error", message: `The update did not install: ${e instanceof Error ? e.message : String(e)}` });
  }
}
