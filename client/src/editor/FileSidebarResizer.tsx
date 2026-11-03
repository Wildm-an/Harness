// The edge on the right of the file sidebar of the editor. Drag it to change the width of the
// sidebar. A double-click goes back to the automatic width. The arrow keys also change the width.
// The width is a per-device preference.

import { useRef } from "react";
import { loadPref, savePref } from "../lib/prefs";

const PREF = "editor.sidebarWidth";
export const FILE_SIDEBAR_MIN = 140;
export const EDITOR_MIN = 240; // The editor keeps at least this width.
const KEY_STEP = 16;

/** A width in the limits of a pane of ``paneWidth``. */
export function clampFileSidebar(width: number, paneWidth: number): number {
  const max = Math.max(FILE_SIDEBAR_MIN, paneWidth - EDITOR_MIN);
  return Math.round(Math.min(max, Math.max(FILE_SIDEBAR_MIN, width)));
}

/** The saved width, or null for the automatic width. */
export function savedFileSidebarWidth(): number | null {
  const n = Number(loadPref(PREF, ""));
  return Number.isFinite(n) && n >= FILE_SIDEBAR_MIN ? Math.round(n) : null;
}

export function saveFileSidebarWidth(width: number | null): void {
  savePref(PREF, width === null ? "" : String(width));
}

export function FileSidebarResizer({
  side,
  onChange,
  onDone,
}: {
  side: React.RefObject<HTMLElement | null>; // The sidebar: its width now, and the width of its pane.
  onChange: (width: number) => void; // While the user drags.
  onDone: (width: number | null) => void; // After the drag, to save the width. null: the automatic width.
}) {
  const drag = useRef<{ x: number; width: number; pane: number; last: number } | null>(null);
  const measure = () => {
    const el = side.current;
    return { width: el?.getBoundingClientRect().width ?? 200, pane: el?.parentElement?.getBoundingClientRect().width ?? 800 };
  };

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing-sidebar");
    onDone(d.last);
  };

  return (
    <div
      className="file-sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="File sidebar width"
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const { width, pane } = measure();
        drag.current = { x: e.clientX, width, pane, last: width };
        document.body.classList.add("resizing-sidebar");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clampFileSidebar(d.width + e.clientX - d.x, d.pane);
        onChange(d.last);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onDone(null)}
      onKeyDown={(e) => {
        const delta = e.key === "ArrowLeft" ? -KEY_STEP : e.key === "ArrowRight" ? KEY_STEP : 0;
        if (!delta) return;
        e.preventDefault();
        const { width, pane } = measure();
        onDone(clampFileSidebar(width + delta, pane));
      }}
    />
  );
}
