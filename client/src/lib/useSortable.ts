// Drag to reorder a vertical list, with animation (the user asked for this): the item that the user
// holds follows the pointer, and the other items slide out of the way to show its new place. The
// order changes on release. Pointer events, not HTML drag and drop: the items can move while the
// user drags. The sidebar projects and the sections of the session rail use it.

import { useCallback, useEffect, useRef, useState } from "react";

const START_DISTANCE = 4; // Pixels: a smaller move is a click.

interface Drag {
  id: string;
  index: number; // The place of the item when the drag started.
  startY: number;
  dy: number; // The move of the pointer since the start.
  tops: number[]; // The tops of all the items at the start.
  heights: number[];
}

/** The new place of the held item: the number of other items whose middle is above the middle of the held item. */
export function targetIndex(tops: number[], heights: number[], index: number, dy: number): number {
  const middle = tops[index] + heights[index] / 2 + dy;
  let target = 0;
  for (let i = 0; i < tops.length; i++) {
    if (i !== index && tops[i] + heights[i] / 2 < middle) target++;
  }
  return target;
}

/** The move of another item (in pixels) while the item at ``index`` goes to ``target``. */
export function shiftOf(i: number, index: number, target: number, tops: number[], heights: number[]): number {
  // The space of the held item: its height and the gap after it (or before it, for the last item).
  const span = index + 1 < tops.length ? tops[index + 1] - tops[index] : index > 0 ? tops[index] - tops[index - 1] - heights[index - 1] + heights[index] : heights[index];
  if (index < target && i > index && i <= target) return -span;
  if (target < index && i >= target && i < index) return span;
  return 0;
}

/** The list order after a move of ``id`` to the place ``target`` (a place in the list without the item). */
export function reorder<T>(ids: T[], id: T, target: number): T[] {
  const rest = ids.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(target, rest.length)), 0, id);
  return rest;
}

export function useSortable(ids: string[], onMove: (id: string, target: number) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [settling, setSettling] = useState(false); // The render of the new order: no slide back.
  const items = useRef(new Map<string, HTMLElement>());
  const moved = useRef(false); // The last pointer press moved an item: the click after it does nothing.
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const itemRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) items.current.set(id, el);
      else items.current.delete(id);
    },
    [],
  );

  useEffect(() => {
    if (!settling) return;
    const frame = requestAnimationFrame(() => setSettling(false));
    return () => cancelAnimationFrame(frame);
  }, [settling]);

  /** Starts a drag of ``id`` from a pointer press. A press with no move stays a click. */
  const onPointerDown = useCallback((id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    let current: Drag | null = null;
    moved.current = false;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (!current) {
        if (Math.abs(dy) < START_DISTANCE) return;
        const list = idsRef.current;
        const rects = list.map((x) => items.current.get(x)?.getBoundingClientRect());
        if (rects.some((r) => !r)) return;
        current = {
          id,
          index: list.indexOf(id),
          startY,
          dy,
          tops: rects.map((r) => r!.top),
          heights: rects.map((r) => r!.height),
        };
        moved.current = true;
        document.body.classList.add("sorting");
      }
      current = { ...current, dy };
      setDrag(current);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.classList.remove("sorting");
      if (current) {
        const target = targetIndex(current.tops, current.heights, current.index, current.dy);
        setSettling(true);
        setDrag(null);
        if (target !== current.index) onMoveRef.current(current.id, target);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, []);

  /** The style of an item: the held item follows the pointer, the others slide to make room. */
  const styleOf = useCallback(
    (id: string): React.CSSProperties | undefined => {
      if (settling) return { transition: "none" };
      if (!drag) return undefined;
      const list = idsRef.current;
      const i = list.indexOf(id);
      if (id === drag.id) return { transform: `translateY(${drag.dy}px)`, zIndex: 5, position: "relative", transition: "none" };
      const target = targetIndex(drag.tops, drag.heights, drag.index, drag.dy);
      const shift = shiftOf(i, drag.index, target, drag.tops, drag.heights);
      return { transform: shift ? `translateY(${shift}px)` : undefined, transition: "transform 160ms cubic-bezier(0.2, 0, 0, 1)" };
    },
    [drag, settling],
  );

  /** Call in onClickCapture of the item: a click right after a drag does nothing. */
  const swallowClick = useCallback((e: React.MouseEvent) => {
    if (!moved.current) return;
    moved.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return { itemRef, onPointerDown, styleOf, swallowClick, dragging: drag?.id ?? null };
}
