// Browser annotations, as in the Claude app: the user points at elements of the page, writes a note
// for each, and the notes go into the prompt box with the element details. The agent then knows
// which part of the page the user means.
//
// The app runs ANNOTATE_SCRIPT in the page. A page of the Browser pane cannot call the app (it is not
// the app origin), so the script sends each note with a navigation to ANNOTATE_URL. The native
// webview stops that navigation and gives the data to the app (src-tauri/src/browser.rs). In a
// normal browser (development), the pane uses iframes: the script sends the note with postMessage.
//
// The annotation bar is in the page too: the page is a native window over the app, so a bar of the
// app cannot float over it. The bar is in a drawer at the bottom of the page. The handle on the bar
// slides it down out of the way, so the user can mark the part of the page behind it.
// Tools: element selection, a pen, shapes (line, arrow, rectangle, ellipse, numbered step), and text.
// No tool is on when the bar opens: the user picks one. The color and the line width show only for
// the tools that use them. "Add to prompt" puts a screenshot of the page with the marks into the
// prompt box.

import type { PromptAttachment } from "../components/PromptBox";

export type AnnotateTool = "none" | "select" | "pen" | "line" | "arrow" | "rect" | "ellipse" | "step" | "text";
export type ShapeTool = "line" | "arrow" | "rect" | "ellipse" | "step";

export const SHAPES: { id: ShapeTool; label: string }[] = [
  { id: "line", label: "Line" },
  { id: "arrow", label: "Arrow" },
  { id: "rect", label: "Rectangle" },
  { id: "ellipse", label: "Ellipse" },
  { id: "step", label: "Step" },
];

export const COLORS: [string, string][] = [
  ["#e5484d", "Red"],
  ["#f76b15", "Orange"],
  ["#ffc53d", "Yellow"],
  ["#30a46c", "Green"],
  ["#2a78d6", "Blue"],
  ["#8e4ec6", "Purple"],
  ["#ffffff", "White"],
  ["#111111", "Black"],
];

/** The line widths of the pen and the shapes, in pixels. */
export const WIDTHS: [number, string][] = [
  [2, "Thin"],
  [4, "Medium"],
  [7, "Thick"],
  [11, "Extra thick"],
];

/** The tools that use a color: the pen, the shapes, and text. The page script has the same rule. */
export function usesColor(tool: AnnotateTool): boolean {
  return tool !== "none" && tool !== "select";
}

/** The tools that use a line width: the pen and the shapes that are lines (not the numbered step). */
export function usesWidth(tool: AnnotateTool): boolean {
  return usesColor(tool) && tool !== "text" && tool !== "step";
}

// The icons of the bar: the inner SVG of the Lucide icons that the app uses (ISC license), and a step icon.
const ICONS: Record<string, string> = {
  select: '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
  pen: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  line: '<path d="M22 2 2 22"/>',
  arrow: '<path d="M13 5H19V11"/><path d="M19 5L5 19"/>',
  rect: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  ellipse: '<circle cx="12" cy="12" r="10"/>',
  step: '<circle cx="12" cy="12" r="9.5"/><text x="12" y="16.5" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor" stroke="none">1</text>',
  text: '<path d="M12 4v16"/><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2"/><path d="M9 20h6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  clear: '<path d="M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21"/><path d="m5.082 11.09 8.828 8.828"/>',
  image: '<path d="M16 5h6"/><path d="M19 2v6"/><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/><circle cx="9" cy="9" r="2"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

/** The app colors that the bar in the page uses (CSS variables of the app theme). */
const THEME_VARS = [
  "surface", "surface-2", "surface-sunken", "hover", "border", "border-strong", "text", "text-muted", "accent",
  "accent-soft", "accent-fill", "accent-fill-hover", "accent-text", "shadow", "font-sans", "radius", "radius-sm",
];

/** The values of the app theme for the bar in the page. */
export function annotateTheme(): Record<string, string> {
  const theme: Record<string, string> = {};
  if (typeof document === "undefined") return theme;
  const style = getComputedStyle(document.documentElement);
  for (const name of THEME_VARS) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (value) theme[name] = value;
  }
  return theme;
}

/** The start state of the bar in the page. */
export interface AnnotateOptions {
  shape: ShapeTool; // The shape of the shape button: the last shape that the user chose.
  color: string;
  width: number; // The line width of the pen and the shapes.
  capture: boolean; // False: "Add to prompt" needs the desktop app.
  theme: Record<string, string>;
}

