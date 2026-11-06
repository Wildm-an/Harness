// The popup at the bottom right when the check at launch finds a new version. It hides after a
// short time, but not while the pointer or the focus is on it. The dot on the Settings button and
// Settings > General keep the update until the user installs it.
//
// "Update now" downloads and installs the update at once. The popup then stays and shows the
// download progress, then the install step. The app starts again when the install is complete.

import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, LoaderCircle, TriangleAlert } from "lucide-react";
import { installUpdate, useUpdateState, type UpdateState } from "../lib/updater";
import { CloseButton } from "./VersionWarning";

const SHOW_MS = 12000;

/** What the popup shows. */
export type UpdateToastView =
  | { kind: "offer"; version: string } // An update is available.
  | { kind: "download"; version: string; percent: number | null }
  | { kind: "install"; version: string }
  | { kind: "error"; version: string; message: string } // Only for an install that the popup started.
  | null;

/** The view for an update state. ``started``: the version that "Update now" started, or null. */
export function updateToastView(state: UpdateState, started: string | null): UpdateToastView {
  if (state.kind === "available") return { kind: "offer", version: state.update.version };
  if (state.kind === "installing") {
    return state.step === "install"
      ? { kind: "install", version: state.version }
      : { kind: "download", version: state.version, percent: state.percent };
  }
  if (state.kind === "error" && started !== null) return { kind: "error", version: started, message: state.message };
  return null;
}

export function UpdateToast({ currentVersion, onView }: {
  currentVersion: string | null;
  onView: () => void; // Open Settings > General.
}) {
  const state = useUpdateState();
  const [started, setStarted] = useState<string | null>(null);
  const view = updateToastView(state, started);
  const version = view?.version ?? null;
  const [closed, setClosed] = useState<string | null>(null); // The version that the user closed.
  const [paused, setPaused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shown = view !== null && closed !== version;
  const offer = view?.kind === "offer";

  // Hide the offer after SHOW_MS. The time starts again when the pointer or the focus leaves the
  // popup. The progress and the error stay until the user closes them.
  useEffect(() => {
    if (!shown || paused || !offer) return;
    const timer = window.setTimeout(() => setClosed(version), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [shown, paused, offer, version]);

  if (!shown || view === null) return null;
  const busy = view.kind === "download" || view.kind === "install";
  const Icon = busy ? LoaderCircle : view.kind === "error" ? TriangleAlert : ArrowUpCircle;
  return (
    <div
      ref={box}
      className={`update-toast update-toast-${view.kind}`}
      role={view.kind === "error" ? "alert" : "status"}
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node)) setPaused(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && setClosed(version)}
    >
      <Icon size={18} aria-hidden className={`update-toast-icon${busy ? " spin" : ""}`} />
      <div className="update-toast-text">
        {view.kind === "offer" && (
          <>
            <span className="update-toast-title">Update available</span>
            <span className="update-toast-body">
              Harness {view.version} is ready to install.{currentVersion ? ` You have ${currentVersion}.` : ""}
            </span>
            <div className="update-toast-actions">
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={() => {
                  setStarted(view.version);
                  void installUpdate();
                }}
              >
                Update now
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setClosed(view.version);
                  onView();
                }}
              >
                View update
              </button>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setClosed(view.version)}>
                Later
              </button>
            </div>
          </>
        )}
        {view.kind === "download" && (
          <>
            <span className="update-toast-title">Downloading update…</span>
            <span className="update-toast-body">Harness {view.version}</span>
            <div className="update-toast-progress">
              <div
                className={`update-toast-track${view.percent === null ? " indeterminate" : ""}`}
                role="progressbar"
                aria-label="Download progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={view.percent ?? undefined}
              >
                <div className="update-toast-bar" style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
              </div>
              <span className="update-toast-percent" aria-hidden>
                {view.percent === null ? "" : `${view.percent}%`}
              </span>
            </div>
          </>
        )}
        {view.kind === "install" && (
          <>
            <span className="update-toast-title">Installing update…</span>
            <span className="update-toast-body">Harness {view.version} starts when the install is complete.</span>
            <div className="update-toast-progress">
              <div className="update-toast-track indeterminate" role="progressbar" aria-label="Install progress">
                <div className="update-toast-bar" />
              </div>
            </div>
          </>
        )}
        {view.kind === "error" && (
          <>
            <span className="update-toast-title">Update failed</span>
            <span className="update-toast-body">{view.message}</span>
            <div className="update-toast-actions">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setClosed(view.version);
                  onView();
                }}
              >
                Open Settings
              </button>
            </div>
          </>
        )}
      </div>
      <CloseButton onClose={() => setClosed(version)} />
    </div>
  );
}
