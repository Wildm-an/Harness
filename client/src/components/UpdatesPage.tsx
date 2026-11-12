// The Updates page of the Settings dialog, in the style of the Windows Update page (the user asked
// for this): a large status icon with a badge, the status and the time of the last check, and the
// action at the right. The setting "Check for updates when the app opens" is under it, then the
// changelog: CHANGELOG.md at the root of the repository, built into the app, from its first version heading.
// The changelog shows the 5 newest versions, and "Show more" adds 5 more (the user asked for this).

import { useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import changelog from "../../../CHANGELOG.md?raw";
import { Markdown } from "./Markdown";
import { Row, Switch } from "./SettingsDialog";
import { isTauri } from "../lib/tauri";
import { checkAtStart, checkForUpdate, installUpdate, lastChecked, setCheckAtStart, useUpdateState, type UpdateState } from "../lib/updater";

/** The number of versions that the changelog shows first, and that each "Show more" adds. */
export const CHANGELOG_STEP = 5;

/** The sections of the changelog, one for each "## " heading (a version or "Unreleased"), newest first. */
export function changelogSections(text: string): string[] {
  const start = text.search(/^## /m);
  if (start < 0) return [text];
  return text
    .slice(start)
    .split(/^(?=## )/m)
    .map((part) => part.trimEnd())
    .filter(Boolean);
}

const sections = changelogSections(changelog);

/** The badge on the status icon: up to date, an update waits, an error, or none. */
export type UpdateBadge = "ok" | "pending" | "error" | "none";

export interface UpdateHero {
  badge: UpdateBadge;
  busy: boolean; // The arrows turn: a check or an install runs.
  title: string;
  detail: string;
  percent: number | null; // The download progress bar. null: no bar.
  version: string | null; // "Current version: 0.1.78", under the status (the user asked for this). null: not known.
  action: { kind: "check" | "install"; label: string } | null;
}

/** "Today, 9:41 AM", "Yesterday, 9:41 AM", or "Nov 10, 9:41 AM". */
export function checkedText(at: number, now = Date.now()): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return `Today, ${time}`;
  if (day(at) === day(now - 24 * 60 * 60 * 1000)) return `Yesterday, ${time}`;
  return `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

const INSTALL_PREFIX = "The update did not install: ";
const CHECK_PREFIX = "The update check failed: ";

/** What the top of the page shows for an update state. */
export function updateHero(state: UpdateState, appVersion: string | null, checkedAt: number | null, desktop: boolean, now = Date.now()): UpdateHero {
  const checked = checkedAt ? `Last checked: ${checkedText(checkedAt, now)}` : "Harness did not check for updates yet.";
  const check = { kind: "check" as const, label: "Check for updates" };
  const version = appVersion ? `Current version: ${appVersion}` : null;
  if (!desktop) {
    return { badge: "none", busy: false, title: "Updates are in the desktop app", detail: "The desktop app checks for updates and installs them.", percent: null, version, action: null };
  }
  return { ...heroOf(state, checked, check), version };
}

function heroOf(state: UpdateState, checked: string, check: { kind: "check"; label: string }): Omit<UpdateHero, "version"> {
  switch (state.kind) {
    case "checking":
      return { badge: "none", busy: true, title: "Checking for updates…", detail: "", percent: null, action: null };
    case "none":
      return { badge: "ok", busy: false, title: "Harness is up to date", detail: checked, percent: null, action: check };
    case "available":
      return {
        badge: "pending",
        busy: false,
        title: `Harness ${state.update.version} is available`,
        detail: "The app closes for the install, and then starts again.",
        percent: null,
        action: { kind: "install", label: "Install and restart" },
      };
    case "installing":
      return state.step === "download"
        ? { badge: "pending", busy: true, title: `Downloading Harness ${state.version}`, detail: state.percent !== null ? `${state.percent}%` : "Starting the download…", percent: state.percent ?? 0, action: null }
        : { badge: "pending", busy: true, title: `Installing Harness ${state.version}`, detail: "The app starts again when the update is installed.", percent: null, action: null };
    case "error": {
      const install = state.message.startsWith(INSTALL_PREFIX);
      const detail = install ? state.message.slice(INSTALL_PREFIX.length) : state.message.startsWith(CHECK_PREFIX) ? state.message.slice(CHECK_PREFIX.length) : state.message;
      return { badge: "error", busy: false, title: install ? "The update did not install" : "The update check failed", detail, percent: null, action: { kind: "check", label: "Try again" } };
    }
    default:
      return { badge: "none", busy: false, title: "Check for updates", detail: checked, percent: null, action: check };
  }
}

export function UpdatesPage({ appVersion }: { appVersion: string | null }) {
  const state = useUpdateState();
  const desktop = isTauri();
  const hero = updateHero(state, appVersion, lastChecked(), desktop);
  const [atStart, setAtStart] = useState(checkAtStart);
  const [shown, setShown] = useState(CHANGELOG_STEP);

  return (
    <div className="settings-page updates-page">
      <div className="settings-page-head">
        <h2 className="settings-page-title">Updates</h2>
      </div>

      <div className="update-hero" role="status" aria-live="polite">
        <span className={`update-hero-icon${hero.busy ? " busy" : ""}`} aria-hidden>
          <RefreshCw size={56} strokeWidth={2.25} />
          {hero.badge !== "none" && (
            <span className={`update-hero-badge ${hero.badge}`}>
              {hero.badge === "ok" ? <Check size={14} strokeWidth={3} /> : hero.badge === "error" ? <X size={14} strokeWidth={3} /> : "!"}
            </span>
          )}
        </span>
        <div className="update-hero-text">
          <span className="update-hero-title">{hero.title}</span>
          {hero.detail && <span className="update-hero-detail">{hero.detail}</span>}
          {hero.percent !== null && (
            <span className="update-hero-bar" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={hero.percent}>
              <span style={{ width: `${hero.percent}%` }} />
            </span>
          )}
          {hero.version && <span className="update-hero-detail">{hero.version}</span>}
        </div>
        {hero.action && (
          <button
            type="button"
            className="btn btn-primary update-hero-action"
            onClick={() => void (hero.action?.kind === "install" ? installUpdate() : checkForUpdate())}
          >
            {hero.action.label}
          </button>
        )}
      </div>

      {desktop && (
        <Row label="Check for updates when the app opens" help="Each time you open Harness, the app asks github.com for the newest version number. The request has no data about your projects.">
          <Switch
            checked={atStart}
            label="Check for updates when the app opens"
            onChange={(on) => {
              setAtStart(on);
              setCheckAtStart(on);
            }}
          />
        </Row>
      )}

      <div className="settings-page-head changelog-head">
        <h3 className="settings-section">Changelog</h3>
        {appVersion && <span className="settings-status">This version: {appVersion}</span>}
      </div>
      <div className="changelog-page">
        <Markdown text={sections.slice(0, shown).join("\n\n")} />
      </div>
      {shown < sections.length && (
        <button type="button" className="btn changelog-more" onClick={() => setShown((n) => n + CHANGELOG_STEP)}>
          Show more
        </button>
      )}
    </div>
  );
}