const DEFAULT_OPTIONS: AnnotateOptions = { shape: "rect", color: COLORS[0][0], width: WIDTHS[1][0], capture: false, theme: {} };

/** The address that the page script opens to send a note. The webview blocks it (browser.rs). */
export const ANNOTATE_URL = "https://harness-annotate.invalid/";

/** A note of the user on one element of the page. */
export interface Annotation {
  n: number; // The number of the note in this annotation mode: the badge on the element.
  comment: string;
  url: string;
  title: string;
  tag: string; // For example: <button class="primary">
  text: string; // The visible text of the element, short.
  selector: string;
  size: string; // For example: 120×32 at 40,210
}

const MAX_TEXT = 160;

/** A message of the page script: a note, "stop", "add" (the screenshot), or "prefs" (the bar settings). */
export function pageMessage(data: unknown): (Record<string, unknown> & { type: string }) | null {
  let value: unknown = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return null;
  return value as Record<string, unknown> & { type: string };
}

/** Read a note from the data of the page. null: the data is not a note. */
export function parseAnnotation(data: unknown): Annotation | null {
  let value: unknown = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.type !== "note") return null;
  const str = (key: string, max = 2000) => (typeof v[key] === "string" ? (v[key] as string).slice(0, max) : "");
  const n = typeof v.n === "number" && Number.isFinite(v.n) ? Math.max(1, Math.round(v.n)) : 1;
  return {
    n,
    comment: str("comment"),
    url: str("url"),
    title: str("title", 200),
    tag: str("tag", 300),
    text: str("text", MAX_TEXT),
    selector: str("selector", 500),
    size: str("size", 80),
  };
}

/** The text for the prompt box: the element and the note, for the agent. */
export function annotationText(a: Annotation): string {
  const page = a.title ? `${a.url} ("${a.title}")` : a.url;
  const lines = [`[Browser annotation ${a.n}: ${page}]`, `Element: ${a.tag}${a.text ? ` "${a.text}"` : ""}`];
  if (a.selector) lines.push(`Selector: ${a.selector}`);
  if (a.size) lines.push(`Size and place: ${a.size}`);
  lines.push(`Note: ${a.comment || "(no note)"}`);
  return `\n${lines.join("\n")}\n`;
}

/** The thumbnail of a screenshot of the page with the marks of the user. The agent also gets a line about it. */
export function screenshotAttachment(image: string, url: string): PromptAttachment {
  return {
    id: `screenshot-${Date.now().toString(36)}`,
    label: "Screenshot",
    detail: url,
    text: `[A screenshot of the Browser pane${url ? ` (${url})` : ""}. The lines, shapes, steps, and text on it are marks of the user.]`,
    image,
  };
}

/** The chip of a note in the prompt box: short in the box, the full text for the agent. */
export function annotationAttachment(a: Annotation): PromptAttachment {
  const element = a.selector.split(" > ").pop() || a.tag;
  const note = a.comment.length > 60 ? `${a.comment.slice(0, 59)}…` : a.comment;
  return {
    id: `annotation-${a.n}-${Date.now().toString(36)}`,
    label: `Annotation ${a.n}`,
    detail: note ? `${element} — ${note}` : element,
    text: annotationText(a),
  };
}

/**
 * The script that starts or stops the annotation mode in the page. ``send``: "nav" for the
 * webview of the desktop app, "post" for an iframe (postMessage to the parent).
 */
export function annotateScript(on: boolean, send: "nav" | "post", options: Partial<AnnotateOptions> = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options, icons: ICONS, shapes: SHAPES, colors: COLORS, widths: WIDTHS };
  return `(${pageScript.toString()})(${JSON.stringify(on)}, ${JSON.stringify(send)}, ${JSON.stringify(ANNOTATE_URL)}, ${JSON.stringify(opts)});`;
}

/** A call of the page script while the mode runs: clear, capture ("prepare"), or the busy state of "Add to prompt". */
export function annotateCall(method: "clear" | "prepare" | "busy", ...args: (string | boolean | number)[]): string {
  return `window.__harnessAnnotate && window.__harnessAnnotate.${method}(${args.map((a) => JSON.stringify(a)).join(",")});`;
}

