// The tabs of a pane in its window header: the pages of the browser and the shells of the terminal.
// The tabs never scroll sideways (the user asked for this). In a narrow pane they get smaller, then
// show only their icon. When even the icons do not fit, a ⌄ button lists the other tabs.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X, type LucideIcon } from "lucide-react";

export interface WindowTab {
  id: string;
  label: string;
  icon?: LucideIcon;
  busy?: boolean; // For example, a page that loads.
  detail?: string; // A second line in the list of the ⌄ button, for example the URL of a page.
}

export const MIN_TAB = 36; // Pixels: a tab with only its icon.
const TAB_GAP = 2;
const MORE_WIDTH = 30; // The ⌄ button.

/** The tabs that the strip shows in ``width`` pixels, and the others (for the ⌄ list). The active tab always shows. */
export function fitTabs<T extends { id: string }>(tabs: T[], active: string | null, width: number): { shown: T[]; hidden: T[] } {
  const slot = MIN_TAB + TAB_GAP;
  if (tabs.length * slot <= width) return { shown: tabs, hidden: [] };
  const count = Math.max(1, Math.floor((width - MORE_WIDTH) / slot));
  let shown = tabs.slice(0, count);
  const current = tabs.find((t) => t.id === active);
  if (current && !shown.includes(current)) shown = [...shown.slice(0, count - 1), current];
  return { shown, hidden: tabs.filter((t) => !shown.includes(t)) };
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
  const strip = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(Infinity);
  const [listOpen, setListOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  // The room for the tabs: the width of the header, less its other parts.
  useLayoutEffect(() => {
    const el = strip.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const measure = () => {
      let others = 0;
      for (const child of Array.from(parent.children)) {
        if (child !== el && !child.classList.contains("win-tab-more-wrap")) others += (child as HTMLElement).offsetWidth;
      }
      setWidth(Math.max(MIN_TAB, parent.clientWidth - others - 12));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!listOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node)) setListOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [listOpen]);

  const { shown, hidden } = fitTabs(tabs, active, width);
  useEffect(() => {
    if (hidden.length === 0) setListOpen(false);
  }, [hidden.length]);

  return (
    <>
      <div ref={strip} className="win-tabs" role="tablist" aria-label={`${kind} tabs`}>
        {shown.map((tab) => {
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
                <X size={15} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      {hidden.length > 0 && (
        <div className="win-tab-more-wrap" ref={list}>
          <button
            type="button"
            className={`icon-btn ghost win-tab-more${listOpen ? " active" : ""}`}
            onClick={() => setListOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={listOpen}
            aria-label={`${hidden.length} more ${hidden.length === 1 ? "tab" : "tabs"}`}
            title={`${hidden.length} more ${hidden.length === 1 ? "tab" : "tabs"}`}
          >
            <ChevronDown size={15} aria-hidden />
          </button>
          {listOpen && (
            <div
              className="menu win-tab-list"
              role="menu"
              aria-label={`All ${kind.toLowerCase()} tabs`}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setListOpen(false);
                }
              }}
            >
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <div key={tab.id} className={`win-tab-row${tab.id === active ? " active" : ""}`}>
                    <button
                      type="button"
                      role="menuitem"
                      className="win-tab-row-main"
                      onClick={() => {
                        setListOpen(false);
                        onSelect(tab.id);
                      }}
                    >
                      {Icon && <Icon size={15} aria-hidden className={tab.busy ? "spin" : undefined} />}
                      <span className="win-tab-row-text">
                        <span className="win-tab-row-label">{tab.label}</span>
                        {tab.detail && <span className="win-tab-row-detail">{tab.detail}</span>}
                      </span>
                    </button>
                    <button type="button" className="win-tab-row-close" onClick={() => onClose(tab.id)} aria-label={`Close ${tab.label}`} title="Close">
                      <X size={15} aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <button type="button" className="icon-btn ghost win-tab-add" onClick={onAdd} aria-label={addLabel} title={addLabel}>
        <Plus size={15} aria-hidden />
      </button>
    </>
  );
}
