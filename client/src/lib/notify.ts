// Windows notifications for routine runs (the daemon event routine.run). A notification shows
// only when the user does not see the session: the window is hidden, or it shows another session.

import { isTauri } from "./tauri";

export type RoutineRunStatus = "running" | "waiting" | "done" | "failed";

export interface RoutineRunEvent {
  name: string; // The name of the routine.
  status: RoutineRunStatus;
  session_id: string; // The session of the run.
}

export interface NotifyContext {
  windowVisible: boolean;
  shownSessionId: string | null; // The session that the window shows, if any.
}

/** The text of the notification for a routine run, or null when no notification shows. */
export function routineNotice(ev: RoutineRunEvent, opts: NotifyContext): string | null {
  const name = ev.name.trim() || "A routine";
  let text: string | null = null;
  if (ev.status === "waiting") text = `${name} needs your approval`;
  else if (ev.status === "done") text = `${name} finished`;
  else if (ev.status === "failed") text = `${name} failed`;
  if (text === null) return null;
  // The user sees the session: the session itself shows the change.
  if (opts.windowVisible && opts.shownSessionId === ev.session_id) return null;
  return text;
}

// The app asks Windows for the permission one time only.
let permission: Promise<boolean> | null = null;

function allowed(): Promise<boolean> {
  permission ??= (async () => {
    const n = await import("@tauri-apps/plugin-notification");
    if (await n.isPermissionGranted()) return true;
    return (await n.requestPermission()) === "granted";
  })().catch(() => false);
  return permission;
}

/** Shows a Windows notification for a routine run when the user does not see its session. */
export async function notifyRoutineRun(ev: RoutineRunEvent, opts: NotifyContext): Promise<void> {
  const text = routineNotice(ev, opts);
  if (text === null || !isTauri()) return;
  if (!(await allowed())) return;
  try {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({ title: text });
  } catch {
    // Ignore: the session in the sidebar also shows the run.
  }
}
