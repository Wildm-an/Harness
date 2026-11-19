// The Threads layout of the sidebar (docs/UI_RULES.md 3.7): the user asked for the thread list of T3 Code,
// as a choice in Settings > General > "Sidebar organization". One list, not grouped by project: Pinned and
// Active in the manual order, then the folded shelves Working, Snoozed, and Settled (the archive) at the bottom
// of the sidebar, as in T3 Code. The rows are the thread rows of T3 Code (ThreadRow.tsx): a card for Pinned,
// Active, and Working, and a slim row for Snoozed and Settled. The labels "Pinned" and "Active" show only
// during a drag, as in T3 Code.
//
// Drag a row (pointer events) within Pinned or Active to move it, between them to pin or unpin it, onto the
// Settled header to settle it, and from Settled or Snoozed into Pinned or Active to un-settle or wake it.
// A line shows the drop place. The pill of rule S9 follows the pointer and names the action.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { HarnessItem, PrStatus, ProjectItem, RunningSession, SessionSummary } from "../daemon/protocol";
import { reducedMotion } from "../lib/motion";
import { loadPref, savePref } from "../lib/prefs";
import {
  DRAG_SECTIONS,
  DROP_LABELS,
  SECTION_LABELS,
  SETTLE_FIELDS,
  dropAction,
  dropUpdates,
  isSnoozed,
  nextWake,
  nowSeconds,
  threadStatus,
  threadSections,
  topPosition,
  trackStarts,
  undoText,
  type DropAction,
  type ThreadSection,
  type ThreadUpdate,
} from "../lib/threads";
import { sessionState, type SessionActions, type ThreadMenuInfo } from "./SessionRow";
import { ThreadRow, sessionAgent } from "./ThreadRow";
import { SkeletonRows } from "./Skeleton";
import { ancestry, folderName, hiddenActivity, nestSessions, pathKey, topSessions } from "./Sidebar";

/** What the app does for the Threads layout (App.tsx). */
export interface ThreadsActions {
  // Send the changes of session.update, show them at once, and with ``undo`` show the "Undo" popup (5 seconds).
  apply: (updates: ThreadUpdate[], undo?: string) => void;
  retitle: (id: string) => void; // session.retitle.
  retitling: Set<string>; // The sessions with a title that is being made.
  agents: HarnessItem[] | null; // The agent list: the icon of the agent of each row.
  failed: Set<string>; // The sessions whose last turn or routine run ended with an error: "Failed" in place of "Done".
}

const OPEN_PREF = "sidebar.threads.open"; // The shelves that the user opened: {"working": true, ...}.
const SHELVES: ThreadSection[] = ["working", "snoozed", "settled"];
const SHOWN_SETTLED = 20; // The Settled shelf shows this many rows, then "Show more".
const START_DISTANCE = 4; // Pixels: a smaller move is a click.
const LEAVE_MS = 250; // --thread-leave (styles.css): the row of a finished session slides out of Working to the left.
const ARRIVE_MS = 400; // --thread-arrive (styles.css): then it slides into Pinned or Active from the left, the side it left from.

/** A session that finished its work and moves out of Working, with its place in Working before the move. */
interface FinishMove {
  phase: "leave" | "arrive";
  session: SessionSummary;
  index: number;
}

interface Drag {
  id: string;
  title: string;
  from: ThreadSection;
  x: number;
  y: number;
  over: ThreadSection | null;
  index: number; // The drop place in the rows of ``over`` without the dragged row.
}

