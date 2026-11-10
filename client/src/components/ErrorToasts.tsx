// The error popups at the bottom right of the window (docs/UI_RULES.md M18a, V11). They show the
// errors that are not part of the conversation and that no view shows itself: a failed sidebar
// command, a failed request of a page, or an error of the Browser pane. They are in the toast stack,
// so they stay clear of the Browser pane webview. A popup goes away after 8 seconds. The time stops
// while the pointer or the focus is on it. The same stack shows the "Undo" popup of an action that
// does not ask first (rule R7a): an info icon, the text, and "Undo".

import { useEffect, useRef, useState } from "react";
import { CircleAlert, Info, Undo2 } from "lucide-react";
import type { ErrorToastItem } from "../lib/errorRoute";
import { CloseButton } from "./VersionWarning";

const SHOW_MS = 8000;

export function ErrorToasts({ items, onClose }: { items: ErrorToastItem[]; onClose: (id: number) => void }) {
  return (
    <>
      {items.map((item) => (
        <ErrorToast key={item.id} item={item} onClose={() => onClose(item.id)} />
      ))}
    </>
  );
}

function ErrorToast({ item, onClose }: { item: ErrorToastItem; onClose: () => void }) {
  const [held, setHeld] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  // The same text again (the count changes) starts the time again.
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => close.current(), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [held, item.count]);
  const undo = item.undo;
  return (
    <div
      className={`update-toast ${undo ? "undo-toast" : "error-toast"}`}
      role={undo ? "status" : "alert"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      {undo ? <Info size={18} aria-hidden className="update-toast-icon" /> : <CircleAlert size={18} aria-hidden className="update-toast-icon" />}
      <div className="update-toast-text">
        <span className="update-toast-body error-toast-body">
          {item.text}
          {item.count > 1 && (
            <span className="notice-count" aria-label={`${item.count} times`}>
              ×{item.count}
            </span>
          )}
        </span>
      </div>
      {undo && (
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            onClose();
            undo();
          }}
        >
          <Undo2 size={13} aria-hidden />
          Undo
        </button>
      )}
      <CloseButton onClose={onClose} />
    </div>
  );
}
