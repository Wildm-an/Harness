// The mode menu of an ACP session under the prompt box (the user asked for this): the permission modes of the
// agent that runs the session (Hermes Agent: "Default", "Accept Edits", "Don't Ask"; Claude Agent: the Claude
// modes). A choice changes the mode of the agent (daemon acp.mode, ACP session/set_mode), and the permission gate
// of Harness follows it (daemon acp.MODE_MAP). An agent with no Auto mode also gets "Auto": the agent asks, and
// Harness decides with its Auto mode model. The chip has the same look as the mode menu of Harness.

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { PermissionMode, SessionHarness } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { useAllowBypass } from "../lib/bypass";
import { MODES } from "./ModeMenu";

/** The mode of Harness Auto for an agent with no Auto mode (daemon acp.HARNESS_AUTO). */
export const HARNESS_AUTO = "harness:auto";

/** The Harness permission mode for a mode of an agent, as the daemon maps it (acp.MODE_MAP). */
const MODE_MAP: Record<string, PermissionMode> = {
  default: "default", ask: "default", manual: "default",
  acceptEdits: "acceptEdits", accept_edits: "acceptEdits", dont_ask: "acceptEdits",
  plan: "plan", read_only: "plan", readonly: "plan",
  auto: "auto",
  bypassPermissions: "bypassPermissions", bypass: "bypassPermissions", yolo: "bypassPermissions",
};

export function gateModeOf(id: string): PermissionMode {
  return id === HARNESS_AUTO ? "auto" : MODE_MAP[id] ?? "default";
}

export interface AgentMode {
  id: string;
  label: string;
  help: string;
  gate: PermissionMode; // The Harness permission mode that the gate uses: its icon and color.
}

/** The choices of the menu: the modes of the agent, then "Auto" of Harness when the agent offers it. Bypass modes
 * show only with "Allow bypass permissions mode" (rule C12), or when the agent is in one now. */
export function agentModes(harness: SessionHarness, allowBypass: boolean): AgentMode[] {
  const list: AgentMode[] = (harness.modes ?? []).map((m) => ({
    id: m.id,
    label: m.name || m.id,
    help: m.description,
    gate: gateModeOf(m.id),
  }));
  if (harness.harness_auto) {
    list.push({ id: HARNESS_AUTO, label: "Auto", help: "Harness checks each action with the Auto mode model", gate: "auto" });
  }
  return list.filter((m) => m.gate !== "bypassPermissions" || allowBypass || m.id === harness.mode);
}

/** The mode after ``id`` for Shift+Tab: the next mode of the menu that is not bypass. */
export function nextAgentMode(modes: AgentMode[], id: string | null | undefined): string | null {
  const cycle = modes.filter((m) => m.gate !== "bypassPermissions");
  if (cycle.length === 0) return null;
  const at = cycle.findIndex((m) => m.id === id);
  return cycle[(at + 1) % cycle.length].id;
}

export function AgentModeMenu({ harness, disabled, onChange }: {
  harness: SessionHarness;
  disabled?: boolean; // A turn runs: the agent changes its mode between turns.
  onChange: (mode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  const allowBypass = useAllowBypass();
  const modes = agentModes(harness, allowBypass);
  const current = modes.find((m) => m.id === harness.mode) ?? modes[0];
  const look = MODES.find((m) => m.mode === current?.gate) ?? MODES[0];
  const Icon = look.icon;

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!current) return null;

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
        className={`prompt-chip mode-${current.gate}${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={`${harness.name}: ${current.label}${current.help ? `. ${current.help.replace(/\.$/, "")}` : ""}. Shift+Tab changes the mode.`}
      >
        <Icon size={13} aria-hidden />
        <span className="prompt-chip-text">{current.label}</span>
      </button>
      {open && (
        <div className="menu model-dropdown up mode-dropdown" role="menu" aria-label={`Mode of ${harness.name}`}>
          <div className="menu-heading">Mode · {harness.name}</div>
          {modes.map((m) => {
            const ItemIcon = (MODES.find((x) => x.mode === m.gate) ?? MODES[0]).icon;
            return (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={m.id === current.id}
                className={`mode-item mode-${m.gate}`}
                onClick={() => {
                  setOpen(false);
                  if (m.id !== current.id) onChange(m.id);
                }}
              >
                <ItemIcon size={15} aria-hidden />
                <span className="mode-text">
                  <span className="mode-label">{m.label}</span>
                  {m.help && <span className="mode-help">{m.help}</span>}
                </span>
                <span className="menu-check">{m.id === current.id && <Check size={14} aria-hidden />}</span>
              </button>
            );
          })}
          <p className="menu-note">The modes of {harness.name}. Harness asks and decides as the mode says. Shift+Tab changes the mode.</p>
        </div>
      )}
    </div>
  );
}
