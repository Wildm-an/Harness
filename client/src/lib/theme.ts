// The appearance of the app (Settings > Appearance). The app always sets data-theme on the root
// element to "light" or "dark", and the CSS reads only that attribute. "System" follows the system
// setting while the app runs. The interface font, the text size, the transcript width, the density,
// the code font, and the code themes are here too. Each one is a per-device preference.

import { loadPref, savePref } from "./prefs";

export type Appearance = "light" | "dark" | "system";

const APPEARANCE_PREF = "appearance";
const CHAT_FONT_PREF = "chatFontSize";
export const CHAT_FONT_MIN = 12;
export const CHAT_FONT_MAX = 22;
export const CHAT_FONT_DEFAULT = 14;

const system = () => window.matchMedia?.("(prefers-color-scheme: light)");
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

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
  applyAccent(); // The accent tokens are different in the light and the dark theme.
  notify();
}

export function setAppearance(value: Appearance): void {
  savePref(APPEARANCE_PREF, value);
  apply();
}

/**
 * Call fn when the theme, the code font, or a code theme changes. The terminal and the editor use
 * it to change their colors and their font.
 */
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

// The font of the whole interface: the bundled IBM Plex Sans, or the font of the system.
export type InterfaceFont = "default" | "system";
const INTERFACE_FONT_PREF = "interfaceFont";
const SANS_FALLBACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const SANS_STACKS: Record<InterfaceFont, string> = {
  default: `"IBM Plex Sans", ${SANS_FALLBACK}`,
  system: SANS_FALLBACK,
};

export function interfaceFont(): InterfaceFont {
  return loadPref(INTERFACE_FONT_PREF, "default") === "system" ? "system" : "default";
}

export function setInterfaceFont(value: InterfaceFont): void {
  savePref(INTERFACE_FONT_PREF, value);
  document.documentElement.style.setProperty("--font-sans", SANS_STACKS[value]);
}

// The maximum width of the transcript column. "Full" uses all the width of the pane.
export type TranscriptWidth = "narrow" | "default" | "wide" | "full";
const TRANSCRIPT_WIDTH_PREF = "transcriptWidth";
export const TRANSCRIPT_WIDTHS: Record<TranscriptWidth, string> = {
  narrow: "680px",
  default: "780px",
  wide: "1000px",
  full: "none",
};

export function transcriptWidth(): TranscriptWidth {
  const value = loadPref(TRANSCRIPT_WIDTH_PREF, "default");
  return value in TRANSCRIPT_WIDTHS ? (value as TranscriptWidth) : "default";
}

export function setTranscriptWidth(value: TranscriptWidth): void {
  savePref(TRANSCRIPT_WIDTH_PREF, value);
  document.documentElement.style.setProperty("--column", TRANSCRIPT_WIDTHS[value]);
}

// The code font: a font name that the user types, or "" for the bundled JetBrains Mono. The app
// puts the fallback fonts after the name, so an unknown name shows a monospace font.
const CODE_FONT_PREF = "codeFont";
const MONO_FALLBACK = 'ui-monospace, "Cascadia Code", Consolas, monospace';
export const CODE_FONT_MAX = 64;

