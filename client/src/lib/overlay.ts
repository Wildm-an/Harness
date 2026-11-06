// The Browser pane webview is drawn above the app page, so it would cover a menu, a dialog,
// or the drop zones of a tab drag. Each of these registers here while it is open, and the
// Browser pane hides its webview while the count is above zero.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

let count = 0;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

/** Register an overlay while ``open`` is true. */
export function useOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    count++;
    notify();
    return () => {
      count--;
      notify();
    };
  }, [open]);
}

/** True while a menu, a dialog, or a drag overlay is open (outside React). */
export function overlayOpen(): boolean {
  return count > 0;
}

export function useOverlayOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => count > 0,
  );
}

// The popups at the bottom of the window (the update popups, the "wait for the agent" notes) must
// always show. The Browser pane publishes here the place of its webview on the screen. A popup that
// the webview would cover moves to the left of it. When there is no room at the left, the popup
// registers as an overlay: the webview hides, and a still picture of the page shows in its place.

/** A place on the screen, in CSS pixels of the window. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const natives = new Map<string, ScreenRect>();
let nativeList: ScreenRect[] = [];
const nativeListeners = new Set<() => void>();

/** Set (or with null, remove) the place of the native webview of ``owner``. */
export function setNativeRect(owner: string, rect: ScreenRect | null): void {
  const old = natives.get(owner);
  if (rect && old && old.left === rect.left && old.top === rect.top && old.right === rect.right && old.bottom === rect.bottom) return;
  if (!rect && !old) return;
  if (rect) natives.set(owner, rect);
  else natives.delete(owner);
  nativeList = [...natives.values()];
  nativeListeners.forEach((fn) => fn());
}

/** The places of the native webviews on the screen now. */
export function useNativeRects(): ScreenRect[] {
  return useSyncExternalStore(
    (fn) => {
      nativeListeners.add(fn);
      return () => nativeListeners.delete(fn);
    },
    () => nativeList,
  );
}

const GAP = 16; // The space between a popup and a webview.
const EDGE = 8; // The smallest space between a popup and the left edge of the window.

/**
 * The horizontal move (0 or less, in pixels) that puts ``box`` at the left of each webview that it
 * touches. Null: there is no room at the left of the webview.
 */
export function clearShift(box: ScreenRect, rects: ScreenRect[]): number | null {
  let shift = 0;
  for (let i = 0; i <= rects.length; i++) {
    const left = box.left + shift;
    const right = box.right + shift;
    const hit = rects.filter((r) => r.left < right && r.right > left && r.top < box.bottom && r.bottom > box.top);
    if (hit.length === 0) return shift;
    shift = Math.min(...hit.map((r) => r.left)) - GAP - box.right;
    if (box.left + shift < EDGE) return null;
  }
  return null;
}

/**
 * Keep the popup in ``ref`` clear of the native webviews. The hook sets the CSS variable
 * `--native-shift` on the element. Its CSS must add the variable to its `transform`.
 */
export function useClearOfNative(ref: RefObject<HTMLElement | null>): void {
  const rects = useNativeRects();
  const [cover, setCover] = useState(false);
  const shift = useRef(0);
  useOverlay(cover);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (value: number) => {
      if (value === shift.current) return;
      shift.current = value;
      el.style.setProperty("--native-shift", `${value}px`);
    };
    const place = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        apply(0);
        setCover(false);
        return;
      }
      const s = shift.current;
      const next = rects.length === 0 ? 0 : clearShift({ left: r.left - s, top: r.top, right: r.right - s, bottom: r.bottom }, rects);
      apply(next ?? 0);
      setCover(next === null);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [ref, rects]);
}
