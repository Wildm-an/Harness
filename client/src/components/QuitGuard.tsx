// The warning before the app closes while the agent works, as in the Claude app: "Quit anyway",
// "Wait for the agent" (the app closes when the work ends), or "Cancel". Only for the daemon of
// this computer: the turns of a remote daemon go on when the app closes.
// With "Keep running in the background" (Settings > General), a close of the window hides it, and
// the daemon and its routines continue. "Quit Harness" in the tray menu then quits the app.

import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { loadPref } from "../lib/prefs";
import { isTauri } from "../lib/tauri";

/** The pref of "Keep running in the background": "1" is on. Settings > General writes it. */
export const KEEP_IN_BACKGROUND_PREF = "keepInBackground";

/** The tray menu item "Quit Harness" sends this event to the main window. */
export const QUIT_REQUESTED_EVENT = "quit-requested";

/** True when the saved pref value turns "Keep running in the background" on. */
export function keepInBackgroundOn(value: string | null | undefined): boolean {
  return value === "1";
}

export function loadKeepInBackground(): boolean {
  return keepInBackgroundOn(loadPref(KEEP_IN_BACKGROUND_PREF, "0"));
}

/**
 * What a close of the window does. "hide": the app stays in the tray. "close": the app quits.
 * "ask": the dialog asks first, because the agent works in ``working`` sessions.
 */
export function closeAction(working: number, keepInBackground: boolean): "hide" | "close" | "ask" {
  if (keepInBackground) return "hide";
  return working > 0 ? "ask" : "close";
}

/** What "Quit Harness" in the tray menu does. "quit": the app quits. "ask": the dialog asks first. */
export function quitAction(working: number): "quit" | "ask" {
  return working > 0 ? "ask" : "quit";
}

async function appWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** Close the window with no question: the close event does not run again. */
function quitNow() {
  void appWindow().then((w) => w.destroy());
}

/** The text of the warning. */
export function quitText(count: number): string {
  return `The agent is working in ${count} ${count === 1 ? "session" : "sessions"}. Quitting now will interrupt that work.`;
}

function QuitDialog({ count, onQuit, onWait, onCancel }: { count: number; onQuit: () => void; onWait: () => void; onCancel: () => void }) {
  const id = useId();
  const wait = useRef<HTMLButtonElement>(null);
  useOverlay(true);
  useEffect(() => wait.current?.focus(), []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal confirm-dialog quit-dialog"
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
        <div className="quit-head">
          <TriangleAlert size={28} aria-hidden className="quit-icon" />
          <div>
            <h2 id={`${id}-title`} className="confirm-title">
              Harness is still working
            </h2>
            <p id={`${id}-text`} className="confirm-text">
              {quitText(count)}
            </p>
          </div>
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn btn-small" onClick={onQuit}>
            Quit anyway
          </button>
          <button ref={wait} type="button" className="btn btn-small btn-primary" onClick={onWait}>
            Wait for the agent
          </button>
          <button type="button" className="btn btn-small" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Catches the close of the window (the close button, Alt+F4, the taskbar) and "Quit Harness" in
 * the tray menu while ``working`` sessions run on this computer. ``working`` is the count of
 * sessions with a running turn.
 */
export function QuitGuard({ working }: { working: number }) {
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const workingRef = useRef(working);
  workingRef.current = working;

  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const stops: Array<() => void> = [];
    const keep = (unlisten: () => void) => (live ? stops.push(unlisten) : unlisten());
    void appWindow().then((w) => {
      void w
        .onCloseRequested((event) => {
          const action = closeAction(workingRef.current, loadKeepInBackground());
          if (action === "close") return; // Nothing runs: the window closes.
          event.preventDefault();
          if (action === "hide") void w.hide();
          else setAsking(true);
        })
        .then(keep);
      // "Quit Harness" in the tray menu. The tray shows the window first.
      void w
        .listen(QUIT_REQUESTED_EVENT, () => {
          if (quitAction(workingRef.current) === "quit") quitNow();
          else setAsking(true);
        })
        .then(keep);
    });
    return () => {
      live = false;
      for (const stop of stops.splice(0)) stop();
    };
  }, []);

  // "Wait for the agent": the app closes when the last turn ends.
  useEffect(() => {
    if (waiting && working === 0) quitNow();
  }, [waiting, working]);

  return (
    <>
      {asking && working > 0 && (
        <QuitDialog
          count={working}
          onQuit={quitNow}
          onWait={() => {
            setAsking(false);
            setWaiting(true);
          }}
          onCancel={() => setAsking(false)}
        />
      )}
      {waiting && working > 0 && (
        <div className="quit-wait" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden />
          <span>Harness quits when the agent is done.</span>
          <button type="button" className="btn btn-small" onClick={() => setWaiting(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-small" onClick={quitNow}>
            Quit now
          </button>
        </div>
      )}
    </>
  );
}