/** Remove the characters that can break the CSS value. An empty result means the default font. */
export function cleanFontName(name: string): string {
  return name
    .replace(/["'`;{}()<>\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CODE_FONT_MAX);
}

/** The CSS font stack for a code font name. */
export function codeFontStack(name: string): string {
  const clean = cleanFontName(name);
  return clean ? `"${clean}", "JetBrains Mono", ${MONO_FALLBACK}` : `"JetBrains Mono", ${MONO_FALLBACK}`;
}

export function codeFont(): string {
  return cleanFontName(loadPref(CODE_FONT_PREF, ""));
}

/** The font stack of the code font now, for the editor and the terminal. */
export function codeFontFamily(): string {
  return codeFontStack(codeFont());
}

export function setCodeFont(name: string): void {
  const clean = cleanFontName(name);
  savePref(CODE_FONT_PREF, clean);
  document.documentElement.style.setProperty("--font-mono", codeFontStack(clean));
  notify();
}

// The Monaco themes of the editor and the diff view: one for the light theme, one for the dark theme.
export type LightCodeTheme = "harness-light" | "vs" | "hc-light";
export type DarkCodeTheme = "harness-dark" | "vs-dark" | "hc-black";
export const LIGHT_CODE_THEMES: [LightCodeTheme, string][] = [
  ["harness-light", "Harness light"],
  ["vs", "Visual Studio light"],
  ["hc-light", "High contrast light"],
];
export const DARK_CODE_THEMES: [DarkCodeTheme, string][] = [
  ["harness-dark", "Harness dark"],
  ["vs-dark", "Visual Studio dark"],
  ["hc-black", "High contrast dark"],
];
const LIGHT_CODE_PREF = "lightCodeTheme";
const DARK_CODE_PREF = "darkCodeTheme";

export function lightCodeTheme(): LightCodeTheme {
  const value = loadPref(LIGHT_CODE_PREF, "harness-light");
  return LIGHT_CODE_THEMES.find(([id]) => id === value)?.[0] ?? "harness-light";
}

export function darkCodeTheme(): DarkCodeTheme {
  const value = loadPref(DARK_CODE_PREF, "harness-dark");
  return DARK_CODE_THEMES.find(([id]) => id === value)?.[0] ?? "harness-dark";
}

export function setLightCodeTheme(value: LightCodeTheme): void {
  savePref(LIGHT_CODE_PREF, value);
  notify();
}

export function setDarkCodeTheme(value: DarkCodeTheme): void {
  savePref(DARK_CODE_PREF, value);
  notify();
}

/** The Monaco theme for the theme that shows now. */
export function codeTheme(): string {
  return currentTheme() === "light" ? lightCodeTheme() : darkCodeTheme();
}

// The accent color: the color of the primary buttons, links, and selected items. "white" is the
// default (black in the light theme). "clay" is the Claude orange of styles.css. A "#rrggbb" value
// is a custom color. The app sets the --accent tokens on the root element.
export type AccentPreset = "white" | "clay" | "blue" | "green" | "purple" | "pink";
export const ACCENT_PRESETS: [AccentPreset, string, string][] = [
  ["white", "White", "#faf9f5"],
  ["clay", "Clay", "#c6613f"],
  ["blue", "Blue", "#2a78d6"],
  ["green", "Green", "#2f9e5b"],
  ["purple", "Purple", "#8b5cf6"],
  ["pink", "Pink", "#d6457f"],
];
export const ACCENT_DEFAULT: AccentPreset = "white";
const ACCENT_PREF = "accentColor";
const ACCENT_VARS = ["--accent", "--accent-hover", "--accent-fill", "--accent-fill-hover", "--accent-text", "--accent-soft"] as const;
export type AccentTokens = Record<(typeof ACCENT_VARS)[number], string>;

const HEX = /^#[0-9a-f]{6}$/i;

/** A preset id, or a "#rrggbb" color. Other values give the default. */
export function cleanAccent(value: string): string {
  if (ACCENT_PRESETS.some(([id]) => id === value)) return value;
  return HEX.test(value) ? value.toLowerCase() : ACCENT_DEFAULT;
}

export function accentColor(): string {
  return cleanAccent(loadPref(ACCENT_PREF, ACCENT_DEFAULT));
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
/** Mix a color with white (to > 0) or with black (to < 0). */
const mix = (hex: string, to: number) => toHex(rgb(hex).map((v) => (to > 0 ? v + (255 - v) * to : v * (1 + to))));
const rgba = (hex: string, alpha: number) => `rgba(${rgb(hex).join(", ")}, ${alpha})`;

/** The relative luminance of a color (WCAG), from 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const DARK_TEXT = "#1f1e1d";

/** The text color on a fill of this color: dark text or white text, whichever has more contrast. */
export function textOn(hex: string): string {
  const l = luminance(hex);
  return contrast(l, luminance(DARK_TEXT)) > contrast(l, 1) ? DARK_TEXT : "#ffffff";
}

/** The accent tokens for a value and a theme. null: use the clay values of styles.css. */
export function accentTokens(value: string, theme: "light" | "dark"): AccentTokens | null {
  const accent = cleanAccent(value);
  if (accent === "clay") return null;
  if (accent === "white") {
    return theme === "dark"
      ? { "--accent": "#faf9f5", "--accent-hover": "#ffffff", "--accent-fill": "#faf9f5", "--accent-fill-hover": "#e6e4dc", "--accent-text": DARK_TEXT, "--accent-soft": "rgba(250, 249, 245, 0.12)" }
      : { "--accent": DARK_TEXT, "--accent-hover": "#000000", "--accent-fill": DARK_TEXT, "--accent-fill-hover": "#3a3936", "--accent-text": "#ffffff", "--accent-soft": "rgba(31, 30, 29, 0.08)" };
  }
  const base = HEX.test(accent) ? accent : ACCENT_PRESETS.find(([id]) => id === accent)![2];
  const l = luminance(base);
  // The accent is also a text color: make it lighter on the dark theme, darker on the light theme.
  const text = theme === "dark" ? (l < 0.2 ? mix(base, 0.35) : base) : l > 0.25 ? mix(base, -0.35) : base;
  return {
    "--accent": text,
    "--accent-hover": mix(text, theme === "dark" ? 0.15 : -0.15),
    "--accent-fill": base,
    "--accent-fill-hover": mix(base, -0.1),
    "--accent-text": textOn(base),
    "--accent-soft": rgba(base, theme === "dark" ? 0.14 : 0.1),
  };
}

function applyAccent(): void {
  const tokens = accentTokens(accentColor(), currentTheme());
  const root = document.documentElement.style;
  for (const name of ACCENT_VARS) {
    if (tokens) root.setProperty(name, tokens[name]);
    else root.removeProperty(name);
  }
}

export function setAccentColor(value: string): void {
  savePref(ACCENT_PREF, cleanAccent(value));
  applyAccent();
}

/** Put each appearance setting back to its default value. The theme stays as it is. */
export function resetAppearance(): void {
  setAccentColor(ACCENT_DEFAULT);
  setInterfaceFont("default");
  setChatFontSize(CHAT_FONT_DEFAULT);
  setTranscriptWidth("default");
  setDensity("compact");
  savePref(LIGHT_CODE_PREF, "harness-light");
  savePref(DARK_CODE_PREF, "harness-dark");
  setCodeFont(""); // This call also tells the editor and the terminal.
}

/** Set the appearance before the first paint, and follow the system theme. */
export function initTheme(): void {
  apply();
  applyAccent();
  const root = document.documentElement.style;
  root.setProperty("--chat-font-size", `${chatFontSize()}px`);
  root.setProperty("--font-sans", SANS_STACKS[interfaceFont()]);
  root.setProperty("--column", TRANSCRIPT_WIDTHS[transcriptWidth()]);
  root.setProperty("--font-mono", codeFontFamily());
  document.documentElement.dataset.density = density();
  system()?.addEventListener("change", apply);
}