function loadOpen(): Partial<Record<ThreadSection, boolean>> {
  try {
    const value = JSON.parse(loadPref(OPEN_PREF, "{}"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** The drop place in a list: the number of rows whose middle is above the pointer. */
export function dropIndex(rects: { top: number; height: number }[], y: number): number {
  return rects.filter((r) => r.top + r.height / 2 < y).length;
}

export function ThreadsList({
  sessions,
  projects,
  running,
  runningList,
  unread,
  activeId,
  disabled,
  loading,
  actions,
  threads,
  prStatus,
  onSearch,
  searchKey,
}: {
  sessions: SessionSummary[];
  projects: ProjectItem[];
  running: Map<string, RunningSession>;
  runningList: RunningSession[];
  unread: Set<string>;
  activeId: string | null;
  disabled: boolean; // Not connected.
  loading: boolean;
  actions: SessionActions;
  threads: ThreadsActions;
  prStatus: Map<string, PrStatus>;
  onSearch: () => void;
  searchKey?: string;
}) {
  // A timer renders the list again when a snoozed session wakes, and each minute for the ages ("5m").
  const [, setTick] = useState(0);
  const now = nowSeconds();
  const wake = nextWake(sessions, now);
  useEffect(() => {
    if (wake === null) return;
    const timer = window.setTimeout(() => setTick((t) => t + 1), Math.min(Math.max(0, (wake - nowSeconds()) * 1000) + 500, 2_000_000_000));
    return () => window.clearTimeout(timer);
  }, [wake]);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Working lists the session that started work last first: the app notes when each session starts.
  const starts = useRef(new Map<string, number>());
  starts.current = trackStarts(starts.current, runningList, now);

  const sections = threadSections(sessions, running, now, starts.current);
  const nested = Object.fromEntries(
    (Object.keys(sections) as ThreadSection[]).map((key) => {
      const children = nestSessions(sections[key]);
      return [key, { children, top: topSessions(sections[key], children) }];
    }),
  ) as Record<ThreadSection, { children: Map<string, SessionSummary[]>; top: SessionSummary[] }>;
  const allChildren = new Map(Object.values(nested).flatMap((n) => [...n.children]));
  const activeChain = ancestry(activeId, sessions, allChildren);
  const activeTop = activeChain[activeChain.length - 1] ?? activeId;

  const projectNames = new Map(projects.map((p) => [pathKey(p.path), p.name]));
  const projectOf = (s: SessionSummary) => projectNames.get(pathKey(s.cwd)) ?? folderName(s.cwd);

  const [open, setOpen] = useState(loadOpen);
  const toggleShelf = (key: ThreadSection) => {
    const next = { ...open, [key]: !open[key] };
    setOpen(next);
    savePref(OPEN_PREF, JSON.stringify(next));
  };
  const [allSettled, setAllSettled] = useState(false);

  // Nested rows: closed until the user opens them, open for an open nested session (rule S14).
  const [nestedOpen, setNestedOpen] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(loadPref("sidebar.nested", "{}")) ?? {};
    } catch {
      return {};
    }
  });
  const isNestedOpen = (id: string) => nestedOpen[id] ?? (activeChain.includes(id) && id !== activeId);
  const toggleNested = (id: string) => {
    const next = { ...nestedOpen, [id]: !isNestedOpen(id) };
    setNestedOpen(next);
    savePref("sidebar.nested", JSON.stringify(next));
  };
  const stateOf = (id: string) => sessionState(running.get(id), unread.has(id));

  // -- the move of a finished session ------------------------------------------------------------------
  // A session that stops work leaves Working for Pinned or Active ("Done"). Its row slides out of Working to
  // the left, then slides back into its new place from the left. A row that Working did not show only arrives.
  const [moves, setMoves] = useState<Map<string, FinishMove>>(new Map());
  const lastWorking = useRef<{ ids: string[]; shown: Set<string> } | null>(null);
  const moveTimers = useRef(new Set<number>());
  const workingIds = nested.working.top.map((s) => s.id);
  const workingShown = new Set(open.working ? workingIds : workingIds.filter((id) => id === activeTop));
  useLayoutEffect(() => {
    const last = lastWorking.current;
    lastWorking.current = { ids: workingIds, shown: workingShown };
    if (!last || reducedMotion()) return;
    const found: FinishMove[] = [];
    last.ids.forEach((id, index) => {
      if (workingIds.includes(id) || running.has(id) || moves.has(id)) return;
      const s = sessions.find((x) => x.id === id);
      if (!s || (!nested.pinned.top.includes(s) && !nested.active.top.includes(s))) return;
      found.push({ phase: last.shown.has(id) ? "leave" : "arrive", session: s, index });
    });
    if (found.length === 0) return;
    setMoves((m) => new Map([...m, ...found.map((f) => [f.session.id, f] as const)]));
    const later = (ms: number, run: () => void) => {
      const timer = window.setTimeout(() => {
        moveTimers.current.delete(timer);
        run();
      }, ms);
      moveTimers.current.add(timer);
    };
    for (const f of found) {
      const id = f.session.id;
      const done = () =>
        setMoves((m) => {
          const next = new Map(m);
          next.delete(id);
          return next;
        });
      if (f.phase === "arrive") later(ARRIVE_MS, done);
      else
        later(LEAVE_MS, () => {
          setMoves((m) => (m.has(id) ? new Map(m).set(id, { ...f, phase: "arrive" }) : m));
          later(ARRIVE_MS, done);
        });
    }
  });
  useEffect(() => {
    const timers = moveTimers.current;
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  const motionOf = (id: string) => moves.get(id)?.phase;
  const leaving = [...moves.values()].filter((m) => m.phase === "leave");

  // -- the actions of a row --------------------------------------------------------------------------
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? null;
  const rowActions: SessionActions = {
    ...actions,
    onPin: (id, pinned) =>
      threads.apply([{ id, fields: { pinned } }], pinned ? undefined : undoText("unpin", titleOf(id))),
    onArchive: (id, archived) =>
      archived
        ? threads.apply([{ id, fields: { ...SETTLE_FIELDS } }], undoText("settle", titleOf(id)))
        : threads.apply([{ id, fields: { archived: false, position: topPosition(sessions) } }]),
  };
  const threadInfo = (s: SessionSummary): ThreadMenuInfo => ({
    snoozed: isSnoozed(s, now),
    autoArchive: s.auto_archive !== false,
    retitling: threads.retitling.has(s.id),
    branch: s.branch ?? null,
    path: s.cwd,
    onSnooze: (until) => threads.apply([{ id: s.id, fields: { snoozed_until: until } }], undoText("snooze", s.title, until)),
    onWake: () => threads.apply([{ id: s.id, fields: { snoozed_until: null } }]),
    onAutoArchive: (on) => threads.apply([{ id: s.id, fields: { auto_archive: on } }]),
    onRetitle: () => threads.retitle(s.id),
  });

  // -- drag ------------------------------------------------------------------------------------------
  const [drag, setDrag] = useState<Drag | null>(null);
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const sectionEls = useRef(new Map<ThreadSection, HTMLElement>());
  const moved = useRef(false);
  const latest = useRef({ sessions, nested });
  latest.current = { sessions, nested };

  /** The section under the pointer, and the drop place in its rows. */
  const locate = (y: number, id: string): { over: ThreadSection | null; index: number } => {
    for (const [key, el] of sectionEls.current) {
      const r = el.getBoundingClientRect();
      if (y < r.top || y > r.bottom) continue;
      const rows = latest.current.nested[key].top.filter((s) => s.id !== id);
      const rects = rows.map((s) => rowEls.current.get(s.id)?.getBoundingClientRect()).filter((x): x is DOMRect => !!x);
      return { over: key, index: dropIndex(rects, y) };
    }
    return { over: null, index: 0 };
  };

  const startDrag = (s: SessionSummary, from: ThreadSection, e: React.PointerEvent) => {
    if (e.button !== 0 || disabled || !DRAG_SECTIONS.includes(from)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let current: Drag | null = null;
    moved.current = false;
    const move = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - startX, ev.clientY - startY) < START_DISTANCE) return;
      moved.current = true;
      document.body.classList.add("sorting");
      current = { id: s.id, title: s.title ?? "Untitled session", from, x: ev.clientX, y: ev.clientY, ...locate(ev.clientY, s.id) };
      setDrag(current);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("sorting");
      setDrag(null);
    };
    const up = () => {
      const done = current;
      stop();
      if (done) drop(done);
    };
    const cancel = () => stop();
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      current = null; // Esc cancels the drag.
      stop();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  };

  const drop = (d: Drag) => {
    if (!d.over) return;
    const action = dropAction(d.from, d.over);
    const s = latest.current.sessions.find((x) => x.id === d.id);
    if (!action || !s) return;
    const list = latest.current.nested[d.over].top.filter((x) => x.id !== d.id);
    if (action === "reorder") {
      const before = latest.current.nested[d.over].top.findIndex((x) => x.id === d.id);
      if (before === d.index) return; // The same place.
    }
    const updates = dropUpdates(action, s, list, d.index);
    const undo = action === "unpin" ? undoText("unpin", s.title) : action === "settle" ? undoText("settle", s.title) : undefined;
    threads.apply(updates, undo);
  };

  const swallowClick = (e: React.MouseEvent) => {
    if (!moved.current) return;
    moved.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const dragAction: DropAction | null = drag?.over ? dropAction(drag.from, drag.over) : null;
  const sectionRef = (key: ThreadSection) => (el: HTMLElement | null) => {
    if (el) sectionEls.current.set(key, el);
    else sectionEls.current.delete(key);
  };

  // -- rows ------------------------------------------------------------------------------------------
  const renderRow = (s: SessionSummary, section: ThreadSection, top: boolean): React.ReactNode => {
    const children = nested[section].children.get(s.id);
    const listId = `side-thread-nested-${s.id}`;
    const opened = !!children && isNestedOpen(s.id);
    const draggable = top && DRAG_SECTIONS.includes(section) && !disabled;
    const shelf = section === "snoozed" || section === "settled";
    return (
      <ThreadRow
        key={s.id}
        session={s}
        variant={top && !shelf ? "card" : "slim"}
        action={section === "settled" ? "unsettle" : section === "snoozed" ? "wake" : "settle"}
        active={s.id === activeId}
        status={shelf && top ? null : threadStatus(running.get(s.id), unread.has(s.id), threads.failed.has(s.id))}
        workingSince={starts.current.get(s.id) ?? null}
        unread={unread.has(s.id)}
        disabled={disabled}
        project={projectOf(s)}
        agent={sessionAgent(s, threads.agents)}
        now={now}
        actions={rowActions}
        canSnooze={top && (section === "active" || section === "working")}
        thread={threadInfo(s)}
        pr={s.branch ? (prStatus.get(pathKey(s.cwd))?.pr ?? null) : null}
        drag={
          draggable
            ? {
                ref: (el) => {
                  if (el) rowEls.current.set(s.id, el);
                  else rowEls.current.delete(s.id);
                },
                className: drag?.id === s.id ? "thread-dragging" : undefined,
                onPointerDown: (e) => startDrag(s, section, e),
                onClickCapture: swallowClick,
              }
            : undefined
        }
        motion={top ? (section === "working" ? (motionOf(s.id) === "leave" ? "leave" : undefined) : motionOf(s.id) === "arrive" ? "arrive" : undefined) : undefined}
        nested={
          children && {
            count: children.length,
            open: opened,
            onToggle: () => toggleNested(s.id),
            hidden: hiddenActivity(s.id, nested[section].children, (id) => stateOf(id).kind),
            listId,
          }
        }
      >
        {children && opened && (
          <ul id={listId} className="side-nested thread-nested" aria-label={`Nested sessions of ${s.title ?? "Untitled session"}`}>
            {children.map((c) => renderRow(c, section, false))}
          </ul>
        )}
      </ThreadRow>
    );
  };

  /** The rows of Pinned or Active, with the drop line at the drop place. */
  const renderList = (key: ThreadSection, all: SessionSummary[], className: string) => {
    const rows = all.filter((s) => motionOf(s.id) !== "leave"); // It shows in Working until it arrives.
    const lineAt = drag && drag.over === key && dragAction ? drag.index : -1;
    const others = drag ? rows.filter((s) => s.id !== drag.id) : rows;
    const out: React.ReactNode[] = [];
    let seen = 0;
    for (const s of rows) {
      if (drag && s.id !== drag.id && seen === lineAt) out.push(<li key="drop-line" className="thread-drop-line" aria-hidden />);
      out.push(renderRow(s, key, true));
      if (!drag || s.id !== drag.id) seen++;
    }
    if (lineAt >= others.length && lineAt >= 0) out.push(<li key="drop-line" className="thread-drop-line" aria-hidden />);
    return <ul className={className}>{out}</ul>;
  };

  const overClass = (key: ThreadSection) => (drag && drag.over === key && dragAction ? " drop-target" : "");

  const shelf = (key: ThreadSection) => {
    const rows = nested[key].top;
    const dropOnly = key === "settled" && drag !== null && drag.from !== "settled";
    const ghosts = key === "working" ? leaving : [];
    if (rows.length === 0 && !dropOnly && ghosts.length === 0) return null;
    const isOpen = !!open[key];
    const listId = `side-thread-${key}`;
    // A folded shelf still shows the open session (as rule S11).
    const shown = isOpen ? (key === "settled" && !allSettled ? rows.slice(0, SHOWN_SETTLED) : [...rows]) : rows.filter((s) => s.id === activeTop);
    // A finished session stays at its old place in Working while it slides out.
    for (const g of [...ghosts].sort((a, b) => a.index - b.index)) shown.splice(Math.min(g.index, shown.length), 0, g.session);
    return (
      <section key={key} ref={sectionRef(key)} className={`thread-section thread-shelf${isOpen ? " open" : ""}${overClass(key)}`} aria-label={SECTION_LABELS[key]}>
        <button type="button" className="thread-shelf-toggle" onClick={() => toggleShelf(key)} aria-expanded={isOpen} aria-controls={listId}>
          <span className="thread-shelf-label">{SECTION_LABELS[key]}</span>
          <span className="thread-shelf-rule" aria-hidden />
          <span className="thread-count">{rows.length}</span>
          <ChevronDown size={12} className="thread-shelf-chevron" aria-hidden />
        </button>
        {shown.length > 0 && (
          <ul id={listId} className="thread-list">
            {shown.map((s) => renderRow(s, key, true))}
            {isOpen && key === "settled" && rows.length > SHOWN_SETTLED && (
              <li className="thread-item">
                <button type="button" className="thread-more" onClick={() => setAllSettled((v) => !v)}>
                  <ChevronDown size={14} className={allSettled ? "flip" : undefined} aria-hidden />
                  {allSettled ? "Show less" : `Show ${Math.min(rows.length - SHOWN_SETTLED, SHOWN_SETTLED)} more`}
                </button>
              </li>
            )}
          </ul>
        )}
      </section>
    );
  };

  const pinned = nested.pinned.top;
  const active = nested.active.top;
  const showPinned = pinned.length > 0 || (drag !== null && drag.from !== "pinned");
  const empty = !loading && sessions.length === 0;

  return (
    <div className={`threads${drag ? " threads-dragging" : ""}`}>
      <div className="side-label-row">
        <h2 className="side-label">Threads</h2>
        <button
            type="button"
            className="icon-btn ghost side-label-btn"
            onClick={onSearch}
            aria-label={searchKey ? `Search the sessions (${searchKey})` : "Search the sessions"}
            title={searchKey ? `Search (${searchKey})` : "Search"}
          >
          <Search size={14} aria-hidden />
        </button>
      </div>
      {showPinned && (
        <section ref={sectionRef("pinned")} className={`thread-section${overClass("pinned")}`} aria-label="Pinned">
          {/* As in T3 Code: the label shows only during a drag. A pinned card has a pin. */}
          {drag && <h2 className="side-label thread-drag-label">Pinned</h2>}
          {pinned.length === 0 ? <p className="side-empty thread-drop-tip">Drop here to pin.</p> : renderList("pinned", pinned, "thread-list")}
        </section>
      )}
      <section ref={sectionRef("active")} className={`thread-section${overClass("active")}`} aria-label="Active">
        {drag && <h2 className="side-label thread-drag-label">Active</h2>}
        {loading && sessions.length === 0 ? (
          <SkeletonRows count={5} className="side-skeleton" label="Loading the sessions" />
        ) : active.length === 0 ? (
          <p className="side-empty">{disabled ? "Connect to a computer to see its sessions." : empty ? "No sessions yet." : "No active sessions."}</p>
        ) : (
          renderList("active", active, "thread-list")
        )}
      </section>
      {/* The shelves stay at the bottom of the sidebar, as in T3 Code. */}
      <div className="thread-shelves">{SHELVES.map(shelf)}</div>
      {drag && (
        // The pill of rule S9: the title for a move in the same section, else the action of the drop.
        <div className="drag-pill thread-drag-pill" style={{ top: drag.y + 12, left: drag.x + 12 }} aria-hidden>
          {dragAction && dragAction !== "reorder" ? DROP_LABELS[dragAction] : drag.title}
        </div>
      )}
    </div>
  );
}
