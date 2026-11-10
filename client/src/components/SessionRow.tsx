// A session row of the sidebar, and its menu: a ⋮ button that shows when the pointer is on the row.
// The title of a running session shimmers, as in Claude. A status mark at the right end shows a waiting
// or unread session. An idle or running session has no mark.
// The menu has the keys of Claude: P (pin), U (mark as unread), R (rename), and D (delete).
// "Open in" > "Split view" opens the session at the right of the shown session. A drag of the row to
// the right half of the main view does the same (lib/split.ts).
// A session with nested sessions shows their count and an arrow at the far right. The arrow shows or
// hides the nested sessions under the row.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, CalendarClock, ChevronRight, Columns2, EllipsisVertical, GitBranch, GitPullRequest, Pencil, Pin, PinOff, SquareArrowOutUpRight, Trash2, Mail, MailOpen } from "lucide-react";
import type { PullRequest, RunningSession, SessionSummary } from "../daemon/protocol";
import { PR_STATE_TEXT, prRefText } from "../lib/pr";
import { PrIcon, PrMiniCard, useHoverCard } from "./PrCard";
import { useOverlay } from "../lib/overlay";
import { modelName } from "../lib/modelName";
import { setDraggedSession, startSessionDrag } from "../lib/split";

export interface SessionActions {
  onResume: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onArchive: (id: string, archived: boolean) => void;
  onArchiveAll?: (ids: string[]) => void; // "Archive all" of a project: one "Undo" popup for all of them.
  onMarkUnread: (id: string, unread: boolean) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenSplit?: (id: string) => void; // "Open in" > "Split view", and a drop of the row on the main view.
  onOpenPr?: (url: string) => void; // "Open PR": the pull request of the branch of the session.
}

export interface SessionState {
  kind: "idle" | "running" | "awaiting" | "unread";
  label: string; // The tooltip of the indicator.
}

/**
 * The state of a session row. "awaiting": the turn waits for a permission decision. "unread": the
 * turn ended while the user was in another session. The unread state stays until the user opens the session.
 */
export function sessionState(running: RunningSession | undefined, unread: boolean): SessionState {
  if (running?.waiting) return { kind: "awaiting", label: "Awaiting input: approve or deny a tool call" };
  if (running) return { kind: "running", label: "Running" };
  if (unread) return { kind: "unread", label: "Unread response" };
  return { kind: "idle", label: "Idle" };
}

/** The nested sessions (at all depths) that work, await input, or have an unread response. */
export interface NestedActivity {
  running: number;
  awaiting: number;
  unread: number;
}

/** The nested sessions of a row: their count, the open state, and the activity of the sessions that
 * the closed row hides. */
export interface NestedInfo {
  count: number;
  open: boolean;
  onToggle: () => void;
  hidden: NestedActivity;
  listId: string; // The id of the list of the nested sessions.
}

const nestedNoun = (count: number) => `${count} ${count === 1 ? "nested session" : "nested sessions"}`;

/** The line under a closed row, as in the Claude app: "1 nested session · 1 working". Null when no hidden
 * nested session works, awaits input, or has an unread response. */
