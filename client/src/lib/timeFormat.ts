// The time format of the app (Settings > General > "Time format"): "12h" (9:05 AM, the default, the
// user asked for this) or "24h" (09:05). The daemon keeps the setting (user setting `time_format`),
// because it also writes the time in the titles of routine runs. The app keeps a copy for each device,
// so the times have the right format before the daemon answers.

import { useSyncExternalStore } from "react";
import type { TimeFormat } from "../daemon/protocol";
import { loadPref, savePref } from "./prefs";

export type { TimeFormat };

const PREF = "timeFormat";
const listeners = new Set<() => void>();
let current: TimeFormat | null = null; // Read from the preference at the first use (restorePrefs runs first).

/** All values that are not "24h" give the default, 12-hour time. */
export const toTimeFormat = (value: unknown): TimeFormat => (value === "24h" ? "24h" : "12h");

export function timeFormat(): TimeFormat {
  return (current ??= toTimeFormat(loadPref(PREF, "12h")));
}

/** Use the format of the daemon settings. The components that use useTimeFormat show it at once. */
export function setTimeFormat(value: TimeFormat): void {
  if (value === timeFormat()) return;
  current = value;
  savePref(PREF, value);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The time format, for a component that must show a change of the setting at once. */
export function useTimeFormat(): TimeFormat {
  return useSyncExternalStore(subscribe, timeFormat);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "9:05 AM" or "09:05". AM and PM are always in English, as in the routine run titles. */
export function formatClock(hour: number, minute: number, format: TimeFormat = timeFormat()): string {
  if (format === "24h") return `${pad(hour)}:${pad(minute)}`;
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

/** The time of a date: "9:05 AM" or "09:05". */
export function formatTime(date: Date, format: TimeFormat = timeFormat()): string {
  return formatClock(date.getHours(), date.getMinutes(), format);
}

/** The date and the time: "Nov 13, 2026, 9:05 AM". */
export function formatDateTime(date: Date, format: TimeFormat = timeFormat()): string {
  return `${date.toLocaleDateString(undefined, { dateStyle: "medium" })}, ${formatTime(date, format)}`;
}
