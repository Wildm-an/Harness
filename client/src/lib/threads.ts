// The Threads layout of the sidebar (docs/UI_RULES.md 3.7): the user asked for the thread list of T3 Code.
// One list, not grouped by project, in sections: Pinned, Active, Working, Snoozed, and Settled. Settled is
// the Harness archive. The daemon keeps the manual order (`position`), the wake time (`snoozed_until`),
// "Auto-settle" > "Never" (`auto_archive`), and the settle time (`archived_at`). These helpers are pure:
// ThreadsList.tsx draws the list, and App.tsx sends the changes.

import { useSyncExternalStore } from "react";
import type { RunningSession, SessionSummary } from "../daemon/protocol";
import { formatTime } from "./timeFormat";
import { loadPref, savePref } from "./prefs";

// -- the setting: Settings > General > "Sidebar organization" (per device) ----------------------------------

export type SidebarOrganization = "sessions" | "threads";

const ORGANIZATION_PREF = "sidebar.organization";
const listeners = new Set<() => void>();

export const toOrganization = (value: unknown): SidebarOrganization => (value === "threads" ? "threads" : "sessions");

export function sidebarOrganization(): SidebarOrganization {
  return toOrganization(loadPref(ORGANIZATION_PREF, "sessions"));
}

export function setSidebarOrganization(value: SidebarOrganization): void {
  savePref(ORGANIZATION_PREF, value);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The sidebar organization. The sidebar changes at once when the setting changes. */
export function useSidebarOrganization(): SidebarOrganization {
  return useSyncExternalStore(subscribe, sidebarOrganization);
}

// -- sections ---------------------------------------------------------------------------------------

export type ThreadSection = "pinned" | "active" | "working" | "snoozed" | "settled";

export const SECTION_LABELS: Record<ThreadSection, string> = {
  pinned: "Pinned",
  active: "Active",
  working: "Working",
  snoozed: "Snoozed",
  settled: "Settled",
};

/** Seconds since 1970, as the daemon times. */
export const nowSeconds = () => Date.now() / 1000;

export function isSnoozed(s: Pick<SessionSummary, "snoozed_until">, now: number): boolean {
  return typeof s.snoozed_until === "number" && s.snoozed_until > now;
}

/**
 * The section of a session. Settled (archived) first, then Pinned. A session that waits for input
 * (a permission or a question) stays in Active, also when it is snoozed. A snoozed session is in Snoozed,
 * also when it works. A session with a running turn or background work is in Working.
 */
export function sectionOf(s: SessionSummary, running: RunningSession | undefined, now: number): ThreadSection {
  if (s.archived) return "settled";
  if (s.pinned) return "pinned";
  if (running?.waiting) return "active";
  if (isSnoozed(s, now)) return "snoozed";
  if (running) return "working";
  return "active";
}

/** The manual order: the sessions with a position first (low first), then the others, newest first. */
export function compareManual(a: SessionSummary, b: SessionSummary): number {
  const pa = a.position ?? null;
  const pb = b.position ?? null;
  if (pa !== null && pb !== null) return pa - pb || b.created_at - a.created_at;
  if (pa !== null) return -1;
  if (pb !== null) return 1;
  return b.created_at - a.created_at;
}

export type ThreadSections = Record<ThreadSection, SessionSummary[]>;

/**
 * The sessions of each section, in the order of the section. Pinned and Active: the manual order.
 * Working: the session that started work last first (``startedAt``, else the last activity).
 * Snoozed: the next wake first. Settled: the settle time, newest first.
 */
export function threadSections(
  sessions: SessionSummary[],
  running: Map<string, RunningSession>,
  now: number,
  startedAt: Map<string, number> = new Map(),
): ThreadSections {
  const out: ThreadSections = { pinned: [], active: [], working: [], snoozed: [], settled: [] };
  for (const s of sessions) out[sectionOf(s, running.get(s.id), now)].push(s);
  out.pinned.sort(compareManual);
  out.active.sort(compareManual);
  const started = (s: SessionSummary) => startedAt.get(s.id) ?? s.updated_at;
  out.working.sort((a, b) => started(b) - started(a));
  out.snoozed.sort((a, b) => (a.snoozed_until ?? 0) - (b.snoozed_until ?? 0));
  const settled = (s: SessionSummary) => s.archived_at ?? s.updated_at;
  out.settled.sort((a, b) => settled(b) - settled(a));
  return out;
}

/**
 * The start time of the work of each working session: a session keeps its time while it works, and a
 * session that starts work gets ``now``. The sessions that stopped go. Returns the same map when nothing changed.
 */
export function trackStarts(previous: Map<string, number>, running: RunningSession[], now: number): Map<string, number> {
  const working = running.filter((r) => !r.waiting).map((r) => r.session_id);
  const same = working.length === previous.size && working.every((id) => previous.has(id));
  if (same) return previous;
  return new Map(working.map((id) => [id, previous.get(id) ?? now]));
}

/** The next time that a snoozed session wakes (a section changes then), or null. */
export function nextWake(sessions: SessionSummary[], now: number): number | null {
  let next: number | null = null;
  for (const s of sessions) {
    if (s.archived || !isSnoozed(s, now)) continue;
    if (next === null || s.snoozed_until! < next) next = s.snoozed_until!;
  }
  return next;
}

// -- positions ------------------------------------------------------------------------------------

type Positioned = Pick<SessionSummary, "id" | "position">;

export interface PositionUpdate {
  id: string;
  position: number;
}

/**
 * The positions after a drop of ``id`` at ``index`` of ``list`` (the rows of the section in their order,
 * without the dropped session). Usually one update: a position between the two neighbors. When the row
 * above has no position (the sessions with no position are last, newest first), the rows from the first
 * one with no position down to the drop place get positions too, so that the order stays.
 */
export function dropPositions(list: Positioned[], index: number, id: string): PositionUpdate[] {
  const at = Math.max(0, Math.min(index, list.length));
  const prev = at > 0 ? list[at - 1] : null;
  const next = at < list.length ? list[at] : null;
  const pp = prev?.position ?? null;
  const np = next?.position ?? null;
  if (!prev) return [{ id, position: np !== null ? np - 1 : 0 }];
  if (pp !== null) return [{ id, position: np !== null ? (pp + np) / 2 : pp + 1 }];
  const first = list.findIndex((s) => s.position == null);
  const base = first > 0 ? (list[first - 1].position ?? 0) : 0;
  const updates = list.slice(first, at).map((s, i) => ({ id: s.id, position: base + 1 + i }));
  updates.push({ id, position: base + 1 + (at - first) });
  return updates;
}

/** A position above all sessions: the top of Active ("Un-settle" returns a session to the top). */
export function topPosition(sessions: Positioned[]): number {
  let min: number | null = null;
  for (const s of sessions) if (typeof s.position === "number" && (min === null || s.position < min)) min = s.position;
  return min === null ? 0 : min - 1;
}

/** "Move up" (-1) or "Move down" (1) in a section: the position updates, or [] at the end of the list. */
export function movePositions(list: Positioned[], id: string, step: -1 | 1): PositionUpdate[] {
  const at = list.findIndex((s) => s.id === id);
  if (at < 0) return [];
  const target = at + step;
  if (target < 0 || target >= list.length) return [];
  const rest = list.filter((s) => s.id !== id);
  return dropPositions(rest, target, id);
}

// -- drops ----------------------------------------------------------------------------------------

export type DropAction = "reorder" | "pin" | "unpin" | "settle" | "unsettle" | "wake";

/** The label of the drag pill (rule S9) when the drop changes the section. Reorder has no pill. */
export const DROP_LABELS: Record<Exclude<DropAction, "reorder">, string> = {
  pin: "Pin",
  unpin: "Unpin",
  settle: "Settle",
  unsettle: "Un-settle",
  wake: "Wake",
};

/** The sections that a drag can start in. A working session works: it has no drag. */
export const DRAG_SECTIONS: ThreadSection[] = ["pinned", "active", "snoozed", "settled"];

/**
 * The action of a drop of a row of ``from`` on ``to``. null: no drop there. Snoozed takes no drop: a snooze
 * needs a wake time. Working takes no drop. A drop on Settled settles the session.
 */
export function dropAction(from: ThreadSection, to: ThreadSection): DropAction | null {
  if (to === "snoozed" || to === "working" || from === "working") return null;
  if (to === "settled") return from === "settled" ? null : "settle";
  if (from === to) return "reorder"; // Pinned or Active.
  if (to === "pinned") return "pin"; // From Active, Snoozed, or Settled.
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake"; // From Snoozed into Active.
}

/** The fields of session.update that the Threads layout changes. */
export type ThreadFields = Partial<Pick<SessionSummary, "pinned" | "archived" | "position" | "snoozed_until" | "auto_archive">>;

export interface ThreadUpdate {
  id: string;
  fields: ThreadFields;
}

/** The fields of a settle: archived, and no pin (settling removes the pin). */
export const SETTLE_FIELDS: ThreadFields = { archived: true, pinned: false };

/**
 * The updates of a drop. ``list``: the rows of the target section without the dragged one, ``index``: the
 * drop place in it. Settle has no position.
 */
export function dropUpdates(action: DropAction, s: SessionSummary, list: Positioned[], index: number): ThreadUpdate[] {
  if (action === "settle") return [{ id: s.id, fields: { ...SETTLE_FIELDS } }];
  const positions = dropPositions(list, index, s.id);
  const own = positions.find((p) => p.id === s.id)!;
  const others = positions.filter((p) => p.id !== s.id).map((p) => ({ id: p.id, fields: { position: p.position } }));
  const fields: ThreadFields = { position: own.position };
  if (action === "pin") {
    fields.pinned = true;
    if (s.archived) fields.archived = false;
    if (s.snoozed_until != null) fields.snoozed_until = null;
  } else if (action === "unpin") fields.pinned = false;
  else if (action === "unsettle") fields.archived = false;
  else if (action === "wake") fields.snoozed_until = null;
  return [...others, { id: s.id, fields }];
}

/** The undo of updates: the earlier values of the same fields, from the session list before the change. */
export function undoUpdates(before: SessionSummary[], updates: ThreadUpdate[]): ThreadUpdate[] {
  const byId = new Map(before.map((s) => [s.id, s]));
  const out: ThreadUpdate[] = [];
  for (const u of updates) {
    const s = byId.get(u.id);
    if (!s) continue;
    const fields: ThreadFields = {};
    for (const key of Object.keys(u.fields) as (keyof ThreadFields)[]) {
      if (key === "pinned" || key === "archived") fields[key] = !!s[key];
      else if (key === "auto_archive") fields.auto_archive = s.auto_archive !== false;
      else fields[key] = s[key] ?? null;
    }
    out.push({ id: u.id, fields });
  }
  return out;
}

/** The session list with the updates, at once (the daemon list confirms them). An archive gets its time. */
export function applyUpdates(sessions: SessionSummary[], updates: ThreadUpdate[], now: number): SessionSummary[] {
  const byId = new Map(updates.map((u) => [u.id, u.fields]));
  if (byId.size === 0) return sessions;
  return sessions.map((s) => {
    const fields = byId.get(s.id);
    if (!fields) return s;
    const next = { ...s, ...fields };
    if (fields.archived !== undefined && fields.archived !== !!s.archived) next.archived_at = fields.archived ? now : null;
    return next;
  });
}

/** The popup text of an action that can be undone (rule R7a), or null for an action with no popup. */
export function undoText(action: "unpin" | "settle" | "snooze", title: string | null, until?: number, now = nowSeconds()): string {
  const name = title ?? "Untitled session";
  if (action === "unpin") return `Unpinned ${name}.`;
  if (action === "settle") return `Settled ${name}.`;
  return `Snoozed ${name} until ${until !== undefined ? whenText(until, now) : "later"}.`;
}

/** How long the undo popup of the Threads layout shows: 5 seconds, as in T3 Code. */
export const THREAD_UNDO_MS = 5000;

// -- snooze ---------------------------------------------------------------------------------------

export interface SnoozeChoice {
  label: string;
  until: number; // Seconds since 1970.
}

function at9(date: Date): Date {
  const d = new Date(date);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** The choices of the "Snooze" menus: "1 hour", "3 hours", "Tomorrow" (9:00 AM), "Next Monday" (9:00 AM). The menu shows the wake time of each. */
export function snoozeChoices(now: Date = new Date()): SnoozeChoice[] {
  const ms = now.getTime();
  const tomorrow = at9(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  // The next Monday after today: on a Monday, the Monday of the next week.
  const days = ((8 - now.getDay()) % 7) || 7;
  const monday = at9(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
  return [
    { label: "1 hour", until: (ms + 3600_000) / 1000 },
    { label: "3 hours", until: (ms + 3 * 3600_000) / 1000 },
    { label: "Tomorrow", until: tomorrow.getTime() / 1000 },
    { label: "Next Monday", until: monday.getTime() / 1000 },
  ];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A time to come, short: "9:00 AM" (today), "tomorrow 9:00 AM", "Mon 9:00 AM" (this week), or "Nov 20, 9:00 AM". */
export function whenText(until: number, now: number = nowSeconds()): string {
  const date = new Date(until * 1000);
  const today = new Date(now * 1000);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(date) - dayStart(today)) / 86_400_000);
  const time = formatTime(date);
  if (days <= 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${WEEKDAYS[date.getDay()]} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** The note of a snoozed row: "Wakes 9:00 AM". */
export const wakesText = (until: number, now: number = nowSeconds()) => `Wakes ${whenText(until, now)}`;

// -- Ctrl+Z ---------------------------------------------------------------------------------------

/** Ctrl+Z runs the last "Undo" only when the focus is not in a text field, the editor, or the terminal. */
export function undoKeyAllowed(target: EventTarget | null): boolean {
  const el = target as (Element & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.closest !== "function") return true;
  if (el.isContentEditable) return false;
  return !el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .monaco-editor, .xterm");
}

// -- the row of T3 Code -----------------------------------------------------------------------------

/** The age of the last activity, short, as T3 Code: "now" (under a minute), "5m", "2h", "3d". */
export function compactAge(at: number, now: number = nowSeconds()): string {
  const seconds = Math.max(0, Math.floor(now - at));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The time of work, as T3 Code: "42s", "5m", "1h 20m". */
export function workingDuration(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The status of a card row, in place of the time: "Working", "Approval" (awaits input), "Done" (unread). */
export type ThreadStatus = "working" | "approval" | "done";

export function threadStatus(running: RunningSession | undefined, unread: boolean): ThreadStatus | null {
  if (running?.waiting) return "approval";
  if (running) return "working";
  if (unread) return "done";
  return null;
}

/** The time that a row shows: the settle time for a settled row, else the last activity. */
export const rowTime = (s: SessionSummary): number => (s.archived ? (s.archived_at ?? s.updated_at) : s.updated_at);
