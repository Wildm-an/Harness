// Browser annotations, as in the Claude app: the user points at elements of the page, writes a note
// for each, and the notes go into the prompt box with the element details. The agent then knows
// which part of the page the user means.
//
// The app runs ANNOTATE_SCRIPT in the page. A page of the Browser pane cannot call the app (it is not
// the app origin), so the script sends each note with a navigation to ANNOTATE_URL. The native
// webview stops that navigation and gives the data to the app (src-tauri/src/browser.rs). In a
// normal browser (development), the pane uses iframes: the script sends the note with postMessage.
//
// The annotation bar is in the app, under the page, as in the Claude app (AnnotateBar.tsx). The pane
// gives the bar its own space at the bottom: the page gets smaller, so the bar covers no part of it.
// The bar sends each choice to the page script with annotateCall. The page script draws the marks,
// the outline of the element, the note box, and the hint.
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

/** The start state of the page script: the color and the line width of the bar. */
export interface AnnotateOptions {
  color: string;
  width: number; // The line width of the pen and the shapes.
}

const DEFAULT_OPTIONS: AnnotateOptions = { color: COLORS[0][0], width: WIDTHS[1][0] };

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

/** A message of the page script: a note, or "stop" (Esc in the page). */
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
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return `(${pageScript.toString()})(${JSON.stringify(on)}, ${JSON.stringify(send)}, ${JSON.stringify(ANNOTATE_URL)}, ${JSON.stringify(opts)});`;
}

/** A call of the page script while the mode runs: a choice of the bar, undo, clear, or capture ("prepare"). */
export type AnnotateMethod = "setTool" | "setColor" | "setWidth" | "undo" | "clear" | "prepare";

export function annotateCall(method: AnnotateMethod, ...args: (string | boolean | number)[]): string {
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
  root.innerHTML = `<style>
    :host{all:initial}
    .box{position:fixed;border:2px solid #2a78d6;background:rgba(42,120,214,.12);border-radius:2px;pointer-events:none;display:none}
    .tag{position:fixed;padding:2px 6px;border-radius:2px;background:#2a78d6;color:#fff;font:12px/1.4 system-ui,sans-serif;pointer-events:none;display:none;white-space:nowrap}
    .badge{position:absolute;min-width:20px;height:20px;padding:0 5px;box-sizing:border-box;border-radius:2px;background:#2a78d6;color:#fff;font:600 12px/20px system-ui,sans-serif;text-align:center;pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.3)}
    .pop{position:fixed;width:280px;padding:10px;border-radius:2px;background:#1f1f1e;color:#f0efec;border:1px solid rgba(255,255,255,.12);box-shadow:0 8px 24px rgba(0,0,0,.35);font:13px/1.4 system-ui,sans-serif;pointer-events:auto;display:none}
    .pop textarea{box-sizing:border-box;width:100%;min-height:64px;resize:vertical;padding:6px 8px;border-radius:2px;border:1px solid rgba(255,255,255,.2);background:#151515;color:inherit;font:inherit}
    .pop .row{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
    .pop button{padding:4px 10px;border-radius:2px;border:1px solid rgba(255,255,255,.2);background:transparent;color:inherit;font:inherit;cursor:pointer}
    .pop button.primary{background:#2a78d6;border-color:#2a78d6;color:#fff}
    .hint{position:fixed;left:50%;top:12px;transform:translateX(-50%);padding:6px 12px;border-radius:2px;background:rgba(20,20,20,.9);color:#fff;font:12px/1.4 system-ui,sans-serif;pointer-events:none}
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
  <div class="hint"></div>`;
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
  let tool = "none"; // No tool at the start: the user picks one in the bar.
  let color: string = opts.color;
  let width: number = opts.width; // The line width of the pen and the shapes.
  let picked: Element | null = null;
  let count = 0;
  let steps = 0;
  const marks: { el: Element; badge: HTMLElement }[] = [];
  const HINTS: Record<string, string> = {
    none: "Pick a tool in the bar under the page. Esc stops.",
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
    const found = target(e.clientX, e.clientY);
    if (found) place(found);
  };
  const onClick = (e: MouseEvent) => {
    if (tool !== "select") return;
    if (e.composedPath().includes(pop)) return; // A click in the note box.
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
    if (tool !== "select" || e.composedPath().includes(pop)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (picked) closePop();
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
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", placeBadges, true);
  window.addEventListener("resize", placeBadges);
  const stop = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("mousedown", block, true);
    document.removeEventListener("mouseup", block, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", placeBadges, true);
    window.removeEventListener("resize", placeBadges);
    host.remove();
    delete w[KEY];
  };
  w[KEY] = {
    stop,
    clear,
    undo,
    // The choices of the bar in the app (AnnotateBar.tsx).
    setTool(next: string) {
      tool = next;
      applyTool();
    },
    setColor(next: string) {
      color = next;
    },
    setWidth(next: number) {
      width = next;
    },
    // Before a screenshot: hide the hint, the outline, and the note box. After it: show them again.
    prepare(capture: boolean) {
      hint.style.display = capture ? "none" : "";
      if (capture) {
        closePop();
        hideBox();
      }
    },
  };
}
/* eslint-enable */
