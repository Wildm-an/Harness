// The visuals of the agent, as the show_widget tool of the Claude app (daemon tools/visual.py).
// The agent calls show_visual with an HTML fragment or an <svg>. The chat draws it as its own
// item (VisualBlock.tsx) in a sandboxed iframe, not as a tool row.
//
// The iframe loads the page /visual-frame of the daemon. That page has its own CSP: inline scripts
// can run there, and the page has no network access. The app CSP blocks inline scripts, and an
// about:srcdoc frame gets the CSP of the app. The parent sends the document of this file to the
// page with postMessage. The frame has no allow-same-origin: it cannot read the app.

import type { ChatItem } from "../chat/state";

export const VISUAL_TOOL = "show_visual";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export interface Visual {
  id: string;
  title: string;
  code: string;
  loading: string[]; // The lines that show while the visual loads.
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** True for a show_visual call that the chat draws as a visual. A failed call stays a tool row. */
export function isVisualItem(item: ChatItem): boolean {
  return item.kind === "tool" && item.name === VISUAL_TOOL && item.status !== "error";
}

/** The visual of a show_visual call, or null if its input has no code. */
export function visualOf(item: ToolItem): Visual | null {
  if (item.name !== VISUAL_TOOL || item.status === "error") return null;
  const input = record(item.input);
  const code = typeof input?.code === "string" ? input.code : "";
  if (!code.trim()) return null;
  const title = typeof input?.title === "string" && input.title.trim() ? input.title.trim() : "visual";
  const loading = (Array.isArray(input?.loading_messages) ? input.loading_messages : [])
    .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    .map((m) => m.trim().slice(0, 80))
    .slice(0, 4);
  return { id: item.id, title, code, loading };
}

/** The file of a downloaded visual: an <svg> as .svg, else a full HTML page. */
export function visualFile(visual: Visual, theme: VisualTheme): { name: string; text: string; filter: { name: string; extensions: string[] } } {
  const name = visual.title.replace(/[^a-z0-9_]/gi, "_") || "visual";
  const code = visual.code.trim();
  if (/^<svg[\s>]/i.test(code)) {
    const svg = /xmlns=/.test(code.slice(0, 200)) ? code : code.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    return { name: `${name}.svg`, text: svg, filter: { name: "SVG image", extensions: ["svg"] } };
  }
  return { name: `${name}.html`, text: visualDocument(code, theme), filter: { name: "HTML page", extensions: ["html"] } };
}

// The CSS variables that a visual can use (the tool description lists them), and the app tokens
// that give their values. The values change with the theme.
export const VISUAL_VARS: Record<string, string> = {
  "--color-text": "--text",
  "--color-text-muted": "--text-muted",
  "--color-surface": "--surface",
  "--color-surface-2": "--surface-2",
  "--color-border": "--border",
  "--color-accent": "--accent-fill",
  "--color-accent-text": "--accent-text",
  "--color-success": "--success",
  "--color-danger": "--danger",
  "--color-warning": "--warning",
  "--font-sans": "--font-sans",
  "--font-mono": "--font-mono",
  "--radius": "--radius",
};

export type Theme = "light" | "dark";

export interface VisualTheme {
  theme: Theme;
  vars: Record<string, string>;
}

/** The values of VISUAL_VARS from the computed style of the app root. */
export function themeVars(style: Pick<CSSStyleDeclaration, "getPropertyValue">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, token] of Object.entries(VISUAL_VARS)) {
    const value = style.getPropertyValue(token).trim();
    if (value) out[name] = value;
  }
  return out;
}

// A CSS value must not close the style element or add a rule.
const safeValue = (v: string) => v.replace(/[<>{};]/g, "");

// The messages between the frame and the app.
export const MSG_READY = "harness-visual-ready"; // The frame page waits for the document.
export const MSG_DOC = "harness-visual-doc"; // App to frame page: the document to write.
export const MSG_THEME = "harness-visual-theme"; // App to visual: the new theme.
export const MSG_SIZE = "harness-visual-size"; // Visual to app: the height of the content.
export const MSG_PROMPT = "harness-visual-prompt"; // Visual to app: sendPrompt(text).

