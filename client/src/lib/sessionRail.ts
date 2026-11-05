// The session rail, as in the Claude Code desktop app: a column at the right of a session with the
// details of the session in sections. The title bar button shows or hides it. Claude keeps the
// shown state and the folded sections, so the app saves them as per-device preferences.

import type { PrStatus, TaskItem } from "../daemon/protocol";
import { loadPref, savePref } from "./prefs";

/**
 * The default order of the sections, as in Claude: environment, context, pull requests, servers,
 * background tasks. Claude also has a settings section. Harness keeps the mode and model menus under
 * the prompt box. "Browser" (the small live view of the page where the agent works) is under
 * "Servers" (the user asked for it). The user can drag the sections into another order.
 */
export type RailSection = "browser" | "environment" | "context" | "changes" | "pullRequests" | "servers" | "backgroundTasks";

export const RAIL_SECTIONS: { id: RailSection; title: string }[] = [
  { id: "environment", title: "Environment" },
  { id: "context", title: "Context" },
  { id: "changes", title: "Changes" },
  { id: "pullRequests", title: "Pull requests" },
  { id: "servers", title: "Servers" },
  { id: "browser", title: "Browser" },
  { id: "backgroundTasks", title: "Background tasks" },
];

const SHOWN_PREF = "sessionRail.shown";
const FOLDED_PREF = "sessionRail.folded";
// The order that the user set. The desktop app keeps the prefs in a file, so the order stays after an update.
const ORDER_PREF = "sessionRail.order";

/**
 * Read the section order from the saved text. Unknown ids go away. A section that is not in the
 * text (a new section after an update) goes after the section that is before it in the default order.
 */
export function parseOrder(text: string): RailSection[] {
  const ids = RAIL_SECTIONS.map((s) => s.id);
  let saved: RailSection[] = [];
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) saved = value.filter((v, i): v is RailSection => ids.includes(v as RailSection) && value.indexOf(v) === i);
  } catch {
    saved = [];
  }
  const order = [...saved];
  ids.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = index > 0 ? order.indexOf(ids[index - 1]) : -1;
    order.splice(before + 1, 0, id);
  });
  return order;
}

export function sectionOrder(): RailSection[] {
  return parseOrder(loadPref(ORDER_PREF, "[]"));
}

/** Move a section before or after another section. Returns the new order and saves it. */
export function moveSection(order: RailSection[], id: RailSection, target: RailSection, after: boolean): RailSection[] {
  if (id === target) return order;
  const next = order.filter((s) => s !== id);
  const at = next.indexOf(target);
  if (at < 0) return order;
  next.splice(after ? at + 1 : at, 0, id);
  savePref(ORDER_PREF, JSON.stringify(next));
  return next;
}

/** Move a section one place up (-1) or down (1) in the shown sections. Returns the new order and saves it. */
export function stepSection(order: RailSection[], shown: RailSection[], id: RailSection, step: -1 | 1): RailSection[] {
  const index = shown.indexOf(id);
  const target = shown[index + step];
  if (index < 0 || !target) return order;
  return moveSection(order, id, target, step === 1);
}

/**
 * The panes that need the room of the rail: all the windows next to the chat. In the Code view the
 * rail closes when one of them opens, and opens again when all of them are closed.
 */
export const ROOM_PANES = ["editor", "files", "browser", "diff", "rules", "terminal", "side", "tasks", "preview"] as const;

/** True when a pane of ROOM_PANES is in ``after`` and was not in ``before``. */
export function needsRailRoom(before: readonly string[], after: readonly string[]): boolean {
  return ROOM_PANES.some((p) => after.includes(p) && !before.includes(p));
}

/** The rail state: open or not, and ``auto``: a pane closed it, so it opens again with no pane. */
export interface RailState {
  open: boolean;
  auto: boolean;
}

