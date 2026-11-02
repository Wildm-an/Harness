// The Settings dialog (Ctrl+,), as in the DeepSeek Harness and Claude apps: a list of pages on the
// left, and the page on the right. General and Appearance are here. Plugins, Local Models,
// Connections, and Computers are the screens that the sidebar opened before.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpCircle, Boxes, Cable, FileCog, Monitor, Moon, Palette, Puzzle, RotateCcw, Rows2, Rows4, ScrollText, Settings, Sun, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { PermissionMode, UserSettings } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";
import {
  CHAT_FONT_DEFAULT,
  CHAT_FONT_MAX,
  CHAT_FONT_MIN,
  CODE_FONT_MAX,
  ACCENT_PRESETS,
  DARK_CODE_THEMES,
  LIGHT_CODE_THEMES,
  accentColor,
  appearance as savedAppearance,
  setAccentColor,
  chatFontSize,
  codeFont,
  darkCodeTheme,
  density as savedDensity,
  interfaceFont,
  lightCodeTheme,
  resetAppearance,
  setAppearance,
  setChatFontSize,
  setCodeFont,
  setDarkCodeTheme,
  setDensity,
  setInterfaceFont,
  setLightCodeTheme,
  setTranscriptWidth,
  transcriptWidth,
  type Appearance,
  type DarkCodeTheme,
  type Density,
  type InterfaceFont,
  type LightCodeTheme,
  type TranscriptWidth,
} from "../lib/theme";
import { MODES } from "./ModeMenu";
import { isTauri } from "../lib/tauri";
import { compareVersions } from "../lib/version";
import { availableVersion, checkAtStart, checkForUpdate, installUpdate, setCheckAtStart, useUpdateState } from "../lib/updater";

export type SettingsPage = "general" | "appearance" | "plugins" | "models" | "connections" | "computers" | "changelog";

const PAGES: { id: SettingsPage; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "models", label: "Local Models", icon: Boxes },
  { id: "connections", label: "Connections", icon: Cable },
  { id: "computers", label: "Computers", icon: Monitor },
  { id: "changelog", label: "Changelog", icon: ScrollText },
];

export const SETTINGS_SHORTCUT = "Ctrl+,";

/** Ctrl+, (Cmd+, on macOS) opens or closes the Settings dialog. */
export function isSettingsShortcut(e: Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  if (e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return false;
  return e.code === "Comma" || e.key === ",";
}

// What Enter does while the agent works: put the message in the queue, stop the turn and send it,
// or give it to the agent at its next step (steer).
export type BusySend = "queue" | "interrupt" | "steer";
const BUSY_SEND_PREF = "busySend";

function toBusySend(value: string): BusySend {
  return value === "interrupt" || value === "steer" ? value : "queue";
}

export function busySend(): BusySend {
  return toBusySend(loadPref(BUSY_SEND_PREF, "queue"));
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

/** A number field. A step with the arrows saves at once. Typed text saves on Enter or when the focus leaves it. */
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
  const save = (raw = text) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || raw.trim() === "") return setText(String(value));
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
        onChange={(e) => {
          // The spin buttons and the arrow keys send an input event with no inputType. Typed text has one.
          if ((e.nativeEvent as InputEvent).inputType) setText(e.target.value);
          else save(e.target.value);
        }}
        onBlur={() => save()}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      {unit && <span className="setting-unit">{unit}</span>}
    </span>
  );
}

