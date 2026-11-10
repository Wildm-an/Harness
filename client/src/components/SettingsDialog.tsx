// The Settings dialog (Ctrl+,), as in the DeepSeek Harness and Claude apps: a list of pages on the
// left, and the page on the right. General and Appearance are here. Your Harness (the agent
// instructions and the memory) is in YourHarnessSettings.tsx. Local Models, Providers, and
// Computers are the screens that the sidebar opened before. Plugins are on the Capabilities page.

import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { RowsPending, useRowsPending } from "./Skeleton";
import { Switch } from "./Switch";
import { ArrowUpCircle, Boxes, Cable, FileCog, Monitor, Moon, Palette, RotateCcw, Rows2, Rows4, ScrollText, Settings, Sun, TriangleAlert, UserRound, Workflow, X, type LucideIcon } from "lucide-react";
import { SecretInput } from "./SecretInput";
import type { NewTaskPrompt, PermissionMode, UserSettings, WebSearchProvider } from "../daemon/protocol";
import type { WebKeyProvider } from "../lib/providerKeys";
import { useOverlay } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";
import { KEEP_IN_BACKGROUND_PREF, loadKeepInBackground } from "./QuitGuard";
import {
  CHAT_FONT_DEFAULT,
  CHAT_FONT_MAX,
  CHAT_FONT_MIN,
  CODE_FONT_MAX,
  SYSTEM_CODE_FONT,
  ACCENT_PRESETS,
  DARK_CODE_THEMES,
  DEFAULT_DARK_CODE,
  DEFAULT_LIGHT_CODE,
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
import { CHAT_WIDTHS, IDE_PRESETS, TERMINAL_HEIGHTS, ideOptions, setIdeOptions } from "../lib/ideLayout";
import { IdeSketch } from "./IdeSketch";
import { DEFAULT_IDE_OPTIONS, type IdeLayoutOptions } from "../layout/model";
import { MODES } from "./ModeMenu";
import { isTauri } from "../lib/tauri";
import { useLinksInPane } from "../lib/openLink";
import { compareVersions } from "../lib/version";
import { availableVersion, checkAtStart, checkForUpdate, installUpdate, setCheckAtStart, useUpdateState } from "../lib/updater";

export type SettingsPage = "general" | "harness" | "operating" | "appearance" | "models" | "connections" | "computers" | "changelog";

const PAGES: { id: SettingsPage; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "harness", label: "Your Harness", icon: UserRound },
  { id: "operating", label: "Operating Harness", icon: Workflow },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "models", label: "Local models", icon: Boxes },
  { id: "connections", label: "Providers", icon: Cable },
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

/** The forms of the Settings pages that are open now. A form with a Cancel button marks it `data-form-cancel`. */
function openForms(root: HTMLElement | null): HTMLFormElement[] {
  return [...(root?.querySelectorAll<HTMLFormElement>(".settings-body form") ?? [])];
}

/** A form with text in a field. An emptied field has nothing to lose. */
function hasText(form: HTMLFormElement): boolean {
  return [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].some(
    (f) => !["checkbox", "radio", "hidden", "button", "submit", "range", "color"].includes(f.type) && f.value.trim() !== "",
  );
}

