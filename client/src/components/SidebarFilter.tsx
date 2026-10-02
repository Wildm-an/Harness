// The view settings of the sidebar list, as in Claude: Status, Group by, Sort by, Show empty
// groups, and Show PR status. The filter button at the top of the project list opens the menu.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight, SlidersHorizontal } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";

export type StatusFilter = "active" | "archived" | "all";
export type GroupBy = "folder" | "none";
export type SortBy = "activity" | "created";

export interface SidebarView {
  status: StatusFilter;
  groupBy: GroupBy;
  sortBy: SortBy;
  showEmpty: boolean; // Show the projects that have no session for the filter.
  showPr: boolean; // Show the pull request of the branch of each project. Off by default: it runs gh each minute.
}

const VIEW_PREF = "sidebar.view";

export const DEFAULT_VIEW: SidebarView = { status: "active", groupBy: "folder", sortBy: "activity", showEmpty: true, showPr: false };

export function loadView(): SidebarView {
  try {
    const saved = JSON.parse(loadPref(VIEW_PREF, "{}")) as Partial<SidebarView>;
    return {
      status: saved.status === "archived" || saved.status === "all" ? saved.status : "active",
      groupBy: saved.groupBy === "none" ? "none" : "folder",
      sortBy: saved.sortBy === "created" ? "created" : "activity",
      showEmpty: saved.showEmpty !== false,
      showPr: saved.showPr === true,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(view: SidebarView): void {
  savePref(VIEW_PREF, JSON.stringify(view));
}

const STATUS_LABELS: Record<StatusFilter, string> = { active: "Active", archived: "Archived", all: "All" };
const GROUP_LABELS: Record<GroupBy, string> = { folder: "Folder", none: "None" };
const SORT_LABELS: Record<SortBy, string> = { activity: "Last activity", created: "Created" };

type Sub = "status" | "groupBy" | "sortBy";

const SUBS: { key: Sub; label: string; labels: Record<string, string> }[] = [
  { key: "status", label: "Status", labels: STATUS_LABELS },
  { key: "groupBy", label: "Group by", labels: GROUP_LABELS },
  { key: "sortBy", label: "Sort by", labels: SORT_LABELS },
];

export function SidebarFilter({ view, onChange }: { view: SidebarView; onChange: (view: SidebarView) => void }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<Sub | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useOverlay(open);

  // The menu is fixed on the page: the project list scrolls and would cut it.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
  }, [open]);

  // A submenu that opens with the keyboard gets the focus at once.
  const focusSub = useRef(false);
  useLayoutEffect(() => {
    if (!sub || !focusSub.current) return;
    focusSub.current = false;
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>(".side-filter-submenu [role=menuitemradio]") ?? [])];
    (items.find((b) => b.getAttribute("aria-checked") === "true") ?? items[0])?.focus({ preventScroll: true });
  }, [sub]);

  // Focus the first item when the menu has its place: a hidden element cannot have the focus.
  useEffect(() => {
    if (open && pos) menu.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus({ preventScroll: true });
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) close();
    };
    // Escape closes the menu also when the focus is not in it, for example after a hover.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || menu.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setSub(null);
    setPos(null);
  };
  const set = (patch: Partial<SidebarView>) => onChange({ ...view, ...patch });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (sub) setSub(null);
      else {
        close();
        button.current?.focus();
      }
      return;
    }
    if (e.key === "ArrowLeft" && sub) {
      e.preventDefault();
      const key = sub;
      setSub(null);
      menu.current?.querySelector<HTMLButtonElement>(`[data-sub="${key}"]`)?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const scope = (document.activeElement as HTMLElement | null)?.closest(".menu") ?? menu.current;
    const items = [...(scope?.querySelectorAll<HTMLButtonElement>(':scope > [role^="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-btn ghost side-label-btn${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Filter and sort the sessions"
        title="Filter and sort"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <SlidersHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div
          ref={menu}
          className="menu side-filter-menu"
          role="menu"
          aria-label="Filter and sort"
          style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
          onKeyDown={onKeyDown}
        >
          {SUBS.map(({ key, label, labels }) => (
            <div key={key} className="side-filter-sub" onMouseEnter={() => setSub(key)}>
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={sub === key}
                data-sub={key}
                onClick={() => setSub(sub === key ? null : key)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  focusSub.current = true;
                  setSub(key);
                }}
              >
                <span className="side-filter-label">{label}</span>
                <span className="side-filter-value">{labels[view[key]]}</span>
                <ChevronRight size={14} aria-hidden />
              </button>
              {sub === key && (
                <div className="menu side-filter-submenu" role="menu" aria-label={label}>
                  {Object.entries(labels).map(([value, text]) => (
                    <button
                      key={value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={view[key] === value}
                      onClick={() => {
                        set({ [key]: value } as Partial<SidebarView>);
                        setSub(null);
                      }}
                    >
                      <span className="side-filter-label">{text}</span>
                      {view[key] === value && <Check size={14} aria-hidden />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitemcheckbox" aria-checked={view.showEmpty} onMouseEnter={() => setSub(null)} onClick={() => set({ showEmpty: !view.showEmpty })}>
            <span className="side-filter-label">Show empty groups</span>
            {view.showEmpty && <Check size={14} aria-hidden />}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={view.showPr} onMouseEnter={() => setSub(null)} onClick={() => set({ showPr: !view.showPr })}>
            <span className="side-filter-label">Show PR status</span>
            {view.showPr && <Check size={14} aria-hidden />}
          </button>
        </div>
      )}
    </>
  );
}
