// App updates with tauri-plugin-updater (docs/RELEASE.md). The update address goes in
// tauri.conf.json when the public repository exists. Until then, a check gives a clear message.

import type { Update } from "@tauri-apps/plugin-updater";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" } // This is the newest version.
  | { kind: "available"; update: Update }
  | { kind: "installing"; percent: number | null }
  | { kind: "error"; message: string };

/** The text of an updater error for the user. */
export function updateErrorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/endpoint/i.test(text)) return "This build has no update address yet. Updates start with the first public release.";
  return `The update check failed: ${text}`;
}

export async function checkForUpdate(): Promise<Update | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  return check();
}

/** Download and install an update, then start the new version. Windows closes the app for the installer. */
export async function installUpdate(update: Update, onPercent: (percent: number | null) => void): Promise<void> {
  let total = 0;
  let done = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") total = event.data.contentLength ?? 0;
    else if (event.event === "Progress") {
      done += event.data.chunkLength;
      onPercent(total ? Math.min(100, Math.round((done / total) * 100)) : null);
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
