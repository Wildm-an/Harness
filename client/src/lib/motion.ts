// Motion helpers (docs/UI_RULES.md T11, audit section 6.2). Most entry motion is CSS: an element
// animates when it mounts. These helpers cover the two cases that CSS cannot do:
// - A new chat item animates, but a transcript that loads all at once does not (M3).
// - An element fades out before it leaves the page (M15).

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export const EASE_OUT = "cubic-bezier(0.165, 0.84, 0.44, 1)";

/** True when the user asks for less motion. The CSS rule covers CSS motion only. */
export function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** More new children than this in one render is a load (a session opens, a rewind): nothing animates. */
export const MAX_ENTERING = 2;

/**
 * The children of `parent` that are new since the last call. `known` keeps the children seen before.
 * The first call only learns the children. Returns the new children that animate: none for a load.
 */
export function enteringChildren(parent: Element, known: WeakSet<Element>, first: boolean): Element[] {
  const fresh = [...parent.children].filter((c) => !known.has(c));
  for (const c of fresh) known.add(c);
  return first || fresh.length > MAX_ENTERING ? [] : fresh;
}

/**
 * M3: a new child of the element in `ref` fades in and rises 4px (200 ms). It runs after each
 * render, before the paint, so the new item never shows at its end state first.
 */
export function useEnterMotion(ref: RefObject<HTMLElement | null>): void {
  const known = useRef(new WeakSet<Element>());
  const first = useRef(true);
  useLayoutEffect(() => {
    const parent = ref.current;
    if (!parent) return;
    const entering = enteringChildren(parent, known.current, first.current);
    first.current = false;
    if (reducedMotion() || typeof (parent as HTMLElement).animate !== "function") return;
    for (const el of entering) {
      if (el instanceof HTMLElement && el.dataset.noEnter !== undefined) continue; // It has its own motion.
      el.animate([{ opacity: 0, translate: "0 4px" }, { opacity: 1, translate: "0 0" }], { duration: 200, easing: EASE_OUT });
    }
  });
}

/**
 * M15: keeps an element on the page while it fades out. `mounted`: render it. `leaving`: give it the
 * class that fades it out. After `ms` (0 with less motion) the element leaves.
 */
export function usePresence(open: boolean, ms: number): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), reducedMotion() ? 0 : ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);
  return { mounted: open || mounted, leaving: !open && mounted };
}
