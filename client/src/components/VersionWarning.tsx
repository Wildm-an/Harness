// The warning when the connected daemon has another version than the app, for example a remote
// daemon that was not updated. The protocol can change between versions, so some features can fail.
// It stays until the user closes it (the X or Esc), the app connects to another daemon, or the user
// starts the update of the daemon. The popup is at the bottom right, as the update popup of the app.

import { ArrowUpCircle, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { compareVersions } from "../lib/version";

export function VersionWarning({ appVersion, daemonVersion, host, canUpdate, onUpdate, onComputers, onClose }: {
  appVersion: string;
  daemonVersion: string;
  host: string; // The name of the daemon computer.
  canUpdate: boolean; // The daemon is older, and it can install an update from the app.
  onUpdate: () => void;
  onComputers: () => void; // Open the Computers page.
  onClose: () => void;
}) {
  const older = compareVersions(daemonVersion, appVersion) < 0;
  return (
    <div className="update-toast version-warning" role="alert" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <TriangleAlert size={18} aria-hidden className="update-toast-icon" />
      <div className="update-toast-text">
        <span className="update-toast-title">{older ? "Daemon update needed" : "App update needed"}</span>
        <span className="update-toast-body">
          The daemon on {host} is version {daemonVersion}. This app is version {appVersion}.{" "}
          {older
            ? "Update the daemon: some features of this app do not work with an older daemon."
            : "Update this app: some features of the daemon do not work with an older app."}
        </span>
        <div className="update-toast-actions">
          {canUpdate && (
            <button type="button" className="btn btn-primary btn-small" onClick={onUpdate}>
              Update daemon
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={onComputers}>
            Open Computers
          </button>
        </div>
      </div>
      <CloseButton onClose={onClose} />
    </div>
  );
}

/** The X at the top right of each popup at the bottom right. Esc in the popup also closes it. */
export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="icon-btn ghost update-toast-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
      <X size={14} aria-hidden />
    </button>
  );
}

export type DaemonUpdatePhase = "sending" | "installing" | "restarting" | "done" | "error";

export interface DaemonUpdate {
  connectionId: string;
  host: string;
  version: string; // The new version: the version of the app.
  phase: DaemonUpdatePhase;
  message?: string; // The error.
}

const PHASE_TEXT: Record<DaemonUpdatePhase, (u: DaemonUpdate) => string> = {
  sending: (u) => `Sending version ${u.version} to ${u.host}…`,
  installing: (u) => `${u.host} installs version ${u.version} with pip. This can take a minute.`,
  restarting: (u) => `The daemon on ${u.host} restarts. The app connects again when it is ready.`,
  done: (u) => `The daemon on ${u.host} is version ${u.version} now.`,
  error: (u) => u.message ?? "The update failed.",
};

/** The progress of "Update daemon". The X hides it. A running update goes on. */
export function DaemonUpdateToast({ update, onClose }: { update: DaemonUpdate; onClose: () => void }) {
  const busy = update.phase !== "done" && update.phase !== "error";
  const Icon = busy ? LoaderCircle : update.phase === "error" ? TriangleAlert : ArrowUpCircle;
  return (
    <div
      className={`update-toast daemon-update daemon-update-${update.phase}`}
      role={update.phase === "error" ? "alert" : "status"}
      aria-live="polite"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <Icon size={18} aria-hidden className={`update-toast-icon${busy ? " spin" : ""}`} />
      <div className="update-toast-text">
        <span className="update-toast-title">
          {update.phase === "error" ? "The daemon update failed" : update.phase === "done" ? "Daemon updated" : "Updating the daemon"}
        </span>
        <span className="update-toast-body daemon-update-body">{PHASE_TEXT[update.phase](update)}</span>
      </div>
      <CloseButton onClose={onClose} />
    </div>
  );
}
