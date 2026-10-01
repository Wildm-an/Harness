// The Settings dialog (Ctrl+,), as in the DeepSeek Harness and Claude apps: a list of pages on the
// left, and the page on the right. General is here. Local Models, Connections, and Computers are
// the screens that the sidebar opened before.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpCircle, Boxes, Cable, FileCog, Monitor, Moon, Rows2, Rows4, Settings, Sun, X, type LucideIcon } from "lucide-react";
import type { PermissionMode, UserSettings } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";
import {
  CHAT_FONT_MAX,
  CHAT_FONT_MIN,
  appearance as savedAppearance,
  chatFontSize,
  density as savedDensity,
  setAppearance,
  setChatFontSize,
  setDensity,
  type Appearance,
  type Density,
} from "../lib/theme";
import { MODES } from "./ModeMenu";
import { isTauri } from "../lib/tauri";
import { availableVersion, checkForUpdate, installUpdate, useUpdateState } from "../lib/updater";

export type SettingsPage = "general" | "models" | "connections" | "computers";

const PAGES: { id: SettingsPage; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "models", label: "Local Models", icon: Boxes },
  { id: "connections", label: "Connections", icon: Cable },
  { id: "computers", label: "Computers", icon: Monitor },
];

export const SETTINGS_SHORTCUT = "Ctrl+,";

/** Ctrl+, (Cmd+, on macOS) opens or closes the Settings dialog. */
export function isSettingsShortcut(e: Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  if (e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return false;
  return e.code === "Comma" || e.key === ",";
}

// What Enter does while the agent works: put the message in the queue, or stop the turn and send it.
export type BusySend = "queue" | "interrupt";
const BUSY_SEND_PREF = "busySend";

export function busySend(): BusySend {
  return loadPref(BUSY_SEND_PREF, "queue") === "interrupt" ? "interrupt" : "queue";
}

export function SettingsDialog({
  page,
  onPage,
  onClose,
  configPath,
  onOpenConfig,
  children,
}: {
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  onClose: () => void;
  configPath: string | null; // ~/.harness/settings.json of the daemon. null: not connected.
  onOpenConfig: (() => void) | null; // null: the file is on another computer.
  children: ReactNode; // The current page.
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const update = availableVersion(useUpdateState());
  useOverlay(true);

  // The focus goes into the dialog, and back to the button that opened it when the dialog closes.
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>(".settings-nav [aria-current='page']")?.focus();
    const back = opener.current;
    return () => {
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="settings-head">
          <h1 id="settings-title">Settings</h1>
          <span className="spacer" />
          {onOpenConfig && (
            <button type="button" className="btn btn-small" onClick={onOpenConfig} title={configPath ?? undefined}>
              <FileCog size={14} aria-hidden /> Open configuration file
            </button>
          )}
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close the settings" title={`Close (Esc)`}>
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="settings-main">
          <nav className="settings-nav" aria-label="Settings pages">
            {PAGES.map((p) => {
              const Icon = p.icon;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`settings-nav-item${p.id === page ? " active" : ""}`}
                  aria-current={p.id === page ? "page" : undefined}
                  onClick={() => onPage(p.id)}
                >
                  <Icon size={16} aria-hidden />
                  {p.label}
                  {p.id === "general" && update && (
                    <span className="settings-nav-dot" role="img" aria-label={`Version ${update} is available`} />
                  )}
                </button>
              );
            })}
          </nav>
          <div className="settings-body">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** One setting: the name and the help text on the left, the control on the right. */
function Row({ label, help, htmlFor, children }: { label: string; help?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="setting-label">{label}</span>}
        {help && <span className="setting-help">{help}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden />
    </button>
  );
}

/** A number field that saves on Enter or when the focus leaves it. */
function NumberField({ id, value, min, max, unit, disabled, onSave }: {
  id: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  onSave: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const save = () => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n) || text.trim() === "") return setText(String(value));
    const clamped = Math.min(max, Math.max(min, n));
    setText(String(clamped));
    if (clamped !== value) onSave(clamped);
  };
  return (
    <span className="setting-number">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      {unit && <span className="setting-unit">{unit}</span>}
    </span>
  );
}