export function activityLine(count: number, hidden: NestedActivity): string | null {
  const parts = [
    hidden.running > 0 && `${hidden.running} working`,
    hidden.awaiting > 0 && `${hidden.awaiting} awaiting input`,
    hidden.unread > 0 && `${hidden.unread} unread`,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? [nestedNoun(count), ...parts].join(" · ") : null;
}

/** The text of the arrow button: "Show 2 nested sessions". */
export function nestedLabel(nested: Pick<NestedInfo, "count" | "open">): string {
  return `${nested.open ? "Hide" : "Show"} ${nestedNoun(nested.count)}`;
}

/** The "Open in" > "Split view" item: "off" (disabled) for the session of the main view. null: no item. */
export function splitItem(actions: Pick<SessionActions, "onOpenSplit">, active: boolean): "on" | "off" | null {
  if (!actions.onOpenSplit) return null;
  return active ? "off" : "on";
}

const MENU_WIDTH = 210;
const SUB_WIDTH = 160;

export type MenuAction = "pin" | "unread" | "rename" | "archive" | "delete" | "split" | "pr";
const KEYS: Record<string, MenuAction> = { p: "pin", u: "unread", r: "rename", a: "archive", d: "delete", g: "pr" };

/** The session menu: of a sidebar row, and of the caret button at the right of the title in the top bar. */
export function SessionMenu({ session, unread, prItem, split, anchor, at, align = "right", onAction, onClose }: {
  session: Pick<SessionSummary, "title" | "pinned" | "archived">;
  unread: boolean;
  prItem: boolean; // "Open PR": the branch of the session has a pull request.
  split: "on" | "off" | null; // "Open in" > "Split view": "off" when the main view shows the session. null: no item.
  anchor: HTMLElement;
  at: { x: number; y: number } | null; // A right click: the menu opens at the mouse, not under the ⋮ button.
  align?: "left" | "right"; // The menu edge that lines up with the same edge of the anchor.
  onAction: (action: MenuAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // The "Open in" submenu: its place in the window, at the right of the menu (at the left when there is no room).
  const [sub, setSub] = useState<{ top: number; left: number } | null>(null);
  const openInRef = useRef<HTMLButtonElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  useOverlay(true);

  // The sidebar list scrolls: the menu has a fixed position under the ⋮ button, in the window.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 180;
    if (at) {
      const top = at.y + height > window.innerHeight - 8 ? Math.max(8, at.y - height) : at.y;
      setPos({ top, left: Math.max(8, Math.min(at.x, window.innerWidth - MENU_WIDTH - 8)) });
      return;
    }
    const r = anchor.getBoundingClientRect();
    const top = r.bottom + 4 + height > window.innerHeight ? Math.max(8, r.top - 4 - height) : r.bottom + 4;
    const left = align === "left" ? r.left : r.right - MENU_WIDTH;
    setPos({ top, left: Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH - 8)) });
  }, [anchor, at, align]);

  const close = useRef(onClose);
  close.current = onClose;

  // The focus goes into the menu when it is visible: a hidden button cannot take the focus.
  const placed = pos !== null;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [placed]);

  const showSub = (focus: boolean) => {
    const item = openInRef.current?.getBoundingClientRect();
    const box = ref.current?.getBoundingClientRect();
    if (!item || !box) return;
    const left = box.right + SUB_WIDTH + 4 > window.innerWidth ? box.left - SUB_WIDTH - 4 : box.right + 4;
    setSub({ top: item.top - 4, left: Math.max(8, left) });
    if (focus) window.setTimeout(() => subRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true }), 0);
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      close.current();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [anchor]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const inSub = sub !== null && !!subRef.current?.contains(document.activeElement);
    if (inSub && (e.key === "ArrowLeft" || e.key === "Escape")) {
      e.preventDefault();
      e.stopPropagation();
      setSub(null);
      openInRef.current?.focus({ preventScroll: true });
      return;
    }
    if (e.key === "ArrowRight" && document.activeElement === openInRef.current) {
      e.preventDefault();
      showSub(true);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // The arrow keys move in the submenu while it has the focus, else in the menu.
      const items = inSub
        ? [...(subRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
        : [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > button") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
      return;
    }
    const action = !e.ctrlKey && !e.metaKey && !e.altKey ? KEYS[e.key.toLowerCase()] : undefined;
    if (action && (action !== "pr" || prItem)) {
      e.preventDefault();
      onAction(action);
    }
  };

  const item = (action: MenuAction, label: string, key: string, Icon: typeof Pin, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={danger ? "danger" : undefined}
      aria-keyshortcuts={key}
      onClick={() => onAction(action)}
    >
      <Icon size={14} aria-hidden />
      <span className="session-menu-label">{label}</span>
      <kbd className="session-menu-key">{key}</kbd>
    </button>
  );

  return (
    <div
      ref={ref}
      className="menu session-menu"
      role="menu"
      aria-label={`Actions for ${session.title ?? "the session"}`}
      style={pos ? { top: pos.top, left: pos.left, width: MENU_WIDTH } : { visibility: "hidden", width: MENU_WIDTH }}
      onKeyDown={onKeyDown}
    >
      {prItem && (
        <>
          {item("pr", "Open PR", "G", GitPullRequest)}
          {!split && <div className="menu-sep" role="separator" />}
        </>
      )}
      {split && (
        <>
          <button
            ref={openInRef}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={sub !== null}
            className={sub ? "sub-open" : undefined}
            onClick={() => (sub ? setSub(null) : showSub(true))}
            onMouseEnter={() => showSub(false)}
          >
            <SquareArrowOutUpRight size={14} aria-hidden />
            <span className="session-menu-label">Open in</span>
            <ChevronRight size={14} className="session-menu-sub" aria-hidden />
          </button>
          {sub && (
            <div
              ref={subRef}
              className="menu session-menu session-submenu"
              role="menu"
              aria-label="Open in"
              style={{ top: sub.top, left: sub.left, width: SUB_WIDTH }}
            >
              <button
                type="button"
                role="menuitem"
                disabled={split === "off"}
                title={split === "off" ? "The main view shows this session" : undefined}
                onClick={() => onAction("split")}
              >
                <Columns2 size={14} aria-hidden />
                <span className="session-menu-label">Split view</span>
              </button>
            </div>
          )}
          <div className="menu-sep" role="separator" />
        </>
      )}
      {item("pin", session.pinned ? "Unpin" : "Pin", "P", session.pinned ? PinOff : Pin)}
      {item("unread", unread ? "Mark as read" : "Mark as unread", "U", unread ? MailOpen : Mail)}
      <div className="menu-sep" role="separator" />
      {item("rename", "Rename", "R", Pencil)}
      {item("archive", session.archived ? "Unarchive" : "Archive", "A", session.archived ? ArchiveRestore : Archive)}
      <div className="menu-sep" role="separator" />
      {item("delete", "Delete", "D", Trash2, true)}
    </div>
  );
}

export function SessionRow({ session, active, state, unread, disabled, actions, nested, pr, children }: {
  session: SessionSummary;
  pr?: PullRequest | null; // The pull request of the branch of the session (a worktree session).
  active: boolean;
  state: SessionState;
  unread: boolean;
  disabled: boolean;
  actions: SessionActions;
  nested?: NestedInfo; // The session has nested sessions.
  children?: React.ReactNode; // The list of the nested sessions, when the row is open.
}) {
  // The open menu: under the ⋮ button ("button"), or at the mouse after a right click.
  const [menu, setMenu] = useState<false | "button" | { x: number; y: number }>(false);
  const [renaming, setRenaming] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const title = session.title ?? "Untitled session";
  // The mark shows at the right end of the row, only when the session waits for input or has an unread
  // response. The ⋮ button takes its place on hover. A running session has no mark: its title shimmers
  // (the user asked for both).
  const shown = state.kind === "awaiting" || state.kind === "unread";
  const activity = nested && !nested.open ? activityLine(nested.count, nested.hidden) : null;
  const working = state.kind === "running";

  const act = (action: MenuAction) => {
    setMenu(false);
    if (action === "pin") actions.onPin(session.id, !session.pinned);
    else if (action === "unread") actions.onMarkUnread(session.id, !unread);
    else if (action === "rename") setRenaming(true);
    else if (action === "archive") actions.onArchive(session.id, !session.archived);
    else if (action === "split") actions.onOpenSplit?.(session.id);
    else if (action === "pr") pr?.url && actions.onOpenPr?.(pr.url);
    else actions.onDelete(session.id);
  };

  const finishRename = (value: string | null) => {
    setRenaming(false);
    const next = value?.trim();
    if (next && next !== title) actions.onRename(session.id, next);
  };

  return (
    <li className="side-session-item">
      <div
        className={`side-session-row${menu ? " menu-open" : ""}${nested ? " has-nested" : ""}`}
        onContextMenu={(e) => {
          if (renaming || disabled) return;
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {renaming ? (
          <div className={`side-session renaming${active ? " active" : ""}`}>
            <input
              className="side-session-rename"
              aria-label="The name of the session"
              defaultValue={title}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") finishRename(e.currentTarget.value);
                else if (e.key === "Escape") finishRename(null);
              }}
              onBlur={(e) => finishRename(e.currentTarget.value)}
            />
          </div>
        ) : (
          <button
            type="button"
            className={`side-session${active ? " active" : ""}${shown ? " has-status" : ""}${working ? " side-session-running" : ""}`}
            onClick={() => !active && actions.onResume(session.id)}
            disabled={disabled}
            draggable={!disabled && actions.onOpenSplit !== undefined}
            onDragStart={(e) => startSessionDrag(e, session.id)}
            onDragEnd={() => setDraggedSession(null)}
            aria-current={active ? "true" : undefined}
            title={`${title}\n${modelName(session.model)}${session.branch ? `\nWorktree: ${session.branch}` : ""}${session.routine_id ? "\nStarted by a routine" : ""}`}
          >
            <span className="side-session-title">{title}</span>
            {working && <span className="sr-only">Running</span>}
            {session.branch && <GitBranch size={12} className="side-session-branch" aria-label="Worktree" />}
            {session.routine_id && <CalendarClock size={12} className="side-session-branch" aria-label="Routine" />}
            {pr && <PrMark pr={pr} />}
            {shown && <span className={`side-session-status ${state.kind}`} role="img" aria-label={state.label} title={state.label} />}
          </button>
        )}
        {!renaming && (
          <button
            ref={moreRef}
            type="button"
            className="side-session-more"
            aria-label={`Actions for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menu !== false}
            title="More actions"
            disabled={disabled}
            onClick={() => setMenu((v) => (v ? false : "button"))}
          >
            <EllipsisVertical size={14} aria-hidden />
          </button>
        )}
        {nested && !renaming && (
          <button
            type="button"
            className={`side-nest-toggle${nested.open ? " open" : ""}`}
            onClick={nested.onToggle}
            aria-expanded={nested.open}
            aria-controls={nested.listId}
            aria-label={nestedLabel(nested)}
            title={nestedLabel(nested)}
          >
            <span className="side-nest-count">{nested.count}</span>
            <ChevronRight size={14} className="side-nest-chevron" aria-hidden />
          </button>
        )}
        {menu && moreRef.current && (
          <SessionMenu
            session={session}
            unread={unread}
            prItem={!!pr?.url && !!actions.onOpenPr}
            split={splitItem(actions, active)}
            anchor={moreRef.current}
            at={typeof menu === "object" ? menu : null}
            onAction={act}
            onClose={() => setMenu(false)}
          />
        )}
      </div>
      {nested?.open && children}
      {nested && !nested.open && activity && (
        // A closed row shows the activity of its hidden nested sessions. A click opens the row.
        <button type="button" className="side-nest-activity" onClick={nested.onToggle} aria-controls={nested.listId} title={nestedLabel(nested)}>
          <span className="side-nest-elbow" aria-hidden />
          <span className="side-nest-activity-text">{activity}</span>
        </button>
      )}
    </li>
  );
}

/** The pull request mark of a session row, as in the Claude app: the PR icon in the color of its
 * state, with a small card on hover (the title, "Merged · owner/name #5", the line counts). */
function PrMark({ pr }: { pr: PullRequest }) {
  const hover = useHoverCard(() => <PrMiniCard pr={pr} />);
  return (
    <>
      <span className="side-session-pr" data-hover-card role="img" aria-label={`${PR_STATE_TEXT[pr.state]} pull request ${prRefText(pr)}`} {...hover.anchor}>
        <PrIcon state={pr.state} size={13} />
      </span>
      {hover.card}
    </>
  );
}
