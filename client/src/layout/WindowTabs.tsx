// The tabs of a pane in its window header: the pages of the browser and the shells of the terminal.

import { Plus, X, type LucideIcon } from "lucide-react";

export interface WindowTab {
  id: string;
  label: string;
  icon?: LucideIcon;
  busy?: boolean; // For example, a page that loads.
}

export function WindowTabs({
  tabs,
  active,
  onSelect,
  onClose,
  onAdd,
  addLabel,
  kind,
}: {
  tabs: WindowTab[];
  active: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  addLabel: string; // For example "New tab (Ctrl+T)".
  kind: string; // For the screen reader: "Browser" or "Terminal".
}) {
  return (
    <>
      <div className="win-tabs" role="tablist" aria-label={`${kind} tabs`}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = tab.id === active;
          return (
            <div key={tab.id} className={`win-tab${selected ? " active" : ""}`} role="presentation">
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="win-tab-main"
                onClick={() => onSelect(tab.id)}
                onAuxClick={(e) => e.button === 1 && onClose(tab.id)} // A middle click closes the tab.
                title={tab.label}
              >
                {Icon && <Icon size={13} aria-hidden className={tab.busy ? "spin" : undefined} />}
                <span className="win-tab-label">{tab.label}</span>
              </button>
              <button type="button" className="win-tab-close" onClick={() => onClose(tab.id)} aria-label={`Close ${tab.label}`} title="Close">
                <X size={12} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="icon-btn ghost win-tab-add" onClick={onAdd} aria-label={addLabel} title={addLabel}>
        <Plus size={15} aria-hidden />
      </button>
    </>
  );
}
