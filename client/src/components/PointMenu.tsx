// A menu at the mouse, for a right click: for example the menu of a project in the sidebar.
// Up and Down move between the items, Enter runs one, and Escape or a click outside closes it.

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOverlay } from "../lib/overlay";

export interface PointMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

const MENU_WIDTH = 200;

export function PointMenu({ x, y, label, items, onClose }: {
  x: number;
  y: number;
  label: string; // The name of the menu for a screen reader.
  items: PointMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useOverlay(true);
  const close = useRef(onClose);
  close.current = onClose;

  // Inside the window: the menu opens above the mouse if there is no space below it.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 160;
    const top = y + height > window.innerHeight - 8 ? Math.max(8, y - height) : y;
    setPos({ top, left: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8)) });
  }, [x, y]);

  // The focus goes into the menu when it is visible: a hidden button cannot take the focus.
  useEffect(() => {
    if (pos) ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [pos !== null]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const onScroll = () => close.current();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("blur", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("blur", onScroll);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={ref}
      className="menu point-menu"
      role="menu"
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left, width: MENU_WIDTH } : { visibility: "hidden", width: MENU_WIDTH }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.separatorBefore && <div className="menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
