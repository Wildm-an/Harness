// The session rail, as in the Claude Code desktop app: a column at the right of a session with the
// details of the session in sections. The title bar button shows or hides it. Claude keeps the
// shown state and the folded sections, so the app saves them as per-device preferences.

import type { PrStatus, TaskItem } from "../daemon/protocol";
import { loadPref, savePref } from "./prefs";

/**
 * The sections, in the order of Claude: environment, context, pull requests, servers, background
 * tasks. Claude also has a settings section. Harness keeps the mode and model menus under the prompt box.
 */
export type RailSection = "environment" | "context" | "pullRequests" | "servers" | "backgroundTasks";

export const RAIL_SECTIONS: { id: RailSection; title: string }[] = [
  { id: "environment", title: "Environment" },
  { id: "context", title: "Context" },
  { id: "pullRequests", title: "Pull requests" },
  { id: "servers", title: "Servers" },
  { id: "backgroundTasks", title: "Background tasks" },
];

const SHOWN_PREF = "sessionRail.shown";
const FOLDED_PREF = "sessionRail.folded";

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

/** "2 running · 3 done", or "None" for an empty list. */
export function taskSummary(tasks: TaskItem[]): string {
  if (tasks.length === 0) return "None";
  const running = tasks.filter((t) => t.status === "running").length;
  const ended = tasks.length - running;
  return [running ? `${running} running` : "", ended ? `${ended} ended` : ""].filter(Boolean).join(" · ");
}
