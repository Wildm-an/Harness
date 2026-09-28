import { useEffect, useRef, useState } from "react";
import { Cable, Check, ChevronDown, Cpu, LoaderCircle, TriangleAlert } from "lucide-react";
import { useOverlay } from "../lib/overlay";

export interface ModelList {
  items: string[]; // "provider/model", from the connections that are on.
  errors: { provider: string; message: string }[];
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

/**
 * The model chip: a menu of all models that the connections give. The user selects a model, and
 * cannot type one. ``allowDefault`` adds "Default model": the default_model setting of the daemon.
 */
export function ModelMenu({
  value,
  models,
  allowDefault,
  up,
  alignRight,
  onOpen,
  onSelect,
  onManage,
}: {
  value: string; // "provider/model", or "" for the default model.
  models: ModelList | null; // null: loading.
  allowDefault: boolean;
  up?: boolean; // Open above the chip, for a chip at the bottom of the window.
  alignRight?: boolean; // The right edges of the menu and the chip are in line.
  onOpen: () => void; // Asks the daemon for the models again: a connection can change at any time.
  onSelect: (spec: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    onOpen();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const menu = ref.current;
    (menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
  }, [open, models !== null]);

  const choose = (spec: string) => {
    setOpen(false);
    if (spec !== value) onSelect(spec);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".model-menu-list button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const radio = (spec: string, label: string) => (
    <button key={spec || "default"} type="button" role="menuitemradio" aria-checked={spec === value} onClick={() => choose(spec)}>
      <span className="menu-check">{spec === value && <Check size={14} aria-hidden />}</span>
      <span className="model-menu-name mono">{label}</span>
    </button>
  );

  return (
    <div className="model-menu" ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`prompt-chip${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={value ? `The model: ${value}. Click to select another model.` : "The default model of the daemon. Click to select a model."}
      >
        <Cpu size={13} aria-hidden />
        <span className="prompt-chip-text mono">{value || "Default model"}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className={`menu model-dropdown${up ? " up" : ""}${alignRight ? " right" : ""}`} role="menu" aria-label="Models">
          <div className="model-menu-list">
            {allowDefault && radio("", "Default model")}
            {models === null ? (
              <p className="menu-note">
                <LoaderCircle size={14} className="spin" aria-hidden /> Asking the connections for their models.
              </p>
            ) : (
              <>
                {models.items.length === 0 && <p className="menu-note">No connection gives a model.</p>}
                {value && !models.items.includes(value) && (
                  <p className="menu-note">
                    <TriangleAlert size={13} aria-hidden /> No connection gives {value} now.
                  </p>
                )}
                {groupModels(models.items).map((g) => (
                  <div key={g.provider} role="group" aria-label={g.provider}>
                    <div className="menu-heading">{g.provider}</div>
                    {g.models.map((spec) => radio(spec, spec.slice(g.provider.length + 1)))}
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
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onManage(); }}>
            <Cable size={14} aria-hidden />
            Manage the connections
          </button>
        </div>
      )}
    </div>
  );
}
