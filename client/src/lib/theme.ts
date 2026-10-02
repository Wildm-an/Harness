// The appearance of the app (Settings > General): Light, Dark, or System. The app always sets
// data-theme on the root element to "light" or "dark", and the CSS reads only that attribute.
// "System" follows the system setting while the app runs. The font size of the chat and the
// density of the sidebar are here too.

import { loadPref, savePref } from "./prefs";

export type Appearance = "light" | "dark" | "system";

const APPEARANCE_PREF = "appearance";
const CHAT_FONT_PREF = "chatFontSize";
export const CHAT_FONT_MIN = 12;
export const CHAT_FONT_MAX = 22;
export const CHAT_FONT_DEFAULT = 14;

const system = () => window.matchMedia?.("(prefers-color-scheme: light)");
const listeners = new Set<() => void>();

export function appearance(): Appearance {
  const value = loadPref(APPEARANCE_PREF, "system");
  return value === "light" || value === "dark" ? value : "system";
}

/** The theme that shows now: the choice of the user, or the system theme. */
export function currentTheme(): "light" | "dark" {
  const choice = appearance();
  if (choice !== "system") return choice;
  return system()?.matches ? "light" : "dark";
}

function apply(): void {
  const theme = currentTheme();
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  listeners.forEach((fn) => fn());
}

export function setAppearance(value: Appearance): void {
  savePref(APPEARANCE_PREF, value);
  apply();
}

/** Call fn when the theme changes, for example to change the colors of the terminal. */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function chatFontSize(): number {
  const n = Number(loadPref(CHAT_FONT_PREF, String(CHAT_FONT_DEFAULT)));
  return Number.isFinite(n) ? Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(n))) : CHAT_FONT_DEFAULT;
}

export function setChatFontSize(px: number): void {
  const n = Math.min(CHAT_FONT_MAX, Math.max(CHAT_FONT_MIN, Math.round(px)));
  savePref(CHAT_FONT_PREF, String(n));
  document.documentElement.style.setProperty("--chat-font-size", `${n}px`);
}

// The density of the sidebar, as in Claude: "compact" (the default) or "comfortable". The app sets
// data-density on the root element, and the CSS reads it.
export type Density = "compact" | "comfortable";
const DENSITY_PREF = "density";

export function density(): Density {
  return loadPref(DENSITY_PREF, "compact") === "comfortable" ? "comfortable" : "compact";
}

export function setDensity(value: Density): void {
  savePref(DENSITY_PREF, value);
  document.documentElement.dataset.density = value;
}

/** Set the theme, the chat font size, and the density before the first paint, and follow the system theme. */
export function initTheme(): void {
  apply();
  document.documentElement.style.setProperty("--chat-font-size", `${chatFontSize()}px`);
  document.documentElement.dataset.density = density();
  system()?.addEventListener("change", apply);
}
