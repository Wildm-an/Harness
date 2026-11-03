// The Layout menu of the IDE view, in the title bar to the left of the Servers menu: a quick way to
// change the default tiling of the IDE view. It changes the same options as Settings > Appearance >
// IDE view (lib/ideLayout.ts): a change applies at once, to all projects.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LayoutPanelLeft, RotateCcw, Settings } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { IDE_PRESETS, ideOptions, setIdeOptions } from "../lib/ideLayout";
import type { IdeLayoutOptions } from "../layout/model";
import { IdeSketch } from "./IdeSketch";

export function IdeLayoutMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<IdeLayoutOptions>(ideOptions);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    setOptions(ideOptions()); // Settings can have changed the options.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const change = (patch: Partial<IdeLayoutOptions>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    setIdeOptions(next);
  };

  return (
    <div
      className="ide-layout-menu"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className={`btn btn-ghost${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Layout of the IDE view"
      >
        <LayoutPanelLeft size={14} aria-hidden />
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && (
        <div className="menu ide-layout-dropdown" role="menu" aria-label="IDE layout" data-tauri-drag-region="false">
          <div className="menu-heading">Layout</div>
          {IDE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={options.preset === p.id}
              className="ide-layout-item"
              onClick={() => change({ preset: p.id })}
            >
              <IdeSketch preset={p.id} chatSide={options.chatSide} small />
              <span className="ide-layout-text">
                <span>{p.label}</span>
                <span className="ide-layout-help">{p.help}</span>
              </span>
              <span className="menu-check">{options.preset === p.id && <Check size={14} aria-hidden />}</span>
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <div className="menu-heading">Chat side</div>
          {(["right", "left"] as const).map((side) => (
            <button
              key={side}
              type="button"
              role="menuitemradio"
              aria-checked={options.chatSide === side}
              onClick={() => change({ chatSide: side })}
            >
              <span className="menu-check">{options.chatSide === side && <Check size={14} aria-hidden />}</span>
              {side === "right" ? "Right" : "Left"}
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setIdeOptions(options); // The layout of the options again, with its first sizes.
              setOpen(false);
            }}
          >
            <RotateCcw size={14} aria-hidden />
            Reset layout
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <Settings size={14} aria-hidden />
            Layout settings…
          </button>
        </div>
      )}
    </div>
  );
}
