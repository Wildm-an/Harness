// The model menu under the prompt box, as in the Claude app: "Model · this session" with the models of
// the online providers, "Effort" and "Local models" submenus, and "Show providers" at the bottom.
// The button shows the model name and the effort level, with no icon.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, LoaderCircle, TriangleAlert } from "lucide-react";
import type { Effort } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { modelName } from "../lib/modelName";

export interface ModelList {
  items: string[]; // "provider/model", from the connections that are on.
  errors: { provider: string; message: string }[];
  default?: string | null; // The model of "Default model" now ("provider/model"). null or absent: not known.
  providers?: string[]; // The names of the providers that are on. Absent: not known (an older daemon).
  noImages?: string[]; // The models ("provider/model") that the daemon knows have no image input.
}

/** The effort levels, as in the Claude app. The daemon saves the choice of the user. With no choice: High. */
export const DEFAULT_EFFORT: Effort = "high";

export const EFFORT_LEVELS: { value: Effort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
  { value: "max", label: "Max" },
];

export const EFFORT_HELP = "Higher effort means more thorough responses, but takes longer and uses your limits faster.";

export function effortLabel(value: Effort | null | undefined): string {
  return EFFORT_LEVELS.find((l) => l.value === (value ?? DEFAULT_EFFORT))?.label ?? "High";
}

/** The models by connection, in the order of the list. */
export function groupModels(items: string[]): { provider: string; models: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const spec of items) {
    const slash = spec.indexOf("/");
    const provider = slash > 0 ? spec.slice(0, slash) : "";
    groups.set(provider, [...(groups.get(provider) ?? []), spec]);
  }
  return [...groups].map(([provider, models]) => ({ provider, models }));
}

/** The models of the online providers (the top list) and of the local providers (the "Local models" submenu). */
export function splitModels(items: string[], local: ReadonlySet<string>): { online: string[]; local: string[] } {
  const isLocal = (spec: string) => local.has(spec.slice(0, Math.max(0, spec.indexOf("/"))));
  return { online: items.filter((m) => !isLocal(m)), local: items.filter(isLocal) };
}

type Sub = "effort" | "local" | null;

/**
 * The model chip and its menu. The user selects a model, and cannot type one. ``allowDefault`` adds
 * "Default model": the default_model setting of the daemon. ``effort`` adds the "Effort" submenu.
 */