const SHORTCUTS: [string, string][] = [
  ["New session", "Ctrl+N"],
  ["Settings", "Ctrl+,"],
  ["Side chat", "Ctrl+;"],
  ["Show or hide the sidebar", "Ctrl+B"],
  ["Terminal", "Ctrl+`"],
  ["Browser", "Ctrl+Shift+B"],
  ["Diff", "Ctrl+Shift+D"],
  ["Files", "Ctrl+Shift+F"],
  ["Next permission mode", "Shift+Tab"],
  ["Back and forward", "Alt+Left, Alt+Right"],
  ["New browser tab", "Ctrl+T"],
  ["New terminal tab", "Ctrl+Shift+T"],
  ["Interrupt the agent", "Esc"],
];

/** The General page: the settings of this app, and the user settings of the daemon. */
export function GeneralSettings({
  values,
  connected,
  appVersion,
  daemonVersion,
  error,
  onSet,
}: {
  error: string | null; // The daemon did not save a setting.
  values: UserSettings | null; // null: loading, or not connected.
  connected: boolean;
  appVersion: string | null;
  daemonVersion: string | null;
  onSet: (changes: Partial<UserSettings>) => void;
}) {
  const [look, setLook] = useState<Appearance>(savedAppearance);
  const [dense, setDense] = useState<Density>(savedDensity);
  const [fontSize, setFontSize] = useState(chatFontSize);
  const [busy, setBusy] = useState<BusySend>(busySend);
  const off = !connected || values === null;
  // "Saving" until the daemon sends the new values, then "Saved" for a moment.
  const [status, setStatus] = useState<"" | "saving" | "saved">("");
  const set = (changes: Partial<UserSettings>) => {
    setStatus("saving");
    onSet(changes);
  };
  useEffect(() => {
    if (status !== "saving") return;
    setStatus("saved");
    const timer = window.setTimeout(() => setStatus(""), 1500);
    return () => window.clearTimeout(timer);
  }, [values]);
  useEffect(() => {
    if (error) setStatus("");
  }, [error]);

  const choose = (a: Appearance) => {
    setLook(a);
    setAppearance(a);
  };

  return (
    <div className="settings-page">
      <div className="settings-page-head">
        <h2 className="settings-page-title">General</h2>
        <span className="settings-status" aria-live="polite">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {isTauri() && <UpdateBanner appVersion={appVersion} />}

      <div className="setting-block">
        <span className="setting-label">Appearance</span>
        <div className="appearance-choices" role="radiogroup" aria-label="Appearance">
          {(
            [
              ["light", "Light", Sun],
              ["dark", "Dark", Moon],
              ["system", "System", Monitor],
            ] as [Appearance, string, LucideIcon][]
          ).map(([id, label, Icon]) => (
            <button key={id} type="button" role="radio" aria-checked={look === id} className={`appearance-choice${look === id ? " active" : ""}`} onClick={() => choose(id)}>
              <Icon size={16} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-block">
        <span className="setting-label">Density</span>
        <span className="setting-help">The height of the rows and the size of the text in the sidebar.</span>
        <div className="appearance-choices" role="radiogroup" aria-label="Density">
          {(
            [
              ["compact", "Compact", Rows4],
              ["comfortable", "Comfortable", Rows2],
            ] as [Density, string, LucideIcon][]
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={dense === id}
              className={`appearance-choice${dense === id ? " active" : ""}`}
              onClick={() => {
                setDense(id);
                setDensity(id);
              }}
            >
              <Icon size={16} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      <Row label="Font size" help="Only the text of the conversation." htmlFor="setting-font-size">
        <NumberField
          id="setting-font-size"
          value={fontSize}
          min={CHAT_FONT_MIN}
          max={CHAT_FONT_MAX}
          unit="px"
          onSave={(n) => {
            setFontSize(n);
            setChatFontSize(n);
          }}
        />
      </Row>

      <Row label="Send while the agent works" help="What Enter and the send button do during a turn." htmlFor="setting-busy-send">
        <select
          id="setting-busy-send"
          value={busy}
          onChange={(e) => {
            const next = e.target.value === "interrupt" ? "interrupt" : "queue";
            setBusy(next);
            savePref(BUSY_SEND_PREF, next);
          }}
        >
          <option value="queue">Queue the message</option>
          <option value="interrupt">Stop the turn and send</option>
        </select>
      </Row>

      <h3 className="settings-section">The agent</h3>
      {!connected && <p className="help settings-note">Connect to a computer to change the settings of its daemon.</p>}

      <Row label="Default permission mode" help="For a project that has no mode of its own." htmlFor="setting-mode">
        <select
          id="setting-mode"
          value={values?.permission_mode ?? "default"}
          disabled={off}
          onChange={(e) => set({ permission_mode: e.target.value as PermissionMode })}
        >
          {MODES.map((m) => (
            <option key={m.mode} value={m.mode}>
              {m.label}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Prompt suggestions" help="After a turn, the model suggests the next prompt. Tab puts it in the box.">
        <Switch checked={values?.prompt_suggestions ?? true} label="Prompt suggestions" disabled={off} onChange={(on) => set({ prompt_suggestions: on })} />
      </Row>

      <Row label="Check the app after UI changes" help="The agent opens the preview and checks each change to the UI.">
        <Switch checked={values?.auto_verify ?? false} label="Check the app after UI changes" disabled={off} onChange={(on) => set({ auto_verify: on })} />
      </Row>

      <Row label="Tool calls in a turn" help="The agent stops after this many tool calls, and asks to continue." htmlFor="setting-tool-calls">
        <NumberField id="setting-tool-calls" value={values?.max_tool_calls ?? 50} min={1} max={500} disabled={off} onSave={(n) => set({ max_tool_calls: n })} />
      </Row>

      <Row label="Command timeout" help="The default time limit of a command of the agent." htmlFor="setting-bash-timeout">
        <NumberField id="setting-bash-timeout" value={values?.bash_timeout ?? 120} min={1} max={3600} unit="s" disabled={off} onSave={(n) => set({ bash_timeout: n })} />
      </Row>

      <Row label="Terminal shell" help="The shell of the terminal pane. Empty: the default shell." htmlFor="setting-shell">
        <TextField id="setting-shell" value={values?.terminal_shell ?? ""} placeholder="pwsh.exe" disabled={off} onSave={(v) => set({ terminal_shell: v || null })} />
      </Row>

      <h3 className="settings-section">Keyboard shortcuts</h3>
      <dl className="shortcut-list">
        {SHORTCUTS.map(([action, keys]) => (
          <div key={action} className="shortcut-row">
            <dt>{action}</dt>
            <dd>
              <kbd>{keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>

      {isTauri() && <UpdatesRow />}

      <p className="settings-version">
        {appVersion && <>App version {appVersion}</>}
        {appVersion && daemonVersion && " · "}
        {daemonVersion && <>Daemon version {daemonVersion}</>}
      </p>
    </div>
  );
}

function TextField({ id, value, placeholder, disabled, onSave }: {
  id: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onSave: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const save = () => {
    if (text.trim() !== value) onSave(text.trim());
  };
  return (
    <input
      id={id}
      className="setting-text-input mono"
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && save()}
    />
  );
}

/** The update at the top of the General page, while a new version is available or installs. */
function UpdateBanner({ appVersion }: { appVersion: string | null }) {
  const state = useUpdateState();
  const version = availableVersion(state);
  if (!version) return null;
  return (
    <div className="update-banner" role="status">
      <ArrowUpCircle size={18} aria-hidden className="update-banner-icon" />
      <div className="update-banner-text">
        <span className="update-banner-title">Harness {version} is available</span>
        <span className="setting-help">
          {state.kind === "installing"
            ? `Installing${state.percent !== null ? `: ${state.percent}%` : "…"} The app starts again when the update is installed.`
            : appVersion
              ? `You have version ${appVersion}. The app closes for the install, and then starts again.`
              : "The app closes for the install, and then starts again."}
        </span>
      </div>
      {state.kind === "available" && (
        <button type="button" className="btn btn-primary btn-small" onClick={() => void installUpdate()}>
          Install and restart
        </button>
      )}
    </div>
  );
}

/** Check for a new version of the app, and install it. The app also checks once when it starts. */
function UpdatesRow() {
  const state = useUpdateState();
  const help =
    state.kind === "checking"
      ? "Looking for a new version…"
      : state.kind === "none"
        ? "This is the newest version."
        : state.kind === "available"
          ? `Version ${state.update.version} is available.`
          : state.kind === "installing"
            ? `Installing${state.percent !== null ? `: ${state.percent}%` : "…"} The app starts again when the update is installed.`
            : "The app looks for a new version each time it starts.";

  return (
    <>
      <h3 className="settings-section">Updates</h3>
      <Row label="App updates" help={help}>
        {state.kind === "available" ? (
          <button type="button" className="btn btn-primary btn-small" onClick={() => void installUpdate()}>
            Install and restart
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void checkForUpdate()}
            disabled={state.kind === "checking" || state.kind === "installing"}
          >
            Check for updates
          </button>
        )}
      </Row>
      {state.kind === "error" && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
    </>
  );
}
