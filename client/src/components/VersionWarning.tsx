// The warning when the connected daemon has another version than the app, for example a remote
// daemon that was not updated. The protocol can change between versions, so some features can fail.
// It has no close button: it stays until the app connects to another daemon, or the user starts
// the update of the daemon. The popup is at the bottom left, as the update popup of the app.

import { ArrowUpCircle, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { compareVersions } from "../lib/version";

export function VersionWarning({ appVersion, daemonVersion, host, canUpdate, onUpdate, onComputers }: {
  appVersion: string;
  daemonVersion: string;
  host: string; // The name of the daemon computer.
  canUpdate: boolean; // The daemon is older, and it can install an update from the app.
  onUpdate: () => void;
  onComputers: () => void; // Open the Computers page.
}) {
  const older = compareVersions(daemonVersion, appVersion) < 0;
  return (
    <div className="update-toast version-warning" role="alert">
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
    </div>
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

/** The progress of "Update daemon". Done and error have a close button. */
export function DaemonUpdateToast({ update, onClose }: { update: DaemonUpdate; onClose: () => void }) {
  const busy = update.phase !== "done" && update.phase !== "error";
  const Icon = busy ? LoaderCircle : update.phase === "error" ? TriangleAlert : ArrowUpCircle;
  return (
    <div className={`update-toast daemon-update daemon-update-${update.phase}`} role={update.phase === "error" ? "alert" : "status"} aria-live="polite">
      <Icon size={18} aria-hidden className={`update-toast-icon${busy ? " spin" : ""}`} />
      <div className="update-toast-text">
        <span className="update-toast-title">
          {update.phase === "error" ? "The daemon update failed" : update.phase === "done" ? "Daemon updated" : "Updating the daemon"}
        </span>
        <span className="update-toast-body daemon-update-body">{PHASE_TEXT[update.phase](update)}</span>
      </div>
      {!busy && (
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close" title="Close">
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