export const MAX_PROMPT = 4000;

// The script of the visual: sendPrompt, the height of the content, and the theme changes.
// sendPrompt works only in a user action, for example a click.
const HELPER = `(function () {
  var post = function (m) { parent.postMessage(m, "*"); };
  window.sendPrompt = function (text) {
    if (typeof text !== "string" || !text.trim()) return;
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    post({ type: "${MSG_PROMPT}", text: text.slice(0, ${MAX_PROMPT}) });
  };
  var last = -1;
  function size() {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h !== last) { last = h; post({ type: "${MSG_SIZE}", height: h }); }
  }
  addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== parent || !d || d.type !== "${MSG_THEME}") return;
    var root = document.documentElement;
    root.setAttribute("data-theme", d.theme);
    root.style.colorScheme = d.theme;
    for (var k in d.vars) root.style.setProperty(k, d.vars[k]);
  });
  document.addEventListener("DOMContentLoaded", function () {
    if (window.ResizeObserver) new ResizeObserver(size).observe(document.documentElement);
    size();
  });
  addEventListener("load", size);
})();`;

// The base style: the theme variables, and plain controls in the style of the app.
function baseStyle({ theme, vars }: VisualTheme): string {
  const decls = Object.entries(vars)
    .map(([k, v]) => `${k}: ${safeValue(v)};`)
    .join(" ");
  return `:root { color-scheme: ${theme}; ${decls} }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body { color: var(--color-text); font: 14px/1.5 var(--font-sans); overflow-x: hidden; }
body > svg:only-child { display: block; width: 100%; height: auto; }
button { font: inherit; color: var(--color-text); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 4px 12px; cursor: pointer; }
button:hover { background: var(--color-surface-2); }
button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
input, select, textarea { font: inherit; color: var(--color-text); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius); }
a { color: var(--color-accent); }
code, pre, kbd { font-family: var(--font-mono); font-size: 0.92em; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }`;
}

/** The full document of a visual: the base style, the helper script, and the code of the agent. */
export function visualDocument(code: string, theme: VisualTheme): string {
  return `<!doctype html>
<html data-theme="${theme.theme}"><head><meta charset="utf-8">
<style id="harness-base">${baseStyle(theme)}</style>
<script>${HELPER}</script>
</head><body>
${code}
</body></html>`;
}

export type FrameMessage = { kind: "ready" } | { kind: "size"; height: number } | { kind: "prompt"; text: string };

/** The message of a frame, or null for a message of another kind. */
export function frameMessage(data: unknown): FrameMessage | null {
  const d = record(data);
  if (!d) return null;
  if (d.type === MSG_READY) return { kind: "ready" };
  if (d.type === MSG_SIZE && typeof d.height === "number" && Number.isFinite(d.height)) return { kind: "size", height: d.height };
  if (d.type === MSG_PROMPT && typeof d.text === "string" && d.text.trim()) return { kind: "prompt", text: d.text.trim().slice(0, MAX_PROMPT) };
  return null;
}

// The height of a frame, in pixels. The limit stops a visual that grows with its frame.
export const MIN_HEIGHT = 24;
export const MAX_HEIGHT = 2400;

export function frameHeight(height: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(height)));
}

// The daemon that serves the frame page. The app CSP lets frames load only from a loopback host
// (frame-src in tauri.conf.json). For a daemon on another host, the frame uses srcdoc: SVG and
// CSS show, but scripts do not run in the installed app.
let frameOrigin: string | null = null;

export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Set the daemon of the app. Call it after each connection. */
export function setVisualDaemon(host: string, port: number): void {
  frameOrigin = isLoopback(host) && port > 0 ? `http://${host.includes(":") ? `[${host}]` : host}:${port}` : null;
}

/** The URL of the frame page, or null: the frame then uses srcdoc. */
export function visualFrameUrl(): string | null {
  return frameOrigin ? `${frameOrigin}/visual-frame` : null;
}