export function ModelMenu({
  value,
  models,
  allowDefault,
  up,
  alignRight,
  heading = "Model",
  localProviders,
  effort,
  onOpen,
  onSelect,
  onManage,
}: {
  value: string; // "provider/model", or "" for the default model.
  models: ModelList | null; // null: loading.
  allowDefault: boolean;
  up?: boolean; // Open above the chip, for a chip at the bottom of the window.
  alignRight?: boolean; // The right edges of the menu and the chip are in line.
  heading?: string; // "Model · this session" in a session.
  localProviders?: ReadonlySet<string>; // The providers on the computer of the daemon. Their models go in "Local models".
  effort?: { value: Effort | null; onChange: (value: Effort) => void }; // null: the default level, High.
  onOpen: () => void; // Asks the daemon for the models again: a connection can change at any time.
  onSelect: (spec: string) => void;
  onManage: () => void; // Opens the Providers page.
}) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<Sub>(null);
  const [subFocus, setSubFocus] = useState(false); // The keyboard opened the submenu: its first item gets the focus.
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);

  const close = () => {
    setOpen(false);
    setSub(null);
  };

  useEffect(() => {
    if (!open) return;
    onOpen();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const menu = ref.current?.querySelector(".model-menu-main");
    (menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [open, models !== null]);

  useEffect(() => {
    if (!sub || !subFocus) return;
    const panel = ref.current?.querySelector(".model-submenu");
    (panel?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? panel?.querySelector<HTMLButtonElement>("button"))?.focus();
    setSubFocus(false);
  }, [sub, subFocus]);

  const choose = (spec: string) => {
    close();
    if (spec !== value) onSelect(spec);
  };

  const split = splitModels(models?.items ?? [], localProviders ?? new Set());
  // The top list: "Default model", then the models of the online providers. The keys 1 to 9 select them.
  const top = [...(allowDefault ? [""] : []), ...split.online];

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const inSub = !!(e.target as HTMLElement).closest(".model-submenu");
    if (e.key === "Escape" || (inSub && e.key === "ArrowLeft")) {
      e.preventDefault();
      e.stopPropagation();
      if (sub) {
        const row = sub;
        setSub(null);
        ref.current?.querySelector<HTMLButtonElement>(`[data-sub="${row}"]`)?.focus();
      } else close();
      return;
    }
    const subRow = (e.target as HTMLElement).dataset.sub as Sub | undefined;
    if (!inSub && subRow && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setSub(subRow);
      setSubFocus(true);
      return;
    }
    if (!inSub && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const spec = top[Number(e.key) - 1];
      if (spec !== undefined) {
        e.preventDefault();
        choose(spec);
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const scope = inSub ? ".model-submenu" : ".model-menu-main";
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>(`${scope} button`) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  // "Default model" shows the model that the daemon uses for it, when the daemon gives it.
  const fallback = models?.default ? modelName(models.default) : null;
  const shownName = value ? modelName(value) : fallback ?? "Default model";
  const shownEffort = effort ? effortLabel(effort.value) : null;
  const currentEffort = effort?.value ?? DEFAULT_EFFORT;

  // ``inSub``: a model of the "Local models" submenu. The pointer on it keeps the submenu open.
  const radio = (spec: string, label: string, key?: number, inSub = false) => (
    <button key={spec || "default"} type="button" role="menuitemradio" aria-checked={spec === value} onClick={() => choose(spec)} onMouseEnter={inSub ? undefined : () => setSub(null)}>
      <span className="model-menu-name">{label}</span>
      <span className="model-menu-end">
        {spec === value ? <Check size={15} className="model-menu-check" aria-hidden /> : key !== undefined && <kbd className="model-menu-key">{key}</kbd>}
      </span>
    </button>
  );

  const subRow = (name: Exclude<Sub, null>, label: string, detail: string | null) => (
    <button
      type="button"
      role="menuitem"
      data-sub={name}
      aria-haspopup="menu"
      aria-expanded={sub === name}
      onClick={() => setSub(sub === name ? null : name)}
      onMouseEnter={() => setSub(name)}
    >
      <span className="model-menu-name">{label}</span>
      <span className="model-menu-end">
        {detail && <span className="model-menu-detail">{detail}</span>}
        <ChevronRight size={15} aria-hidden />
      </span>
    </button>
  );

  const onlineGroups = groupModels(split.online);
  const keyOf = (spec: string) => {
    const at = top.indexOf(spec);
    return at >= 0 && at < 9 ? at + 1 : undefined;
  };
  const selectedLocal = value && split.local.includes(value) ? modelName(value) : null;

  return (
    <div className="model-menu" ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`prompt-chip model-button${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title={
          value
            ? `The model: ${value}${shownEffort ? `, effort ${shownEffort}` : ""}. Click to select another model.`
            : fallback
              ? `The default model: ${models!.default}. Click to select another model.`
              : "The default model of the daemon. Click to select a model."
        }
      >
        {/* Only the model name: the menu shows the provider of each model. */}
        <span className="prompt-chip-text">{shownName}</span>
        {shownEffort && (
          <>
            {/* A bar separates the model and the effort level (the user asked for this). */}
            <span className="model-button-sep" aria-hidden>
              |
            </span>
            <span className="model-button-effort">{shownEffort}</span>
          </>
        )}
      </button>
      {open && (
        <div className={`menu model-dropdown${up ? " up" : ""}${alignRight ? " right" : ""}`} role="menu" aria-label="Models">
          <div className="model-menu-main">
            <div className="model-menu-heading">{heading}</div>
            <div className="model-menu-list">
              {models === null ? (
                <p className="menu-note">
                  <LoaderCircle size={14} className="spin" aria-hidden /> Asking the providers for their models.
                </p>
              ) : (
                <>
                  {allowDefault && radio("", fallback ? `Default model (${fallback})` : "Default model", keyOf(""))}
                  {models.items.length === 0 && <p className="menu-note">No provider gives a model.</p>}
                  {value && !models.items.includes(value) && (
                    <p className="menu-note">
                      <TriangleAlert size={13} aria-hidden /> No provider gives {value} now.
                    </p>
                  )}
                  {onlineGroups.map((g) => (
                    <div key={g.provider} role="group" aria-label={g.provider}>
                      {/* A provider name shows only when two or more online providers give models. */}
                      {onlineGroups.length > 1 && <div className="menu-heading">{g.provider}</div>}
                      {g.models.map((spec) => radio(spec, spec.slice(g.provider.length + 1), keyOf(spec)))}
                    </div>
                  ))}
                  {models.errors.map((e) => (
                    <p key={e.provider} className="menu-note model-menu-error" title={e.message}>
                      <TriangleAlert size={13} aria-hidden /> {e.provider}: {e.message}
                    </p>
                  ))}
                </>
              )}
            </div>
            <div className="menu-sep" role="separator" />
            {effort && subRow("effort", "Effort", effortLabel(effort.value))}
            {localProviders && subRow("local", "Local models", selectedLocal)}
            <div className="menu-sep" role="separator" />
            <button type="button" role="menuitem" onClick={() => { close(); onManage(); }} onMouseEnter={() => setSub(null)}>
              <span className="model-menu-name">Show providers</span>
            </button>
          </div>
          {sub === "effort" && effort && (
            <div className="menu model-submenu" role="menu" aria-label="Effort">
              {EFFORT_LEVELS.map((l) => (
                <button
                  key={l.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={currentEffort === l.value}
                  onClick={() => {
                    close();
                    if (currentEffort !== l.value) effort.onChange(l.value);
                  }}
                >
                  <span className="model-menu-name">{l.label}</span>
                  <span className="model-menu-end">{currentEffort === l.value && <Check size={15} className="model-menu-check" aria-hidden />}</span>
                </button>
              ))}
              <p className="model-submenu-help">{EFFORT_HELP}</p>
            </div>
          )}
          {sub === "local" && (
            <div className="menu model-submenu" role="menu" aria-label="Local models">
              {split.local.length === 0 ? (
                <p className="menu-note">No local model is on. Add Ollama or llama.cpp on the Local models page.</p>
              ) : (
                groupModels(split.local).map((g) => (
                  <div key={g.provider} role="group" aria-label={g.provider}>
                    <div className="menu-heading">{g.provider}</div>
                    {g.models.map((spec) => radio(spec, spec.slice(g.provider.length + 1), undefined, true))}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
