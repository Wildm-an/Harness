import { useEffect, useRef, useState } from "react";
import { Check, ClipboardList, FilePenLine, RefreshCw, ShieldCheck, ShieldOff, type LucideIcon } from "lucide-react";
import type { PermissionMode } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";

// The labels and descriptions of the Claude desktop mode menu (docs/UI_RULES.md C11). The chip under the prompt box shows the label.
export const MODES: { mode: PermissionMode; label: string; help: string; icon: LucideIcon }[] = [
  { mode: "default", label: "Manual", help: "Always ask before making changes", icon: ShieldCheck },
  { mode: "acceptEdits", label: "Accept edits", help: "Automatically accept all file edits", icon: FilePenLine },
  { mode: "plan", label: "Plan", help: "Create a plan before making changes", icon: ClipboardList },
  { mode: "auto", label: "Auto", help: "Claude handles permission decisions", icon: RefreshCw },
  { mode: "bypassPermissions", label: "Bypass permissions", help: "Accepts all permissions", icon: ShieldOff },
];

// Shift+Tab goes through these modes, as in Claude Code. Bypass is only in the menu.
const CYCLE: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];

/** The mode of the last session on a connection. The start page selects it. */
export function lastMode(scope: string): PermissionMode {
  const saved = loadPref(`mode.${scope}`, "default");
  return MODES.some((m) => m.mode === saved) ? (saved as PermissionMode) : "default";
}

export function saveLastMode(scope: string, mode: PermissionMode): void {
  savePref(`mode.${scope}`, mode);
}

/** The mode after ``mode`` for Shift+Tab. */
export function nextMode(mode: PermissionMode): PermissionMode {
  const i = CYCLE.indexOf(mode);
  return CYCLE[(i + 1) % CYCLE.length];
}

/** The permission mode of the session: text under the prompt box, with a menu. */
export function ModeMenu({ mode, onChange, up = true }: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  up?: boolean; // Open above the chip (under the prompt box of a session). The start page opens it below.
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  const current = MODES.find((m) => m.mode === mode) ?? MODES[0];
  const Icon = current.icon;

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div className="model-menu mode-menu" ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`prompt-chip mode-${mode}${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${current.label}: ${current.help}. Shift+Tab changes the mode.`}
      >
        <Icon size={13} aria-hidden />
        <span className="prompt-chip-text">{current.label}</span>
      </button>
      {open && (
        <div className={`menu model-dropdown${up ? " up" : ""} mode-dropdown`} role="menu" aria-label="Mode">
          <div className="menu-heading">Mode</div>
          {MODES.map((m) => {
            const ItemIcon = m.icon;
            return (
              <button
                key={m.mode}
                type="button"
                role="menuitemradio"
                aria-checked={m.mode === mode}
                className={`mode-item mode-${m.mode}`}
                onClick={() => {
                  setOpen(false);
                  if (m.mode !== mode) onChange(m.mode);
                }}
              >
                <ItemIcon size={15} aria-hidden />
                <span className="mode-text">
                  <span className="mode-label">{m.label}</span>
                  <span className="mode-help">{m.help}</span>
                </span>
                <span className="menu-check">{m.mode === mode && <Check size={14} aria-hidden />}</span>
              </button>
            );
          })}
          <p className="menu-note">Shift+Tab in the prompt box changes the mode.</p>
        </div>
      )}
    </div>
  );
}
