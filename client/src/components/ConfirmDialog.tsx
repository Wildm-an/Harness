// A short question before a destructive action (UI_RULES R7 and L3): a question title, a text,
// Cancel, and a danger-color button with a verb. The focus starts on Cancel. Esc cancels. When the
// dialog closes, the focus goes back to the control that opened it, if that control is still there.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useOverlay } from "../lib/overlay";

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel }: {
  title: string; // A question, for example "Delete app.py?".
  children: ReactNode; // What happens, and what stays.
  confirmLabel: string; // A verb, for example "Delete".
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  useOverlay(true);
  useEffect(() => {
    cancel.current?.focus();
    const back = opener.current;
    return () => {
      // After the dialog leaves the page. A dialog that set the focus itself keeps it.
      window.setTimeout(() => {
        const active = document.activeElement;
        if (back instanceof HTMLElement && back.isConnected && (active === null || active === document.body)) back.focus({ preventScroll: true });
      }, 0);
    };
  }, []);

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
          <button type="button" className="btn btn-small btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A question for useConfirm: the title, the text, the verb, and the action. */
export interface ConfirmRequest {
  title: string;
  text: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}

/**
 * One confirm dialog for a component with several destructive actions (rule R7). `ask(request)`
 * opens the dialog. Render `dialog` once in the component.
 */
export function useConfirm(): { ask: (request: ConfirmRequest) => void; dialog: ReactNode } {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const ask = useCallback((r: ConfirmRequest) => setRequest(r), []);
  const dialog = request && (
    <ConfirmDialog
      title={request.title}
      confirmLabel={request.confirmLabel}
      onConfirm={() => {
        setRequest(null);
        request.onConfirm();
      }}
      onCancel={() => setRequest(null)}
    >
      {request.text}
    </ConfirmDialog>
  );
  return { ask, dialog };
}
