import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { nativeRects, type ScreenRect } from "../lib/overlay";

// All hover tips of the app use this one style, as in Claude: a small dark box, with the key
// of the action in muted text. The components keep the `title` attribute. While the pointer
// is on an element, this layer removes the `title` (so the system tip does not show) and
// shows the tip. It puts the `title` back when the pointer leaves.
// An element in a `data-native-tip` container keeps the system tip (the window buttons).

const SHOW_DELAY = 500;
/** A tip shows at once if the last tip closed less than this time ago. */
const WARM_TIME = 400;
const GAP = 6;
const EDGE = 8;

/** Splits "Close the sidebar (Ctrl+B)" into the text and the key. */
const TIP_CHARS = 160;

/** A short hover tip of a long text: its first line, 160 characters or less, with "…" when text is cut.
 * A tip never shows the full content of a file or of a long command (the user asked for this). */
export function shortTip(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const first = lines[0]?.trim() ?? "";
  if (first.length > TIP_CHARS) return `${first.slice(0, TIP_CHARS).trimEnd()}…`;
  return lines.length > 1 ? `${first} …` : first;
}

const MAX_TIP_LINES = 6;
const MAX_TIP_CHARS = 300;

/** The limit of each hover tip: at most 6 lines and 300 characters, with "…" when the text is cut. A tip
 * then never shows the full content of a file (for example a .py file) or of a long command. */
export function limitTip(tip: string): string {
  const lines = tip.split(/\r?\n/);
  let text = lines.slice(0, MAX_TIP_LINES).map((l) => (l.length > TIP_CHARS ? `${l.slice(0, TIP_CHARS).trimEnd()}…` : l)).join("\n");
  if (text.length > MAX_TIP_CHARS) text = `${text.slice(0, MAX_TIP_CHARS).trimEnd()}…`;
  else if (lines.length > MAX_TIP_LINES) text = `${text.trimEnd()} …`;
  return text;
}

export function splitTip(tip: string): { text: string; keys: string | null } {
  const m = /^([\s\S]*\S)\s+\(((?:Ctrl|Alt|Shift|Cmd|Win|Esc|F\d{1,2})\b[^()]*)\)$/.exec(tip.trim());
  return m ? { text: m[1], keys: m[2] } : { text: tip.trim(), keys: null };
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const hits = (a: Box, r: ScreenRect) => a.left < r.right && a.left + a.width > r.left && a.top < r.bottom && a.top + a.height > r.top;

/**
 * The place of a tip: below the element, or above it if there is no space below. The Browser pane page
 * is a native window over the app, so a tip on it does not show: then the tip goes to the other side,
 * or next to the element (for example the annotation bar under the page). The tip stays in the window.
 */
export function placeTip(
  a: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  natives: ScreenRect[] = [],
): { left: number; top: number } {
  const { width, height } = size;
  const clampX = (x: number) => Math.min(Math.max(EDGE, x), view.width - width - EDGE);
  const clampY = (y: number) => Math.min(Math.max(EDGE, y), view.height - height - EDGE);
  const left = clampX((a.left + a.right) / 2 - width / 2);
  const below = a.bottom + GAP;
  const above = a.top - GAP - height;
  const free = (b: Box) => !natives.some((r) => hits(b, r));
  // The places that do not cover the element: below, then above.
  const vertical = [below, above].filter((top) => top >= EDGE && top + height + EDGE <= view.height).map((top) => ({ left, top }));
  for (const place of vertical) if (free({ ...place, width, height })) return place;
  const middle = clampY((a.top + a.bottom) / 2 - height / 2);
  const sides = [
    { left: a.right + GAP, top: middle },
    { left: a.left - GAP - width, top: middle },
  ].filter((p) => p.left >= EDGE && p.left + width + EDGE <= view.width);
  for (const place of sides) if (free({ ...place, width, height })) return place;
  return vertical[0] ?? { left, top: clampY(below + height + EDGE <= view.height ? below : above) };
}

interface Shown {
  tip: string;
  anchor: DOMRect;
}

export function Tooltips() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let tip = "";
    let timer: number | undefined;
    let hiddenAt = 0;
    let watch: MutationObserver | null = null;
    // The parents of the element that also have a title. The system shows their tip when the
    // element has no title, so this layer removes their titles too, and puts them back after.
    let muted: { el: HTMLElement; tip: string }[] = [];

    const hide = () => {
      window.clearTimeout(timer);
      setShown((s) => {
        if (s) hiddenAt = Date.now();
        return null;
      });
    };

    const release = () => {
      hide();
      watch?.disconnect();
      watch = null;
      // A new title from React while the pointer was on the element stays as React set it.
      if (current && !current.hasAttribute("title") && tip) current.setAttribute("title", tip);
      for (const m of muted) if (!m.el.hasAttribute("title")) m.el.setAttribute("title", m.tip);
      muted = [];
      current = null;
      tip = "";
    };

    const show = () => {
      if (current?.isConnected && tip) setShown({ tip: limitTip(tip), anchor: current.getBoundingClientRect() });
    };

    const take = (el: HTMLElement) => {
      release();
      current = el;
      tip = el.getAttribute("title") ?? "";
      el.removeAttribute("title");
      for (let p = el.parentElement?.closest<HTMLElement>("[title]"); p; p = p.parentElement?.closest<HTMLElement>("[title]")) {
        muted.push({ el: p, tip: p.getAttribute("title") ?? "" });
        p.removeAttribute("title");
      }
      // React can change the title while the pointer is on the element. Take the new text.
      watch = new MutationObserver(() => {
        const next = el.getAttribute("title");
        if (next === null) return;
        tip = next;
        el.removeAttribute("title");
        setShown((s) => (s ? { tip: next, anchor: s.anchor } : s));
      });
      watch.observe(el, { attributes: true, attributeFilter: ["title"] });
      const warm = Date.now() - hiddenAt < WARM_TIME;
      timer = window.setTimeout(show, warm ? 0 : SHOW_DELAY);
    };

    const onOver = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      // Put back the muted titles first, so a parent with a title can show its own tip.
      if (current && !current.contains(target)) release();
      // An element with its own hover card (a pull request mark): no tip, and its parents show no tip.
      const card = target.closest<HTMLElement>("[data-hover-card]");
      if (card) {
        if (current !== card) take(card);
        return;
      }
      const found = target.closest<HTMLElement>("[title]");
      const next = found?.closest("[data-native-tip]") ? null : found;
      if (current && current.contains(target) && (!next || !current.contains(next))) return;
      if (next) take(next);
      else if (current) release();
    };
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) release();
    };
    const onDown = () => {
      hide();
      window.clearTimeout(timer);
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onDown, true);
    document.addEventListener("wheel", onDown, { capture: true, passive: true });
    window.addEventListener("blur", release);
    return () => {
      release();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onDown, true);
      document.removeEventListener("wheel", onDown, true);
      window.removeEventListener("blur", release);
    };
  }, []);

  // Put the tip below the element, or above it, and not on the Browser pane page (placeTip).
  useLayoutEffect(() => {
    if (!shown || !box.current) {
      setPos(null);
      return;
    }
    const { width, height } = box.current.getBoundingClientRect();
    setPos(placeTip(shown.anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight }, nativeRects()));
  }, [shown]);

  if (!shown) return null;
  const { text, keys } = splitTip(shown.tip);
  return (
    <div
      ref={box}
      className="tooltip"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      <span className="tooltip-text">{text}</span>
      {keys && <span className="tooltip-keys">{keys}</span>}
    </div>
  );
}
