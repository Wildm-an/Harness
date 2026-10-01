// The popup at the bottom left when the check at launch finds a new version. It hides after a
// short time, but not while the pointer or the focus is on it. The dot on the Settings button and
// Settings > General keep the update until the user installs it.

import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { useUpdateState } from "../lib/updater";

const SHOW_MS = 12000;

export function UpdateToast({ currentVersion, onView }: {
  currentVersion: string | null;
  onView: () => void; // Open Settings > General.
}) {
  const state = useUpdateState();
  const version = state.kind === "available" ? state.update.version : null;
  const [closed, setClosed] = useState<string | null>(null); // The version that the user closed.
  const [paused, setPaused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shown = version !== null && closed !== version;

  // Hide after SHOW_MS. The time starts again when the pointer or the focus leaves the popup.
  useEffect(() => {
    if (!shown || paused) return;
    const timer = window.setTimeout(() => setClosed(version), SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [shown, paused, version]);

  if (!shown) return null;
  return (
    <div
      ref={box}
      className="update-toast"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node)) setPaused(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && setClosed(version)}
    >
      <ArrowUpCircle size={18} aria-hidden className="update-toast-icon" />
      <div className="update-toast-text">
        <span className="update-toast-title">Update available</span>
        <span className="update-toast-body">
          Harness {version} is ready to install.{currentVersion ? ` You have ${currentVersion}.` : ""}
        </span>
        <div className="update-toast-actions">
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => {
              setClosed(version);
              onView();
            }}
          >
            View update
          </button>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setClosed(version)}>
            Later
          </button>
        </div>
      </div>
      <button type="button" className="icon-btn ghost update-toast-close" onClick={() => setClosed(version)} aria-label="Close" title="Close">
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