/** The rail after a change of the open panes (ROOM_PANES only). A rail that the user closed stays closed. */
export function railAfterPanes(state: RailState, before: readonly string[], after: readonly string[]): RailState {
  if (state.open && needsRailRoom(before, after)) return { open: false, auto: true };
  if (!state.open && state.auto && before.length > 0 && after.length === 0) return { open: true, auto: false };
  return state;
}

/** The rail shows by default, as in Claude. */
export function railShown(): boolean {
  return loadPref(SHOWN_PREF, "true") !== "false";
}

export function setRailShown(on: boolean): void {
  savePref(SHOWN_PREF, on ? "true" : "false");
}

/** Read the folded sections from the saved text. Unknown ids and bad text give an empty list. */
export function parseFolded(text: string): RailSection[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return RAIL_SECTIONS.map((s) => s.id).filter((id) => value.includes(id));
  } catch {
    return [];
  }
}

export function foldedSections(): RailSection[] {
  return parseFolded(loadPref(FOLDED_PREF, "[]"));
}

/** Fold an open section, or open a folded section. Returns the new list and saves it. */
export function toggleFolded(folded: RailSection[], id: RailSection): RailSection[] {
  const next = folded.includes(id) ? folded.filter((s) => s !== id) : [...folded, id];
  savePref(FOLDED_PREF, JSON.stringify(next));
  return next;
}

/** The share of the context window in use, from 0 to 1. */
export function contextShare(tokens: number, length: number): number {
  return length > 0 ? Math.min(Math.max(tokens / length, 0), 1) : 0;
}

/**
 * The value in the heading of a folded section: the share of the context window in use for the
 * Context section ("57%"). null: the section shows no value.
 */
export function foldedValue(section: RailSection, context: { tokens: number; length: number } | null): string | null {
  if (section !== "context" || !context) return null;
  return percentText(contextShare(context.tokens, context.length));
}

/** The share as text: "<1%" for a small share that is not zero. */
export function percentText(share: number): string {
  const p = share * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

const PR_STATES: Record<NonNullable<PrStatus["pr"]>["state"], string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

export function prStateText(state: NonNullable<PrStatus["pr"]>["state"]): string {
  return PR_STATES[state];
}

/** The running tasks first, then the newest. */
export function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const run = Number(b.status === "running") - Number(a.status === "running");
    return run !== 0 ? run : b.started_at - a.started_at;
  });
}

const MAX_ENDED_IN_RAIL = 3; // The rail shows all running tasks, then this many ended tasks.

/** The tasks of the rail: all the running tasks, then the newest ended tasks. */
export function railTasks(tasks: TaskItem[]): TaskItem[] {
  const sorted = sortTasks(tasks);
  const running = sorted.filter((t) => t.status === "running");
  return [...running, ...sorted.filter((t) => t.status !== "running").slice(0, MAX_ENDED_IN_RAIL)];
}

const KIND_NAMES: Record<NonNullable<TaskItem["kind"]>, string> = { shell: "Command", monitor: "Monitor", agent: "Agent", wakeup: "Wakeup", cron: "Scheduled" };
const STATE_NAMES: Record<TaskItem["status"], string> = { running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" };

/** The detail line of a task: "Agent · Running", or "Wakeup · in 4 min" for a wakeup that waits. */
export function taskDetailText(task: TaskItem, nowMs: number): string {
  const kind = KIND_NAMES[task.kind ?? "shell"];
  if ((task.kind === "wakeup" || task.kind === "cron") && task.status === "running" && task.wake_at) {
    const seconds = Math.max(0, Math.round(task.wake_at - nowMs / 1000));
    return `${kind} · in ${seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`}`;
  }
  return `${kind} · ${STATE_NAMES[task.status]}`;
}

/** "2 running · 3 done", or "None" for an empty list. */
export function taskSummary(tasks: TaskItem[]): string {
  if (tasks.length === 0) return "None";
  const running = tasks.filter((t) => t.status === "running").length;
  const ended = tasks.length - running;
  return [running ? `${running} running` : "", ended ? `${ended} ended` : ""].filter(Boolean).join(" · ");
}