const SHORTCUTS: [string, string][] = [
  ["New session", "Ctrl+N"],
  ["Settings", "Ctrl+,"],
  ["Search the sessions", "Ctrl+K"],
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

/** A row of large choice buttons, for the theme and the density. */
function Choices<T extends string>({ label, value, choices, onChoose }: {
  label: string;
  value: T;
  choices: [T, string, LucideIcon][];
  onChoose: (id: T) => void;
}) {
  return (
    <div className="appearance-choices" role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${choices.length}, 1fr)` }}>
      {choices.map(([id, text, Icon]) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={`appearance-choice${value === id ? " active" : ""}`} onClick={() => onChoose(id)}>
          <Icon size={16} aria-hidden />
          {text}
        </button>
      ))}
    </div>
  );
}

const WIDTH_CHOICES: [TranscriptWidth, string][] = [
  ["narrow", "Narrow"],
  ["default", "Default"],
  ["wide", "Wide"],
  ["full", "Full width"],
];

const CODE_PREVIEW = "function greet(name) {\n  return `Hello, ${name}!`; // 0O 1lI {}[]\n}";

/** The Appearance page: the look of this app on this computer. A change shows at once. */
export function AppearanceSettings() {
  const [look, setLook] = useState<Appearance>(savedAppearance);
  const [font, setFont] = useState<InterfaceFont>(interfaceFont);
  const [fontSize, setFontSize] = useState(chatFontSize);
  const [width, setWidth] = useState<TranscriptWidth>(transcriptWidth);
  const [dense, setDense] = useState<Density>(savedDensity);
  const [mono, setMono] = useState(codeFont);
  const [lightCode, setLightCode] = useState<LightCodeTheme>(lightCodeTheme);
  const [darkCode, setDarkCode] = useState<DarkCodeTheme>(darkCodeTheme);
  const [accent, setAccent] = useState(accentColor);
  const chooseAccent = (value: string) => {
    setAccentColor(value);
    setAccent(accentColor());
  };

  const reset = () => {
    resetAppearance();
    setAccent(accentColor());
    setFont(interfaceFont());
    setFontSize(chatFontSize());
    setWidth(transcriptWidth());
    setDense(savedDensity());
    setMono(codeFont());
    setLightCode(lightCodeTheme());
    setDarkCode(darkCodeTheme());
  };

  return (
    <div className="settings-page">
      <div className="settings-page-head">
        <h2 className="settings-page-title">Appearance</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={reset} title="Put the accent color, the fonts, the sizes, and the code themes back to the defaults. The theme stays.">
          <RotateCcw size={14} aria-hidden /> Reset to defaults
        </button>
      </div>
      <p className="help settings-note">These settings apply to this computer only.</p>

      <div className="setting-block">
        <span className="setting-label">Theme</span>
        <Choices<Appearance>
          label="Theme"
          value={look}
          choices={[
            ["light", "Light", Sun],
            ["dark", "Dark", Moon],
            ["system", "System", Monitor],
          ]}
          onChoose={(a) => {
            setLook(a);
            setAppearance(a);
          }}
        />
      </div>

      <Row label="Accent color" help="The color of the primary buttons, the links, and the selected items. White shows as black in the light theme.">
        <div className="accent-swatches" role="radiogroup" aria-label="Accent color">
          {ACCENT_PRESETS.map(([id, label, color]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={accent === id}
              aria-label={label}
              title={label}
              className={`accent-swatch${accent === id ? " active" : ""}`}
              style={{ background: color }}
              onClick={() => chooseAccent(id)}
            />
          ))}
          <label
            className={`accent-swatch accent-custom${accent.startsWith("#") ? " active" : ""}`}
            title="Custom color…"
            style={accent.startsWith("#") ? { background: accent } : undefined}
          >
            <input
              type="color"
              aria-label="Custom accent color"
              value={accent.startsWith("#") ? accent : "#c6613f"}
              onChange={(e) => chooseAccent(e.target.value)}
            />
          </label>
        </div>
      </Row>

      <Row label="Interface font" help="Font for the whole interface — menus, sidebars, and panels." htmlFor="setting-interface-font">
        <select
          id="setting-interface-font"
          value={font}
          onChange={(e) => {
            const next: InterfaceFont = e.target.value === "system" ? "system" : "default";
            setFont(next);
            setInterfaceFont(next);
          }}
        >
          <option value="default">IBM Plex Sans (default)</option>
          <option value="system">System font</option>
        </select>
      </Row>

      <Row label="Text size" help={`The text of the conversation. Default: ${CHAT_FONT_DEFAULT} px.`} htmlFor="setting-font-size">
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

      <Row label="Transcript width" help="The maximum width of the conversation and the prompt box." htmlFor="setting-transcript-width">
        <select
          id="setting-transcript-width"
          value={width}
          onChange={(e) => {
            const next = WIDTH_CHOICES.find(([id]) => id === e.target.value)?.[0] ?? "default";
            setWidth(next);
            setTranscriptWidth(next);
          }}
        >
          {WIDTH_CHOICES.map(([id, text]) => (
            <option key={id} value={id}>
              {text}
            </option>
          ))}
        </select>
      </Row>

      <div className="setting-block">
        <span className="setting-label">Density</span>
        <span className="setting-help">The height of the rows and the size of the text in the sidebar.</span>
        <Choices<Density>
          label="Density"
          value={dense}
          choices={[
            ["compact", "Compact", Rows4],
            ["comfortable", "Comfortable", Rows2],
          ]}
          onChoose={(d) => {
            setDense(d);
            setDensity(d);
          }}
        />
      </div>

      <h3 className="settings-section">Code appearance</h3>

      <Row label="Code font" help="The font of code blocks, the editor, and the terminal. Empty: JetBrains Mono." htmlFor="setting-code-font">
        <TextField
          id="setting-code-font"
          value={mono}
          placeholder="e.g. JetBrains Mono"
          maxLength={CODE_FONT_MAX}
          onSave={(v) => {
            setCodeFont(v);
            setMono(codeFont());
          }}
        />
      </Row>

      <Row label="Light code theme" help="The colors of the editor and the diff view in the light theme." htmlFor="setting-light-code">
        <select
          id="setting-light-code"
          value={lightCode}
          onChange={(e) => {
            const next = LIGHT_CODE_THEMES.find(([id]) => id === e.target.value)?.[0] ?? "harness-light";
            setLightCode(next);
            setLightCodeTheme(next);
          }}
        >
          {LIGHT_CODE_THEMES.map(([id, text]) => (
            <option key={id} value={id}>
              {text}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Dark code theme" help="The colors of the editor and the diff view in the dark theme." htmlFor="setting-dark-code">
        <select
          id="setting-dark-code"
          value={darkCode}
          onChange={(e) => {
            const next = DARK_CODE_THEMES.find(([id]) => id === e.target.value)?.[0] ?? "harness-dark";
            setDarkCode(next);
            setDarkCodeTheme(next);
          }}
        >
          {DARK_CODE_THEMES.map(([id, text]) => (
            <option key={id} value={id}>
              {text}
            </option>
          ))}
        </select>
      </Row>

      <pre className="code-font-preview" aria-label="Code font preview">
        <code>{CODE_PREVIEW}</code>
      </pre>
    </div>
  );
}

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

      <Row label="Send while the agent works" help="Queue: send after the turn. Interrupt: stop the turn and send. Steer: the agent reads it at its next step." htmlFor="setting-busy-send">
        <select
          id="setting-busy-send"
          value={busy}
          onChange={(e) => {
            const next = toBusySend(e.target.value);
            setBusy(next);
            savePref(BUSY_SEND_PREF, next);
          }}
        >
          <option value="queue">Queue</option>
          <option value="interrupt">Interrupt</option>
          <option value="steer">Steer</option>
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
        <NumberField
          id="setting-tool-calls"
          value={values?.max_tool_calls ?? 250}
          min={1}
          max={500}
          disabled={off || values?.limit_tool_calls === false}
          onSave={(n) => set({ max_tool_calls: n })}
        />
      </Row>

      <Row label="Limit tool calls" help="Off: the agent works until it stops, or until you stop it. A loop can then run for a long time.">
        <Switch
          checked={values?.limit_tool_calls !== false}
          label="Limit tool calls"
          disabled={off}
          onChange={(on) => set({ limit_tool_calls: on })}
        />
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
        {appVersion && daemonVersion && compareVersions(appVersion, daemonVersion) !== 0 && (
          <span className="settings-version-warn">
            {" "}
            <TriangleAlert size={12} aria-hidden /> The versions are different.
          </span>
        )}
      </p>
    </div>
  );
}

function TextField({ id, value, placeholder, disabled, maxLength, onSave }: {
  id: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
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
      maxLength={maxLength}
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

/** Check for a new version of the app, and install it. The app also checks once when it starts, if the setting is on. */
function UpdatesRow() {
  const state = useUpdateState();
  const [atStart, setAtStart] = useState(checkAtStart);
  const help =
    state.kind === "checking"
      ? "Looking for a new version…"
      : state.kind === "none"
        ? "This is the newest version."
        : state.kind === "available"
          ? `Version ${state.update.version} is available.`
          : state.kind === "installing"
            ? `Installing${state.percent !== null ? `: ${state.percent}%` : "…"} The app starts again when the update is installed.`
            : atStart
              ? "The app looks for a new version each time it starts."
              : "The app looks for a new version only when you click the button.";

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
      <Row label="Check for updates at start" help="The app asks github.com for the newest version number. The request has no data about your projects.">
        <Switch
          checked={atStart}
          label="Check for updates at start"
          onChange={(on) => {
            setAtStart(on);
            setCheckAtStart(on);
          }}
        />
      </Row>
      {state.kind === "error" && (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      )}
    </>
  );
}