// The page script. It runs in the page, not in the app: it can use only the page globals.
// Tools: "none" (the page works as usual), "select" (an element and a note), "pen", "line", "arrow", "rect", "ellipse", "step", "text".
/* eslint-disable */
function pageScript(on: boolean, send: string, sendUrl: string, opts: any) {
  const KEY = "__harnessAnnotate";
  const w = window as any;
  if (w[KEY]) w[KEY].stop();
  if (!on) return;
  const SVG = "http://www.w3.org/2000/svg";

  const host = document.createElement("div");
  host.setAttribute("data-harness-annotate", "");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  // The colors of the app theme. A value cannot end the CSS rule.
  const themeCss = Object.entries((opts.theme || {}) as Record<string, string>)
    .map(([k, v]) => `--${k.replace(/[^a-z0-9-]/gi, "")}:${String(v).replace(/[;{}<>]/g, "")};`)
    .join("");
  root.innerHTML = `<style>
    :host{all:initial}
    .ui{--surface:#30302e;--surface-2:#3a3a37;--surface-sunken:#1f1e1d;--hover:rgba(250,249,245,.06);--border:#45443f;--border-strong:#5a5852;--text:#faf9f5;--text-muted:#a8a59c;--accent:#d97757;--accent-soft:rgba(217,119,87,.14);--accent-fill:#faf9f5;--accent-fill-hover:#e8e6dc;--accent-text:#1f1e1d;--shadow:0 12px 32px rgba(0,0,0,.35);--font-sans:system-ui,-apple-system,"Segoe UI",sans-serif;--radius:8px;--radius-sm:6px;${themeCss}}
    .dock{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;max-width:calc(100vw - 24px);pointer-events:auto;transition:transform .22s cubic-bezier(.2,.8,.2,1);font:13px/1.4 var(--font-sans);color:var(--text);-webkit-user-select:none;user-select:none}
    .dock.closed{transform:translate(-50%,calc(100% - 16px))}
    .dock.closed .bar{box-shadow:none}
    .dock button{font:inherit;color:inherit;margin:0}
    .handle{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;gap:6px;width:48px;height:16px;margin-bottom:-1px;padding:0;box-sizing:border-box;border:1px solid var(--border);border-bottom:none;border-radius:8px 8px 0 0;background:var(--surface-2);color:var(--text-muted);cursor:pointer;touch-action:none}
    .handle:hover{color:var(--text)}
    .dock.closed .handle{width:auto;height:28px;padding:0 12px;border-color:var(--border-strong);color:var(--text)!important;font:500 12px var(--font-sans)!important;box-shadow:0 -2px 12px rgba(0,0,0,.3);cursor:grab}
    .handle svg{transition:transform .22s}
    .dock.closed .handle svg{transform:rotate(180deg)}
    .bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:2px;max-width:100%;box-sizing:border-box;padding:4px;border:1px solid var(--border);border-radius:12px;background:var(--surface-2);box-shadow:0 4px 16px rgba(0,0,0,.25)}
    .tool{display:inline-flex;align-items:center;justify-content:center;gap:3px;min-width:32px;height:30px;padding:0 7px;box-sizing:border-box;border:1px solid transparent;border-radius:var(--radius);background:transparent;color:var(--text-muted)!important;cursor:pointer}
    .tool:hover{background:var(--hover);color:var(--text)!important}
    .tool.active{border-color:color-mix(in srgb,var(--accent) 40%,transparent);background:var(--accent-soft);color:var(--accent)!important}
    .sep{width:1px;height:18px;margin:0 4px;background:var(--border)}
    .add{display:inline-flex;align-items:center;gap:6px;min-height:26px;margin:0 2px!important;padding:0 8px;box-sizing:border-box;border:1px solid var(--accent-fill);border-radius:var(--radius-sm);background:var(--accent-fill);color:var(--accent-text)!important;font:500 12px var(--font-sans)!important;cursor:pointer}
    .add:hover:not(:disabled){border-color:var(--accent-fill-hover);background:var(--accent-fill-hover)}
    .add:disabled{opacity:.55;cursor:not-allowed}
    .add .ico{display:none}
    .add.busy .ico{display:inline-flex}
    @media (max-width:520px){.add .txt{display:none}.add .ico{display:inline-flex}}
    .spin{animation:harness-spin 1s linear infinite}
    @keyframes harness-spin{to{transform:rotate(360deg)}}
    .mwrap{position:relative}
    .menu{position:absolute;bottom:calc(100% + 6px);left:0;min-width:160px;padding:4px;box-sizing:border-box;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow)}
    .item{display:flex;align-items:center;gap:10px;width:100%;min-height:30px;padding:0 10px;box-sizing:border-box;border:none;border-radius:var(--radius-sm);background:transparent;color:var(--text)!important;font:13px var(--font-sans)!important;text-align:left;white-space:nowrap;cursor:pointer}
    .item:hover{background:var(--surface-2)}
    .colors{display:grid;grid-template-columns:repeat(4,24px);gap:8px;padding:6px}
    .swatch{width:24px;height:24px;padding:0;box-sizing:border-box;border:1px solid var(--border-strong);border-radius:50%;cursor:pointer}
    .swatch.active{outline:2px solid var(--accent);outline-offset:2px}
    .dot{display:inline-block;width:14px;height:14px;box-sizing:border-box;border:1px solid var(--border-strong);border-radius:50%}
    .wline{display:inline-block;width:18px;border-radius:999px;background:currentColor}
    .item .wline{width:28px}
    .check{display:inline-flex;width:14px;margin-left:auto;color:var(--accent)}
    .tip{position:fixed;display:none;align-items:baseline;gap:10px;max-width:320px;padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-sunken);box-shadow:var(--shadow);color:var(--text);font:400 12.5px/1.4 var(--font-sans);white-space:nowrap;pointer-events:none}
    .tip .key{color:var(--text-muted)}
    .box{position:fixed;border:2px solid #2a78d6;background:rgba(42,120,214,.12);border-radius:3px;pointer-events:none;display:none}
    .tag{position:fixed;padding:2px 6px;border-radius:4px;background:#2a78d6;color:#fff;font:12px/1.4 system-ui,sans-serif;pointer-events:none;display:none;white-space:nowrap}
    .badge{position:absolute;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:10px;background:#2a78d6;color:#fff;font:600 12px/20px system-ui,sans-serif;text-align:center;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.3)}
    .pop{position:fixed;width:280px;padding:10px;border-radius:10px;background:#1f1f1e;color:#f0efec;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.35);font:13px/1.4 system-ui,sans-serif;pointer-events:auto;display:none}
    .pop textarea{box-sizing:border-box;width:100%;min-height:64px;resize:vertical;padding:6px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:#151515;color:inherit;font:inherit}
    .pop .row{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
    .pop button{padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:transparent;color:inherit;font:inherit;cursor:pointer}
    .pop button.primary{background:#2a78d6;border-color:#2a78d6;color:#fff}
    .hint{position:fixed;left:50%;top:12px;transform:translateX(-50%);padding:6px 12px;border-radius:8px;background:rgba(20,20,20,.9);color:#fff;font:12px/1.4 system-ui,sans-serif;pointer-events:none}
    svg.draw{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
    svg.draw.active{pointer-events:auto;cursor:crosshair}
    .textin{position:fixed;min-width:120px;padding:2px 4px;border:1px dashed currentColor;background:rgba(0,0,0,.35);font:600 16px/1.3 system-ui,sans-serif;outline:none;pointer-events:auto}
  </style>
  <svg class="draw"><defs></defs><g class="shapes"></g></svg>
  <div class="box"></div><div class="tag"></div><div class="badges"></div>
  <div class="pop" role="dialog" aria-label="Note for the agent">
    <textarea placeholder="What should the agent know about this element?"></textarea>
    <div class="row"><button type="button" class="cancel">Cancel</button><button type="button" class="primary add">Add to prompt</button></div>
  </div>
  <div class="hint"></div>
  <div class="ui"><div class="dock"><button type="button" class="handle" data-act="drawer"></button><div class="bar" role="toolbar" aria-label="Annotate"></div></div><div class="tip" role="tooltip"></div></div>`;
  document.documentElement.appendChild(host);
  const box = root.querySelector(".box") as HTMLElement;
  const tag = root.querySelector(".tag") as HTMLElement;
  const pop = root.querySelector(".pop") as HTMLElement;
  const area = root.querySelector("textarea") as HTMLTextAreaElement;
  const badges = root.querySelector(".badges") as HTMLElement;
  const hint = root.querySelector(".hint") as HTMLElement;
  const svg = root.querySelector("svg.draw") as SVGSVGElement;
  const defs = svg.querySelector("defs") as SVGDefsElement;
  const shapes = svg.querySelector("g.shapes") as SVGGElement;
  const dock = root.querySelector(".dock") as HTMLElement;
  const handle = root.querySelector(".handle") as HTMLElement;
  const bar = root.querySelector(".bar") as HTMLElement;
  const tip = root.querySelector(".tip") as HTMLElement;
  let tool = "none"; // No tool at the start: the user picks one in the bar.
  let shape: string = opts.shape;
  let color: string = opts.color;
  let width: number = opts.width; // The line width of the pen and the shapes.
  let menu: string | null = null; // The open menu of the bar: "shape", "color", or "width".
  let busy = false; // The screenshot of "Add to prompt" is in progress.
  let closed = false; // The drawer is down: only its handle shows.
  let picked: Element | null = null;
  let count = 0;
  let steps = 0;
  const marks: { el: Element; badge: HTMLElement }[] = [];
  const HINTS: Record<string, string> = {
    none: "Pick a tool in the bar. Esc stops.",
    select: "Click an element to add a note for the agent. Esc stops.",
    pen: "Draw on the page. Esc stops.",
    text: "Click to add text. Esc stops.",
    step: "Click to add a numbered step. Esc stops.",
  };
  const showHint = () => {
    hint.textContent = HINTS[tool] || "Drag to draw the shape. Esc stops.";
  };
  showHint();

  const el = (name: string, attrs: Record<string, string | number>) => {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };
  // One arrow head for each color.
  const marker = (c: string) => {
    const id = `harness-arrow-${c.replace(/[^a-z0-9]/gi, "")}`;
    if (!defs.querySelector(`#${id}`)) {
      const m = el("marker", { id, viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" });
      m.appendChild(el("path", { d: "M0,0 L10,5 L0,10 z", fill: c }));
      defs.appendChild(m);
    }
    return `url(#${id})`;
  };
  const stroke = () => ({ stroke: color, "stroke-width": width, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" });

  const describe = (node: Element) => {
    const cls = Array.from(node.classList).slice(0, 3).join(" ");
    const id = node.id ? ` id="${node.id}"` : "";
    return `<${node.tagName.toLowerCase()}${id}${cls ? ` class="${cls}"` : ""}>`;
  };
  const selector = (start: Element) => {
    const parts: string[] = [];
    let node: Element | null = start;
    while (node && node !== document.documentElement && parts.length < 6) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      part += Array.from(node.classList).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const target = (x: number, y: number) => {
    const found = document.elementFromPoint(x, y);
    return found && found !== host && !host.contains(found) ? found : null;
  };
  const place = (node: Element) => {
    const r = node.getBoundingClientRect();
    box.style.cssText += `;display:block;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    tag.textContent = `${node.tagName.toLowerCase()} ${Math.round(r.width)}×${Math.round(r.height)}`;
    tag.style.cssText += `;display:block;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 22)}px`;
  };
  const hideBox = () => {
    box.style.display = "none";
    tag.style.display = "none";
  };
  const placeBadges = () => {
    // The layer is fixed to the window: the badges use window positions, again after each scroll.
    for (const m of marks) {
      const r = m.el.getBoundingClientRect();
      m.badge.style.left = `${r.left - 8}px`;
      m.badge.style.top = `${r.top - 8}px`;
    }
  };
  badges.style.cssText = "position:fixed;left:0;top:0";
  const deliver = (data: object) => {
    const text = JSON.stringify(data);
    if (send === "post") window.parent.postMessage({ __harnessAnnotation: text }, "*");
    else window.location.href = `${sendUrl}#${encodeURIComponent(text)}`;
  };
  const closePop = () => {
    pop.style.display = "none";
    picked = null;
    area.value = "";
  };
  const add = () => {
    if (!picked) return;
    const node = picked;
    const r = node.getBoundingClientRect();
    count += 1;
    deliver({
      type: "note",
      n: count,
      comment: area.value.trim(),
      url: location.href,
      title: document.title,
      tag: describe(node),
      text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
      selector: selector(node),
      size: `${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.left + window.scrollX)},${Math.round(r.top + window.scrollY)}`,
    });
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = String(count);
    badges.appendChild(badge);
    marks.push({ el: node, badge });
    placeBadges();
    closePop();
  };

  // The bar. Each change of its state draws it again.
  const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const icon = (name: string, size = 15, cls = "") =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${cls ? ` class="${cls}"` : ""}>${opts.icons[name] || ""}</svg>`;
  const usesColor = (t: string) => t !== "none" && t !== "select";
  const usesWidth = (t: string) => usesColor(t) && t !== "text" && t !== "step";
  const wline = (px: number) => `<span class="wline" style="height:${Math.max(2, Math.min(px, 10))}px"></span>`;
  const button = (act: string, label: string, inner: string, extra = "", key = "") =>
    `<button type="button" class="tool" data-act="${act}" data-tip="${esc(label)}"${key ? ` data-key="${esc(key)}"` : ""} aria-label="${esc(label)}" ${extra}>${inner}</button>`;
  const toolButton = (id: string, label: string) =>
    button(`tool:${id}`, label, icon(id), `aria-pressed="${tool === id}"`).replace('class="tool"', `class="tool${tool === id ? " active" : ""}"`);
  const menuButton = (id: string, label: string, inner: string, active = false) =>
    button(`menu:${id}`, label, inner + icon("chevron", 12), `aria-haspopup="menu" aria-expanded="${menu === id}"`).replace(
      'class="tool"',
      `class="tool${active ? " active" : ""}"`,
    );
  const render = () => {
    hideTip();
    const current = opts.shapes.find((s: any) => s.id === shape) || opts.shapes[2];
    const isShape = opts.shapes.some((s: any) => s.id === tool);
    const widthName = (opts.widths.find((x: any) => x[0] === width) || [0, "Medium"])[1];
    let html = toolButton("select", "Select an element and add a note") + toolButton("pen", "Pen");
    html += `<div class="mwrap">${menuButton("shape", `Shape: ${current.label}`, icon(current.id), isShape)}`;
    if (menu === "shape") {
      html += `<div class="menu" role="menu">${opts.shapes
        .map((s: any) => `<button type="button" class="item" role="menuitemradio" aria-checked="${tool === s.id}" data-act="shape:${s.id}">${icon(s.id)} ${esc(s.label)}</button>`)
        .join("")}</div>`;
    }
    html += `</div>${toolButton("text", "Text")}`;
    if (usesColor(tool)) {
      html += `<span class="sep"></span><div class="mwrap">${menuButton("color", "Color", `<span class="dot" style="background:${esc(color)}"></span>`)}`;
      if (menu === "color") {
        html += `<div class="menu" role="menu"><div class="colors" role="group" aria-label="Colors">${opts.colors
          .map(
            ([value, name]: [string, string]) =>
              `<button type="button" class="swatch${color === value ? " active" : ""}" role="menuitemradio" aria-checked="${color === value}" aria-label="${esc(name)}" data-tip="${esc(name)}" data-act="color:${esc(value)}" style="background:${esc(value)}"></button>`,
          )
          .join("")}</div></div>`;
      }
      html += "</div>";
    }
    if (usesWidth(tool)) {
      html += `<div class="mwrap">${menuButton("width", `Line width: ${widthName}`, wline(width))}`;
      if (menu === "width") {
        html += `<div class="menu" role="menu">${opts.widths
          .map(
            ([value, name]: [number, string]) =>
              `<button type="button" class="item" role="menuitemradio" aria-checked="${width === value}" aria-label="${esc(name)}" data-tip="${esc(name)}" data-act="width:${value}">${wline(value)}<span class="check">${width === value ? icon("check", 14) : ""}</span></button>`,
          )
          .join("")}</div>`;
      }
      html += "</div>";
    }
    html += `<span class="sep"></span>${button("undo", "Undo the last mark", icon("undo"))}${button("clear", "Clear all marks", icon("clear"))}<span class="sep"></span>`;
    const addTip = opts.capture ? "Put a screenshot of the page with the marks into the prompt" : "The screenshot needs the desktop app";
    html += `<button type="button" class="add${busy ? " busy" : ""}" data-act="add" data-tip="${esc(addTip)}" aria-label="Add to prompt"${busy || !opts.capture ? " disabled" : ""}>${
      busy ? icon("loader", 13, "ico spin") : icon("image", 13, "ico")
    }<span class="txt">Add to prompt</span></button>`;
    html += button("done", "Done", icon("close"), "", "Esc");
    bar.innerHTML = html;
    // The closed drawer: a tab at the bottom edge to pull the bar back out (a click or a drag up).
    handle.innerHTML = closed ? `${icon("pen", 13)}<span>Annotate</span>${icon("chevron", 14)}` : icon("chevron", 14);
    const handleTip = closed ? "Show the annotation bar" : "Hide the annotation bar";
    handle.setAttribute("data-tip", handleTip);
    handle.setAttribute("aria-label", handleTip);
    handle.setAttribute("aria-expanded", String(!closed));
    dock.classList.toggle("closed", closed);
  };
  // The hover tip: the same look as the tips of the app (a small dark box, the key in a muted color).
  const hideTip = () => {
    tip.style.display = "none";
  };
  const showTip = (node: HTMLElement) => {
    const text = node.getAttribute("data-tip");
    // With a menu open, only the items of the menu show a tip: a tip must not cover the menu.
    if (!text || (menu && !node.closest(".menu"))) return hideTip();
    const key = node.getAttribute("data-key");
    tip.innerHTML = `<span>${esc(text)}</span>${key ? `<span class="key">${esc(key)}</span>` : ""}`;
    tip.style.display = "flex";
    const r = node.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8)}px`;
    tip.style.top = `${Math.max(8, r.top - t.height - 8)}px`;
  };
  dock.addEventListener("mouseover", (e) => {
    const node = (e.target as Element).closest("[data-tip]") as HTMLElement | null;
    if (node) showTip(node);
    else hideTip();
  });
  dock.addEventListener("mouseleave", hideTip);
  const report = () => deliver({ type: "prefs", shape, color, width });
  const applyTool = () => {
    svg.classList.toggle("active", tool !== "select" && tool !== "none");
    if (tool !== "select") {
      closePop();
      hideBox();
    }
    showHint();
  };
  const undo = () => {
    const last = shapes.lastElementChild;
    if (!last) return;
    if (last.tagName === "g") steps = Math.max(0, steps - 1);
    last.remove();
  };
  const clear = () => {
    shapes.textContent = "";
    steps = 0;
  };
  dock.addEventListener("click", (e) => {
    const node = (e.target as Element).closest("[data-act]") as HTMLElement | null;
    if (!node || (node as HTMLButtonElement).disabled) return;
    const [act, value] = (node.getAttribute("data-act") || "").split(/:(.*)/s);
    if (act !== "menu") menu = null;
    if (act === "tool") {
      tool = tool === value ? "none" : value;
      applyTool();
    } else if (act === "menu") {
      menu = menu === value ? null : value;
    } else if (act === "shape") {
      shape = value;
      tool = value;
      applyTool();
      report();
    } else if (act === "color") {
      color = value;
      report();
    } else if (act === "width") {
      width = Number(value) || width;
      report();
    } else if (act === "undo") undo();
    else if (act === "clear") clear();
    else if (act === "add") {
      if (opts.capture && !busy) deliver({ type: "add" });
    } else if (act === "drawer") {
      if (e.detail !== 0) return; // A pointer: the pointerup of the handle did it. 0: the keyboard.
      closed = !closed;
    } else if (act === "done") {
      stop();
      deliver({ type: "stop" });
      return;
    }
    render();
  });
  // The handle: a click opens or closes the drawer. A drag up opens it, and a drag down closes it.
  let dragFrom: number | null = null;
  handle.addEventListener("pointerdown", (e) => {
    dragFrom = e.clientY;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointerup", (e) => {
    if (dragFrom === null) return;
    const dy = e.clientY - dragFrom;
    dragFrom = null;
    menu = null;
    closed = Math.abs(dy) > 6 ? dy > 0 : !closed;
    render();
  });
  handle.addEventListener("pointercancel", () => {
    dragFrom = null;
  });
  // A click out of an open menu closes it.
  const onOutside = (e: Event) => {
    if (menu && !e.composedPath().includes(dock)) {
      menu = null;
      render();
    }
  };
  const inDock = (e: Event) => e.composedPath().includes(dock);

  // Drawing: the SVG layer takes the pointer for every tool except "none" and "select".
  let drawing: SVGElement | null = null;
  let from = { x: 0, y: 0 };
  let points: string[] = [];
  const shapeAt = (x: number, y: number) => {
    const a = from;
    if (tool === "line" || tool === "arrow") {
      const line = drawing || el("line", { ...stroke(), x1: a.x, y1: a.y });
      line.setAttribute("x2", String(x));
      line.setAttribute("y2", String(y));
      if (tool === "arrow") line.setAttribute("marker-end", marker(color));
      return line;
    }
    if (tool === "rect") {
      const rect = drawing || el("rect", { ...stroke(), rx: 4 });
      rect.setAttribute("x", String(Math.min(a.x, x)));
      rect.setAttribute("y", String(Math.min(a.y, y)));
      rect.setAttribute("width", String(Math.abs(x - a.x)));
      rect.setAttribute("height", String(Math.abs(y - a.y)));
      return rect;
    }
    if (tool === "ellipse") {
      const e = drawing || el("ellipse", stroke());
      e.setAttribute("cx", String((a.x + x) / 2));
      e.setAttribute("cy", String((a.y + y) / 2));
      e.setAttribute("rx", String(Math.abs(x - a.x) / 2));
      e.setAttribute("ry", String(Math.abs(y - a.y) / 2));
      return e;
    }
    // "pen": a path through the points.
    points.push(`${x},${y}`);
    const path = drawing || el("path", stroke());
    path.setAttribute("d", `M${points.join(" L")}`);
    return path;
  };
  const addText = (x: number, y: number) => {
    const input = document.createElement("div");
    input.className = "textin";
    input.contentEditable = "true";
    input.style.cssText += `;left:${x}px;top:${y - 12}px;color:${color}`;
    root.appendChild(input);
    setTimeout(() => input.focus(), 0);
    const done = () => {
      const value = (input.textContent || "").trim();
      input.remove();
      if (!value) return;
      const t = el("text", { x, y: y + 6, fill: color, stroke: "rgba(0,0,0,.55)", "stroke-width": 3, "paint-order": "stroke", style: "font:600 16px system-ui,sans-serif" });
      t.textContent = value;
      shapes.appendChild(t);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        input.textContent = "";
        input.blur();
      }
    });
    input.addEventListener("blur", done, { once: true });
  };
  const addStep = (x: number, y: number) => {
    steps += 1;
    const g = el("g", {});
    g.appendChild(el("circle", { cx: x, cy: y, r: 13, fill: color, stroke: "#fff", "stroke-width": 2 }));
    const t = el("text", { x, y: y + 5, fill: "#fff", "text-anchor": "middle", style: "font:700 14px system-ui,sans-serif" });
    t.textContent = String(steps);
    g.appendChild(t);
    shapes.appendChild(g);
  };
  svg.addEventListener("pointerdown", (e) => {
    if (tool === "select" || tool === "none") return;
    e.preventDefault();
    e.stopPropagation();
    if (tool === "text") return addText(e.clientX, e.clientY);
    if (tool === "step") return addStep(e.clientX, e.clientY);
    from = { x: e.clientX, y: e.clientY };
    points = [];
    drawing = shapeAt(e.clientX, e.clientY);
    shapes.appendChild(drawing);
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (drawing) shapeAt(e.clientX, e.clientY);
  });
  svg.addEventListener("pointerup", () => {
    drawing = null;
  });

  const onMove = (e: MouseEvent) => {
    if (picked || tool !== "select") return;
    if (inDock(e)) return hideBox();
    const found = target(e.clientX, e.clientY);
    if (found) place(found);
  };
  const onClick = (e: MouseEvent) => {
    if (tool !== "select") return;
    if (e.composedPath().includes(pop) || inDock(e)) return; // A click in the note box or in the bar.
    e.preventDefault();
    e.stopPropagation();
    const found = target(e.clientX, e.clientY);
    if (!found) return;
    picked = found;
    place(found);
    const r = found.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), window.innerWidth - 296);
    const below = r.bottom + 8 + 130 < window.innerHeight;
    pop.style.cssText += `;display:block;left:${left}px;top:${below ? r.bottom + 8 : Math.max(8, r.top - 138)}px`;
    area.focus();
  };
  const block = (e: Event) => {
    if (tool !== "select" || e.composedPath().includes(pop) || inDock(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (menu) {
        menu = null;
        render();
      } else if (picked) closePop();
      else {
        stop();
        deliver({ type: "stop" });
      }
    } else if (e.key === "Enter" && !e.shiftKey && picked && e.composedPath().includes(area)) {
      e.preventDefault();
      add();
    }
  };
  (root.querySelector(".pop .add") as HTMLElement).addEventListener("click", add);
  (root.querySelector(".pop .cancel") as HTMLElement).addEventListener("click", closePop);
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("mousedown", block, true);
  document.addEventListener("mouseup", block, true);
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", placeBadges, true);
  window.addEventListener("resize", placeBadges);
  const stop = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousedown", block, true);
    document.removeEventListener("mouseup", block, true);
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", placeBadges, true);
    window.removeEventListener("resize", placeBadges);
    host.remove();
    delete w[KEY];
  };
  render();
  w[KEY] = {
    stop,
    clear,
    // "Add to prompt" shows a spinner while the app takes the screenshot.
    busy(on: boolean) {
      busy = on;
      render();
    },
    // Before a screenshot: hide the hint, the bar, the outline, and the note box. After it: show them again.
    prepare(capture: boolean) {
      hint.style.display = capture ? "none" : "";
      dock.style.display = capture ? "none" : "";
      hideTip();
      if (capture) {
        closePop();
        hideBox();
      }
    },
  };
}
/* eslint-enable */
