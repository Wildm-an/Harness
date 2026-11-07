// The chip of an ACP session under the prompt box: the name of the harness, and its model menu when the
// harness gives its models (daemon acp.py, "models" or a "model" config option). With no models, the
// chip shows only the name.

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { SessionHarness } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";

/** The text of the chip: "OpenCode · Sonnet", or the harness name when the model is not known. */
export function harnessLabel(harness: SessionHarness): string {
  const model = harness.models?.find((m) => m.id === harness.model);
  return model ? `${harness.name} · ${model.name}` : harness.name;
}

export function HarnessMenu({ harness, disabled, onSelect }: {
  harness: SessionHarness;
  disabled?: boolean; // A turn runs: the harness changes the model only between turns.
  onSelect: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const models = harness.models ?? [];
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], [role="menuitemradio"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const label = harnessLabel(harness);
  if (models.length === 0) {
    return (
      <span className="prompt-chip harness-label" title={`${harness.name} runs this session through ACP. It chooses its own model.`}>
        <span className="prompt-chip-text">{label}</span>
      </span>
    );
  }

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
    <div className="model-menu harness-menu" ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`prompt-chip${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title={`${harness.name} runs this session through ACP. Click to choose its model.`}
      >
        <span className="prompt-chip-text">{label}</span>
      </button>
      {open && (
        <div className="menu model-dropdown up right harness-dropdown" role="menu" aria-label={`Model of ${harness.name}`}>
          <div className="menu-heading">Model · {harness.name}</div>
          {models.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === harness.model}
              className="mode-item"
              onClick={() => {
                setOpen(false);
                if (m.id !== harness.model) onSelect(m.id);
              }}
            >
              <span className="mode-text">
                <span className="mode-label">{m.name}</span>
                {m.description && <span className="mode-help">{m.description}</span>}
              </span>
              <span className="menu-check">{m.id === harness.model && <Check size={14} aria-hidden />}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