export function SettingsDialog({
  page,
  onPage,
  onClose,
  closeRef,
  configPath,
  onOpenConfig,
  children,
}: {
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  onClose: () => void;
  closeRef?: MutableRefObject<(() => void) | null>; // The guarded close, for the Ctrl+, key of the app.
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

  // The forms that the user typed in (audit U9). A form that closes leaves the page, so it does not count.
  const changed = useRef(new WeakSet<HTMLFormElement>());
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const mark = (e: Event) => {
      const form = e.target instanceof Element ? e.target.closest("form") : null;
      if (form) changed.current.add(form);
    };
    // A small form that stays on the page (for example a token field) is saved by its submit. A form with
    // Cancel stays marked: after a failed save it still has the text of the user.
    const submitted = (e: Event) => {
      const form = e.target instanceof HTMLFormElement ? e.target : null;
      if (form && !form.querySelector("[data-form-cancel]")) changed.current.delete(form);
    };
    // A form that closes takes its focused button with it, and the focus falls to the page body, where Esc
    // does nothing. Then the focus goes back to the page in the dialog.
    // In the observer, Chrome can still give the removed element as the active element: check that it is gone.
    // A dialog over the settings (for example Storage) keeps its focus.
    const lost = new MutationObserver(() => {
      const active = document.activeElement;
      if (el.isConnected && (active === null || active === document.body || !active.isConnected)) {
        el.querySelector<HTMLElement>(".settings-nav [aria-current='page']")?.focus({ preventScroll: true });
      }
    });
    lost.observe(el, { childList: true, subtree: true });
    el.addEventListener("input", mark);
    el.addEventListener("change", mark);
    el.addEventListener("submit", submitted, true);
    return () => {
      lost.disconnect();
      el.removeEventListener("input", mark);
      el.removeEventListener("change", mark);
      el.removeEventListener("submit", submitted, true);
    };
  }, []);
  const isChanged = (f: HTMLFormElement) => changed.current.has(f) && hasText(f);

  // A question before typed text goes away: "after" runs on "Discard".
  const [ask, setAsk] = useState<{ title: string; after: () => void; focus: Element | null } | null>(null);
  const guard = (title: string, after: () => void) => {
    if (openForms(dialog.current).some(isChanged)) setAsk({ title, after, focus: document.activeElement });
    else after();
  };
  const requestClose = () => guard("Close the settings?", onClose);
  useEffect(() => {
    if (!closeRef) return;
    closeRef.current = requestClose;
    return () => {
      closeRef.current = null;
    };
  });

  /** Esc: an open form closes first (with its Cancel button), then the dialog. */
  const escape = () => {
    const form = openForms(dialog.current).filter((f) => f.querySelector("[data-form-cancel]")).pop();
    if (!form) {
      // A setting field saves when the focus leaves it: leave it first, so its text is not lost.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.matches("input, textarea") && !active.closest("form")) active.blur();
      return requestClose();
    }
    const cancel = () => form.querySelector<HTMLButtonElement>("[data-form-cancel]")?.click();
    if (isChanged(form)) setAsk({ title: "Discard the changes in the form?", after: cancel, focus: document.activeElement });
    else cancel();
  };

  return (
    <div
      className="modal-backdrop settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialog}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(e) => {
          // A field or a menu that used Esc (for example to close a list) keeps it.
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.stopPropagation();
            escape();
          }
        }}
      >
        {ask && (
          <ConfirmDialog
            title={ask.title}
            confirmLabel="Discard"
            onConfirm={() => {
              const after = ask.after;
              setAsk(null);
              after();
            }}
            onCancel={() => {
              const back = ask.focus;
              setAsk(null);
              if (back instanceof HTMLElement) back.focus();
            }}
          >
            The changes that you typed in the form are not saved.
          </ConfirmDialog>
        )}
        <header className="settings-head">
          <h1 id="settings-title">Settings</h1>
          <span className="spacer" />
          {onOpenConfig && (
            <button type="button" className="btn btn-small" onClick={onOpenConfig} title={configPath ?? undefined}>
              <FileCog size={14} aria-hidden /> Open configuration file
            </button>
          )}
          <button type="button" className="icon-btn ghost" onClick={requestClose} aria-label="Close the settings" title={`Close (Esc)`}>
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
                  onClick={() => p.id !== page && guard("Leave this page?", () => onPage(p.id))}
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

/**
 * One setting: the name and the help text on the left, the control on the right. A child row
 * (docs/UI_RULES.md R2) is indented. ``title`` is the tooltip of a locked row (R5).
 */
export function Row({ label, help, htmlFor, child, title, children }: {
  label: string;
  help?: string;
  htmlFor?: string;
  child?: boolean;
  title?: string;
  children: ReactNode;
}) {
  // While the value loads (RowsPending), a gray bar takes the place of the control (rule R8).
  const pending = useRowsPending();
  return (
    <div
      className={`${child ? "setting-row setting-row-child" : "setting-row"}${pending ? " pending" : ""}`}
      style={child ? { paddingLeft: 24 } : undefined}
      title={title}
      aria-busy={pending || undefined}
    >
      <div className="setting-text">
        {htmlFor && !pending ? <label htmlFor={htmlFor}>{label}</label> : <span className="setting-label">{label}</span>}
        {help && <span className="setting-help">{help}</span>}
      </div>
      <div className="setting-control">{pending ? <span className="skeleton skeleton-control" /> : children}</div>
    </div>
  );
}

