import { useRef, useState, type ReactNode } from "react";
import { loadPref, savePref } from "../lib/prefs";

const MIN_SIDE = 340;
const MIN_MAIN = 360;
const KEY_STEP = 32;

/**
 * The main area with an optional side pane on the right. A divider changes the width,
 * with the mouse or with the arrow keys. Phase 8 replaces this with the full pane layout.
 */
export function SplitLayout({ main, side }: { main: ReactNode; side: ReactNode | null }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => Number(loadPref("sideWidth", "560")) || 560);

  const clamp = (w: number) => {
    const total = container.current?.clientWidth ?? 1200;
    return Math.round(Math.min(Math.max(w, MIN_SIDE), Math.max(total - MIN_MAIN, MIN_SIDE)));
  };

  const commit = (w: number) => {
    const next = clamp(w);
    setWidth(next);
    savePref("sideWidth", String(next));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const right = container.current?.getBoundingClientRect().right ?? window.innerWidth;
    const move = (ev: PointerEvent) => setWidth(clamp(right - ev.clientX));
    const up = (ev: PointerEvent) => {
      commit(right - ev.clientX);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") commit(width + KEY_STEP);
    else if (e.key === "ArrowRight") commit(width - KEY_STEP);
    else return;
    e.preventDefault();
  };

  return (
    <div className="split" ref={container}>
      <div className="split-main">{main}</div>
      {side && (
        <>
          <div
            className="split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the side pane"
            aria-valuenow={width}
            aria-valuemin={MIN_SIDE}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
          />
          <div className="split-side" style={{ width }}>
            {side}
          </div>
        </>
      )}
    </div>
  );
}
