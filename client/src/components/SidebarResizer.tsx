import { useRef } from "react";

// The edge on the right of the sidebar. Drag it to change the width of the sidebar.
// A double-click sets the default width. The arrow keys also change the width.

export const SIDEBAR_DEFAULT = 264;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
const KEY_STEP = 16;

/** A width in the limits. A value that is not a number gives the default width. */
export function clampSidebar(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

export function SidebarResizer({
  width,
  onChange,
  onDone,
}: {
  width: number;
  onChange: (width: number) => void; // While the user drags.
  onDone: (width: number) => void; // After the drag, to save the width.
}) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);

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
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width, last: width };
        document.body.classList.add("resizing-sidebar");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = clampSidebar(d.width + e.clientX - d.x);
        onChange(d.last);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onDone(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        const delta = e.key === "ArrowLeft" ? -KEY_STEP : e.key === "ArrowRight" ? KEY_STEP : 0;
        if (!delta) return;
        e.preventDefault();
        onDone(clampSidebar(width + delta));
      }}
    />
  );
}
