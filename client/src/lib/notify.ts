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

/** Shows a Windows notification. Nothing happens outside the desktop app or with no permission. */
async function show(title: string, body?: string): Promise<void> {
  if (!isTauri() || !(await allowed())) return;
  try {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification(body ? { title, body } : { title });
  } catch {
    // Ignore: the sidebar also shows the unread session.
  }
}

/** Shows a Windows notification for a routine run when the user does not see its session. */
export async function notifyRoutineRun(ev: RoutineRunEvent, opts: NotifyContext): Promise<void> {
  const text = routineNotice(ev, opts);
  if (text !== null) await show(text);
}

/** The daemon event turn.done: a turn of a session ended. */
export interface TurnDoneEvent {
  session_id: string;
  title: string | null; // The session title. null: the title is not ready yet.
  summary: string; // The first sentence of the last reply, or the reason of an early stop.
  stop_reason: string; // "interrupted": the user stopped the turn.
}

export interface SeenContext {
  windowVisible: boolean; // The window is not hidden in the tray and not minimized.
  windowFocused: boolean; // Harness is the active app.
  shownSessionId: string | null; // The session that the window shows, if any.
}

/**
 * The "task complete" notification of a turn (docs/UI_RULES.md V10): the session title and the summary.
 * null when the user sees the session, or stopped the turn.
 */
export function turnNotice(ev: TurnDoneEvent, ctx: SeenContext): { title: string; body: string } | null {
  if (ev.stop_reason === "interrupted") return null;
  if (ctx.windowVisible && ctx.windowFocused && ctx.shownSessionId === ev.session_id) return null;
  return { title: ev.title?.trim() || "Harness", body: ev.summary.trim() || "The agent finished the turn." };
}

/** Shows the "task complete" notification of a turn when the user does not see the session. */
export async function notifyTurnDone(ev: TurnDoneEvent, ctx: SeenContext): Promise<void> {
  const notice = turnNotice(ev, ctx);
  if (notice) await show(notice.title, notice.body);
}
