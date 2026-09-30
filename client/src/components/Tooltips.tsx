import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
export function splitTip(tip: string): { text: string; keys: string | null } {
  const m = /^([\s\S]*\S)\s+\(((?:Ctrl|Alt|Shift|Cmd|Win|F\d{1,2})\b[^()]*)\)$/.exec(tip.trim());
  return m ? { text: m[1], keys: m[2] } : { text: tip.trim(), keys: null };
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
      current = null;
      tip = "";
    };

    const show = () => {
      if (current?.isConnected && tip) setShown({ tip, anchor: current.getBoundingClientRect() });
    };

    const take = (el: HTMLElement) => {
      release();
      current = el;
      tip = el.getAttribute("title") ?? "";
      el.removeAttribute("title");
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

  // Put the tip below the element, or above it if there is no space below. Keep it in the window.
  useLayoutEffect(() => {
    if (!shown || !box.current) {
      setPos(null);
      return;
    }
    const { width, height } = box.current.getBoundingClientRect();
    const a = shown.anchor;
    const below = a.bottom + GAP;
    const top = below + height + EDGE <= window.innerHeight ? below : Math.max(EDGE, a.top - GAP - height);
    const left = Math.min(Math.max(EDGE, a.left + a.width / 2 - width / 2), window.innerWidth - width - EDGE);
    setPos({ left, top });
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
