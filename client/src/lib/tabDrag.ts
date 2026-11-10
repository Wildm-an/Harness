// A drag that changes the order of the tabs in a tab row: the file tabs of the editor, and the
// tabs of the browser (docs/UI_RULES.md V6k5). The held tab follows the pointer. The other tabs
// slide out of its way. After the drop, the held tab slides into its new place.

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";

/** The list with the item at ``from`` moved to the index ``to``. */
export function withMoved<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** The place of a tab in the tab row, in pixels. */
export interface TabBox {
  left: number;
  width: number;
}

export interface DragLayout {
  dx: number; // The move of the held tab, limited to the tab row.
  to: number; // The index of the held tab after a drop.
  shifts: number[]; // The move of each other tab.
  rest: number; // The move of the held tab that puts it in the place of the index ``to``.
}

/**
 * A drag of the tab ``from`` by ``dx`` pixels. A tab moves out of the way when an edge of the held
 * tab goes past its center. It moves by the width of the held tab and the gap between two tabs.
 */
export function dragLayout(boxes: TabBox[], from: number, dx: number): DragLayout {
  const held = boxes[from];
  const last = boxes[boxes.length - 1];
  const gap = boxes.length > 1 ? boxes[1].left - (boxes[0].left + boxes[0].width) : 0;
  const limited = Math.min(Math.max(dx, boxes[0].left - held.left), last.left + last.width - held.width - held.left);
  const left = held.left + limited;
  const right = left + held.width;
  let to = from;
  const shifts = boxes.map((box, i) => {
    const center = box.left + box.width / 2;
    if (i < from && left < center) {
      to -= 1;
      return held.width + gap;
    }
    if (i > from && right > center) {
      to += 1;
      return -(held.width + gap);
    }
    return 0;
  });
  const target = boxes[to];
  const rest = to > from ? target.left + target.width - held.width - held.left : to < from ? target.left - held.left : 0;
  return { dx: limited, to, shifts, rest };
}

const START = 4; // Pixels. A smaller move of the pointer is a click.
export const SLIDE_MS = 160; // The time of a slide. styles.css has the same time.

interface Drag extends DragLayout {
  from: number;
  settling: boolean; // After the drop: the held tab slides into its place.
}

/**
 * The drag of the tabs of one tab row. Each tab element gets ``tabProps(index)``, and the row gets
 * ``rowClass``. The tab elements are children of the row. A child with ``data-no-drag`` (a close
 * button) does not start a drag. ``onMove`` gets the old index and the new index after the drop.
 * ``onStart`` runs when a drag starts: the click that selects the tab does not come after a drag.
 */
export function useTabDrag(onMove: (from: number, to: number) => void, onStart?: (index: number) => void) {
  const [drag, setDragState] = useState<Drag | null>(null);
  // The drag, current at once: a move and a drop can come before the next render.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  };
  const release = useRef<(() => void) | null>(null); // Removes the window listeners of the press.
  const timer = useRef(0);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;

  const stop = () => {
    window.clearTimeout(timer.current);
    release.current?.();
    setDrag(null);
  };

  /** The drop: the held tab slides into its place, then the order changes. */
  const drop = () => {
    const d = dragRef.current;
    release.current?.();
    if (!d || d.settling) return;
    setDrag({ ...d, dx: d.rest, settling: true });
    timer.current = window.setTimeout(() => {
      setDrag(null);
      if (d.to !== d.from) onMoveRef.current(d.from, d.to);
    }, SLIDE_MS);
  };

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      release.current?.();
    },
    [],
  );

  // Esc ends the drag, and the order does not change.
  const active = drag !== null;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      stop();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  const tabProps = (index: number) => {
    const held = drag?.from === index;
    const move = drag ? (held ? drag.dx : (drag.shifts[index] ?? 0)) : 0;
    return {
      "data-drag-tab": held ? (drag.settling ? "settling" : "held") : "",
      style: (drag ? { transform: `translateX(${move}px)` } : undefined) as CSSProperties | undefined,
      // The header of a pane window is draggable (it moves the pane). A drag that starts on a tab
      // must not start that drag: the tab takes the browser drag, and stops it.
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
      },
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (e.button !== 0 || dragRef.current || (e.target as HTMLElement).closest("[data-no-drag]")) return;
        const row = e.currentTarget.parentElement;
        const startX = e.clientX;
        let boxes: TabBox[] | null = null;
        // The window gets the moves: the pointer can leave the tab before the drag starts.
        const onPointerMove = (ev: PointerEvent) => {
          if (dragRef.current?.settling) return;
          if (!(ev.buttons & 1)) return drop(); // The button went up outside of the window.
          if (!boxes) {
            if (!row || Math.abs(ev.clientX - startX) < START) return;
            boxes = Array.from(row.querySelectorAll<HTMLElement>(":scope > [data-drag-tab]")).map((el) => {
              const rect = el.getBoundingClientRect();
              return { left: rect.left, width: rect.width };
            });
            if (boxes.length < 2 || !boxes[index]) return stop();
            onStartRef.current?.(index);
          }
          setDrag({ from: index, settling: false, ...dragLayout(boxes, index, ev.clientX - startX) });
        };
        release.current?.();
        release.current = () => {
          release.current = null;
          window.removeEventListener("pointermove", onPointerMove);
          window.removeEventListener("pointerup", drop);
          window.removeEventListener("pointercancel", stop);
        };
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", drop);
        window.addEventListener("pointercancel", stop);
      },
    };
  };

  return { rowClass: drag ? " tab-dragging" : "", tabProps };
}
