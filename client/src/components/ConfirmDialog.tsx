// A short question before a destructive action (UI_RULES R7 and L3): a question title, a text,
// Cancel, and a danger-color button with a verb. The focus starts on Cancel. Esc cancels.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { useOverlay } from "../lib/overlay";

export function ConfirmDialog({ title, children, confirmLabel, focusConfirm, onConfirm, onCancel }: {
  title: string; // A question, for example "Delete app.py?".
  children: ReactNode; // What happens, and what stays.
  confirmLabel: string; // A verb, for example "Delete".
  focusConfirm?: boolean; // The focus starts on the confirm button, so Enter confirms (UI_RULES S8).
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useOverlay(true);
  useEffect(() => (focusConfirm ? confirm : cancel).current?.focus(), [focusConfirm]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-text`}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id={`${id}-title`} className="confirm-title">
          {title}
        </h2>
        <p id={`${id}-text`} className="confirm-text">
          {children}
        </p>
        <div className="confirm-actions">
          <button ref={cancel} type="button" className="btn btn-small" onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirm} type="button" className="btn btn-small btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
