// The question before an app update while the agent works (the user asked for this): the update
// restarts the app and the daemon of this computer, so it stops the turns. "Update now" continues,
// "Wait for the agent" installs the update when the last turn ends, and "Cancel" does nothing.
// Each start of an install (the update toast, Settings > Updates) goes through this guard.

import { useEffect, useId, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { WaitNote } from "./WaitNote";
import { setInstallGuard } from "../lib/updater";

/** The text of the question. */
export function updateText(count: number): string {
  return `The agent is working in ${count} ${count === 1 ? "session" : "sessions"}. The update restarts Harness and stops that work.`;
}

export function UpdateGuard({ working }: { working: number }) {
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const answer = useRef<((go: boolean) => void) | null>(null);
  const workingRef = useRef(working);
  workingRef.current = working;
  const wait = useRef<HTMLButtonElement>(null);

  // installUpdate asks this guard first.
  useEffect(() => {
    setInstallGuard(
      () =>
        new Promise<boolean>((resolve) => {
          if (workingRef.current === 0) return resolve(true);
          answer.current = resolve;
          setAsking(true);
        }),
    );
    return () => setInstallGuard(null);
  }, []);

  const finish = (go: boolean) => {
    setAsking(false);
    setWaiting(false);
    answer.current?.(go);
    answer.current = null;
  };

  // "Wait for the agent": the install starts when the last turn ends.
  useEffect(() => {
    if (waiting && working === 0) finish(true);
  }, [waiting, working]);

  useEffect(() => {
    if (asking) wait.current?.focus();
  }, [asking]);

  return (
    <>
      {asking && working > 0 && <Backdrop />}
      {asking && working > 0 && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(false)}>
          <div
            className="modal confirm-dialog quit-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-text`}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                finish(false);
              }
            }}
          >
            <div className="quit-head">
              <TriangleAlert size={28} aria-hidden className="quit-icon" />
              <div>
                <h2 id={`${id}-title`} className="confirm-title">
                  Update while the agent works?
                </h2>
                <p id={`${id}-text`} className="confirm-text">
                  {updateText(working)}
                </p>
              </div>
            </div>
            <div className="confirm-actions">
              <button type="button" className="btn btn-small" onClick={() => finish(true)}>
                Update now
              </button>
              <button
                ref={wait}
                type="button"
                className="btn btn-small btn-primary"
                onClick={() => {
                  setAsking(false);
                  setWaiting(true);
                }}
              >
                Wait for the agent
              </button>
              <button type="button" className="btn btn-small" onClick={() => finish(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {waiting && working > 0 && (
        <WaitNote text="Harness updates when the agent is done." action="Update now" onAction={() => finish(true)} onCancel={() => finish(false)} />
      )}
    </>
  );
}

/** The dialog hides the native webviews (for example the Browser pane) while it is open. */
function Backdrop() {
  useOverlay(true);
  return null;
}
