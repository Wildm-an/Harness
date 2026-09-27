// The Browser pane webview is drawn above the app page, so it would cover a menu, a dialog,
// or the drop zones of a tab drag. Each of these registers here while it is open, and the
// Browser pane hides its webview while the count is above zero.

import { useEffect, useSyncExternalStore } from "react";

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

export function useOverlayOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => count > 0,
  );
}