export { Switch }; // The one switch of the app (Switch.tsx).

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
  ["Switch the Code and IDE view", "Ctrl+E"],
  ["Terminal", "Ctrl+`"],
  ["Browser", "Ctrl+Shift+B"],
  ["Changes", "Ctrl+Shift+D"],
  ["Files", "Ctrl+Shift+F"],
  ["Next permission mode", "Shift+Tab"],
  ["Add files to the prompt", "Ctrl+U"],
  ["Back and forward", "Alt+Left, Alt+Right"],
  ["New browser tab", "Ctrl+T"],
  ["New terminal tab", "Ctrl+Shift+T"],
  ["Stop the agent", "Esc"],
  ["Rewind the session", "Esc Esc"],
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
  const [monoKind, setMonoKind] = useState<"default" | "system" | "custom">(() =>
    codeFont() === "" ? "default" : codeFont() === SYSTEM_CODE_FONT ? "system" : "custom",
  );
  const [lightCode, setLightCode] = useState<LightCodeTheme>(lightCodeTheme);
  const [darkCode, setDarkCode] = useState<DarkCodeTheme>(darkCodeTheme);
  const [accent, setAccent] = useState(accentColor);
  const chooseAccent = (value: string) => {
    setAccentColor(value);
    setAccent(accentColor());
  };

  const [ide, setIde] = useState<IdeLayoutOptions>(ideOptions);
  const changeIde = (patch: Partial<IdeLayoutOptions>) => {
    const next = { ...ide, ...patch };
    setIde(next);
    setIdeOptions(next);
  };

  const reset = () => {
    resetAppearance();
    setIde({ ...DEFAULT_IDE_OPTIONS });
    setIdeOptions({ ...DEFAULT_IDE_OPTIONS });
    setAccent(accentColor());
    setFont(interfaceFont());
    setFontSize(chatFontSize());
    setWidth(transcriptWidth());
    setDense(savedDensity());
    setMono(codeFont());
    setMonoKind("default");
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
            const next: InterfaceFont = e.target.value === "plex" ? "plex" : "system";
            setFont(next);
            setInterfaceFont(next);
          }}
        >
          <option value="system">System font (default)</option>
          <option value="plex">IBM Plex Sans</option>
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

      <h3 className="settings-section">IDE view</h3>
      <p className="help settings-note">
        How the IDE view arranges its panes. A change applies to all projects. You can still drag and resize the panes.
      </p>

      <div className="setting-block">
        <span className="setting-label">Layout</span>
        <div className="ide-presets" role="radiogroup" aria-label="IDE layout">
          {IDE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={ide.preset === p.id}
              className={`ide-preset${ide.preset === p.id ? " active" : ""}`}
              onClick={() => changeIde({ preset: p.id })}
            >
              <IdeSketch preset={p.id} chatSide={ide.chatSide} />
              <span className="ide-preset-label">{p.label}</span>
              <span className="ide-preset-help">{p.help}</span>
            </button>
          ))}
        </div>
      </div>

      <Row label="Chat side" help="The side of the window for the chat with the agent." htmlFor="setting-chat-side">
        <select id="setting-chat-side" value={ide.chatSide} onChange={(e) => changeIde({ chatSide: e.target.value === "left" ? "left" : "right" })}>
          <option value="right">Right</option>
          <option value="left">Left</option>
        </select>
      </Row>

      <Row label="Chat width" help="The first width of the chat. Drag the edge to change it later." htmlFor="setting-chat-width">
        <select id="setting-chat-width" value={ide.chatShare} onChange={(e) => changeIde({ chatShare: Number(e.target.value) })}>
          {CHAT_WIDTHS.map(([n, text]) => (
            <option key={n} value={n}>
              {text}
            </option>
          ))}
        </select>
      </Row>

      <Row label="Terminal height" help="The first height of the terminal. The Focus layout has no terminal." htmlFor="setting-terminal-height">
        <select
          id="setting-terminal-height"
          value={ide.terminalShare}
          disabled={ide.preset === "focus"}
          onChange={(e) => changeIde({ terminalShare: Number(e.target.value) })}
        >
          {TERMINAL_HEIGHTS.map(([n, text]) => (
            <option key={n} value={n}>
              {text}
            </option>
          ))}
        </select>
      </Row>

      <h3 className="settings-section">Code appearance</h3>

      <Row label="Code font" help="The font of code blocks, the editor, and the terminal." htmlFor="setting-code-font-kind">
        <select
          id="setting-code-font-kind"
          value={monoKind}
          onChange={(e) => {
            const kind = e.target.value;
            setMonoKind(kind === "custom" ? "custom" : kind === "system" ? "system" : "default");
            if (kind === "custom") return; // The text field shows. The font changes when a name is saved.
            setCodeFont(kind === "system" ? SYSTEM_CODE_FONT : "");
            setMono(codeFont());
          }}
        >
          <option value="default">JetBrains Mono (default)</option>
          <option value="system">System font</option>
          <option value="custom">Custom…</option>
        </select>
      </Row>
      {monoKind === "custom" && (
        <Row label="Custom code font" help="The name of a font on this computer." htmlFor="setting-code-font">
          <TextField
            id="setting-code-font"
            value={mono === SYSTEM_CODE_FONT ? "" : mono}
            placeholder="e.g. Fira Code"
            maxLength={CODE_FONT_MAX}
            onSave={(v) => {
              setCodeFont(v);
              setMono(codeFont());
            }}
          />
        </Row>
      )}

      <Row label="Light code theme" help="The colors of the editor and the diff view in the light theme." htmlFor="setting-light-code">
        <select
          id="setting-light-code"
          value={lightCode}
          onChange={(e) => {
            const next = LIGHT_CODE_THEMES.find(([id]) => id === e.target.value)?.[0] ?? DEFAULT_LIGHT_CODE;
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
            const next = DARK_CODE_THEMES.find(([id]) => id === e.target.value)?.[0] ?? DEFAULT_DARK_CODE;
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
  webKeys,
  onSaveWebKey,
  onSet,
  onManageStorage,
}: {
  onManageStorage?: () => void; // Opens the Storage dialog. Absent: not connected.
  error: string | null; // The daemon did not save a setting.
  webKeys?: Record<WebKeyProvider, boolean>; // The web search API keys in the keychain.
  onSaveWebKey?: (provider: WebKeyProvider, key: string | null) => void;
  values: UserSettings | null; // null: loading, or not connected.
  connected: boolean;
  appVersion: string | null;
  daemonVersion: string | null;
  onSet: (changes: Partial<UserSettings>) => void;
}) {
  const [busy, setBusy] = useState<BusySend>(busySend);
  const [linksInPane, setLinksInPane] = useLinksInPane();
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
          {/* M14: the key makes each new text fade in. */}
          {status && (
            <span key={status} className="save-status">
              {status === "saving" ? "Saving…" : "Saved"}
            </span>
          )}
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

      {/* The rows of the daemon settings show gray bars until the values arrive (rule R8). */}
      <RowsPending.Provider value={connected && values === null}>
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

      <Row label="Subagents" help="Let the agent give tasks to subagents, also several at once in the background. Uses your limit faster.">
        <Switch checked={values?.subagents !== false} label="Subagents" disabled={off} onChange={(on) => set({ subagents: on })} />
      </Row>

      {/* "Archive inactive sessions", as in the Claude app. The daemon checks one time each hour. */}
      <Row
        label="Archive inactive sessions"
        help="Archive sessions after a stretch with no activity. Running sessions and uncommitted changes are kept."
        htmlFor="setting-auto-archive"
      >
        <select
          id="setting-auto-archive"
          value={String(values?.auto_archive_days ?? 0)}
          disabled={off}
          onChange={(e) => set({ auto_archive_days: Number(e.target.value) })}
        >
          {ARCHIVE_DAYS.map((days) => (
            <option key={days} value={days}>
              {days === 0 ? "Never" : days === 1 ? "1 day" : `${days} days`}
            </option>
          ))}
        </select>
      </Row>

      {/* The setting of the Claude app (Settings > Claude Code), with its labels. The daemon uses it in offer_session. */}
      <Row
        label="When you ask for an unrelated task"
        help="A task that is not part of the work of a session can run in its own linked session, or in another session that fits it better. Choose whether Harness asks each time, keeps it in the session you typed it in, or opens a linked session for it."
        htmlFor="setting-new-task"
      >
        <select
          id="setting-new-task"
          value={values?.new_task_prompt ?? "ask"}
          disabled={off}
          onChange={(e) => set({ new_task_prompt: e.target.value as NewTaskPrompt })}
        >
          <option value="ask">Ask me</option>
          <option value="here">Always do it here</option>
          <option value="new_session">Always start a new session</option>
        </select>
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

      <h3 className="settings-section">Web</h3>
      <Row label="Web search" help="The search provider of the agent. Off: the agent cannot search the web, but it can fetch pages." htmlFor="setting-web-search">
        <select
          id="setting-web-search"
          value={values?.web_search ?? "duckduckgo"}
          disabled={off}
          onChange={(e) => set({ web_search: e.target.value as WebSearchProvider })}
        >
          {WEB_SEARCH_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Row>
      {(values?.web_search === "brave" || values?.web_search === "tavily") && (
        <Row
          label="API key"
          help={`The key of ${values.web_search === "brave" ? "Brave Search" : "Tavily"}. The app keeps it in the keychain of this computer.`}
          htmlFor="setting-web-key"
        >
          <KeyField
            id="setting-web-key"
            saved={!!webKeys?.[values.web_search]}
            disabled={off || !onSaveWebKey}
            onSave={(key) => onSaveWebKey?.(values.web_search as WebKeyProvider, key)}
          />
        </Row>
      )}
      {values?.web_search === "searxng" && (
        <Row label="SearXNG URL" help="A SearXNG server with the JSON format on." htmlFor="setting-web-url">
          <TextField
            id="setting-web-url"
            value={values?.web_search_url ?? ""}
            placeholder="http://localhost:8080"
            disabled={off}
            onSave={(v) => set({ web_search_url: v || null })}
          />
        </Row>
      )}

      </RowsPending.Provider>

      <h3 className="settings-section">Browser</h3>
      <Row label="Open links in" help="Where a link in the chat opens, for example a link that the agent lists. Applies to this computer." htmlFor="setting-open-links">
        <select id="setting-open-links" value={linksInPane ? "pane" : "system"} onChange={(e) => setLinksInPane(e.target.value === "pane")}>
          <option value="pane">Built-in browser</option>
          <option value="system">Default browser</option>
        </select>
      </Row>

      <h3 className="settings-section">System</h3>
      {isTauri() && <BackgroundRows />}
      <Row label="Storage" help="See how much space Harness uses on this computer.">
        <button type="button" className="btn btn-small" disabled={!onManageStorage} onClick={onManageStorage}>
          Manage
        </button>
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

/** The R4 text when a setting does not save. */
const SAVE_FAILED = "Couldn't save the setting. Try again.";

/** "Run on startup" shows on only when its parent "Keep running in the background" is on. */
export function startupShown(keepInBackground: boolean, startup: boolean | null): boolean {
  return keepInBackground && startup === true;
}

async function autostart() {
  return import("@tauri-apps/plugin-autostart");
}

/**
 * "Keep running in the background" (a pref of this app) and its child row "Run on startup" (the
 * Run key of Windows, through the autostart plugin). The start at sign-in uses --background, so
 * the window stays hidden and the routines run.
 */
function BackgroundRows() {
  const [keep, setKeep] = useState(loadKeepInBackground);
  const [startup, setStartup] = useState<boolean | null>(null); // null: loading.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    autostart()
      .then((a) => a.isEnabled())
      .then((on) => live && setStartup(on))
      .catch(() => live && setStartup(false));
    return () => {
      live = false;
    };
  }, []);

  const changeKeep = async (on: boolean) => {
    setError(null);
    setKeep(on);
    savePref(KEEP_IN_BACKGROUND_PREF, on ? "1" : "0");
    // A start at sign-in with no window and no tray close makes no sense: turn it off too.
    if (!on && startup) {
      try {
        await (await autostart()).disable();
        setStartup(false);
      } catch {
        setError(SAVE_FAILED);
      }
    }
  };

  const changeStartup = async (on: boolean) => {
    setError(null);
    const old = startup;
    setStartup(on);
    try {
      const a = await autostart();
      if (on) await a.enable();
      else await a.disable();
    } catch {
      setStartup(old);
      setError(SAVE_FAILED);
    }
  };

  return (
    <>
      <Row label="Keep running in the background" help="Closing the window keeps Harness in the system tray, so routines can run.">
        <Switch checked={keep} label="Keep running in the background" onChange={(on) => void changeKeep(on)} />
      </Row>
      <Row
        label="Run on startup"
        help="Start Harness hidden when you sign in to Windows."
        child
        title={keep ? undefined : "Available when Keep running in the background is on"}
      >
        <Switch
          checked={startupShown(keep, startup)}
          label="Run on startup"
          disabled={!keep || startup === null}
          onChange={(on) => void changeStartup(on)}
        />
      </Row>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

// "Archive inactive sessions": the choices of the Claude app (0: never).
const ARCHIVE_DAYS = [0, 1, 2, 7, 14, 30];

// The search providers of the web_search tool (daemon web.py).
export const WEB_SEARCH_OPTIONS: [WebSearchProvider, string][] = [
  ["duckduckgo", "DuckDuckGo (no key)"],
  ["brave", "Brave Search"],
  ["tavily", "Tavily"],
  ["searxng", "SearXNG"],
  ["off", "Off"],
];

/** An API key field. A saved key shows as dots. It saves when the focus leaves it, or on Enter. */
function KeyField({ id, saved, disabled, onSave }: {
  id: string;
  saved: boolean;
  disabled?: boolean;
  onSave: (key: string | null) => void;
}) {
  const [text, setText] = useState("");
  const save = () => {
    if (!text.trim()) return;
    onSave(text.trim());
    setText("");
  };
  return (
    <span className="setting-key">
      <SecretInput
        what="the key"
        id={id}
        className="setting-text-input mono"
        value={text}
        placeholder={saved ? "••••••••  Saved" : "Paste the API key"}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      {saved && (
        <button type="button" className="btn btn-small" disabled={disabled} onClick={() => onSave(null)}>
          Remove
        </button>
      )}
    </span>
  );
}

type InstructionKey = "instructions_thinking" | "instructions_research" | "instructions_speaking" | "instructions_other";

// The agent instruction settings: the key, the label, the help text, and the placeholder.
export const INSTRUCTION_FIELDS: [InstructionKey, string, string, string][] = [
  ["instructions_thinking", "How to think", "How the agent plans and checks its work.", "e.g. Make a plan before you change code. Check each change with the tests."],
  ["instructions_research", "How to do research", "How the agent finds and checks information.", "e.g. Read the docs of a library before you use it. Give the source of each fact."],
  ["instructions_speaking", "How to speak", "The style and the length of the replies.", "e.g. Write short sentences. Do not use emoji."],
  ["instructions_other", "Other instructions", "All other rules for the agent.", "e.g. Do not commit. I make the commits."],
];

export const INSTRUCTION_MAX = 10_000; // The daemon limit, in characters.

/** A multi-line text field. It saves when the focus leaves it, or on Ctrl+Enter. */
export function TextAreaField({ id, value, placeholder, disabled, onSave }: {
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
    <textarea
      id={id}
      className="setting-textarea"
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      maxLength={INSTRUCTION_MAX}
      rows={3}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
      }}
    />
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
      <Row label="Check for updates when the app opens" help="The app asks github.com for the newest version number. The request has no data about your projects.">
        <Switch
          checked={atStart}
          label="Check for updates when the app opens"
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
