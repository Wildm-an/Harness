// A session row of the sidebar, and its menu: a ⋮ button that shows when the pointer is on the row.
// The menu has the keys of Claude: P (pin), U (mark as unread), R (rename), and D (delete).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EllipsisVertical, Pencil, Pin, PinOff, Trash2, Mail, MailOpen } from "lucide-react";
import type { RunningSession, SessionSummary } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";

export interface SessionActions {
  onResume: (id: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onMarkUnread: (id: string, unread: boolean) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
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

const MENU_WIDTH = 210;

type MenuAction = "pin" | "unread" | "rename" | "delete";
const KEYS: Record<string, MenuAction> = { p: "pin", u: "unread", r: "rename", d: "delete" };

function SessionMenu({ session, unread, anchor, onAction, onClose }: {
  session: SessionSummary;
  unread: boolean;
  anchor: HTMLElement;
  onAction: (action: MenuAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState(false); // Delete asks one more time: it cannot be undone.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useOverlay(true);

  // The sidebar list scrolls: the menu has a fixed position under the ⋮ button, in the window.
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 180;
    const top = r.bottom + 4 + height > window.innerHeight ? Math.max(8, r.top - 4 - height) : r.bottom + 4;
    setPos({ top, left: Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)) });
  }, [anchor, confirm]);

  const close = useRef(onClose);
  close.current = onClose;

  // The focus goes into the menu when it is visible: a hidden button cannot take the focus.
  const placed = pos !== null;
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [confirm, placed]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      close.current();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [anchor]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (confirm) setConfirm(false);
      else onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
      return;
    }
    const action = !confirm && !e.ctrlKey && !e.metaKey && !e.altKey ? KEYS[e.key.toLowerCase()] : undefined;
    if (action) {
      e.preventDefault();
      if (action === "delete") setConfirm(true);
      else onAction(action);
    }
  };

  const item = (action: MenuAction, label: string, key: string, Icon: typeof Pin, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={danger ? "danger" : undefined}
      aria-keyshortcuts={key}
      onClick={() => (action === "delete" ? setConfirm(true) : onAction(action))}
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
      {confirm ? (
        <div className="session-menu-confirm">
          <p>Delete this session? Its messages are deleted. This cannot be undone.</p>
          <div className="session-menu-confirm-actions">
            <button type="button" className="btn btn-small" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-small btn-danger" onClick={() => onAction("delete")}>
              Delete
            </button>
          </div>
        </div>
      ) : (
        <>
          {item("pin", session.pinned ? "Unpin" : "Pin", "P", session.pinned ? PinOff : Pin)}
          {item("unread", unread ? "Mark as read" : "Mark as unread", "U", unread ? MailOpen : Mail)}
          <div className="menu-sep" role="separator" />
          {item("rename", "Rename", "R", Pencil)}
          <div className="menu-sep" role="separator" />
          {item("delete", "Delete", "D", Trash2, true)}
        </>
      )}
    </div>
  );
}

export function SessionRow({ session, active, state, unread, disabled, actions }: {
  session: SessionSummary;
  active: boolean;
  state: SessionState;
  unread: boolean;
  disabled: boolean;
  actions: SessionActions;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const title = session.title ?? "Untitled session";

  const act = (action: MenuAction) => {
    setMenu(false);
    if (action === "pin") actions.onPin(session.id, !session.pinned);
    else if (action === "unread") actions.onMarkUnread(session.id, !unread);
    else if (action === "rename") setRenaming(true);
    else actions.onDelete(session.id);
  };

  const finishRename = (value: string | null) => {
    setRenaming(false);
    const next = value?.trim();
    if (next && next !== title) actions.onRename(session.id, next);
  };

  return (
    <li className={`side-session-row${menu ? " menu-open" : ""}`}>
      {renaming ? (
        <div className={`side-session renaming${active ? " active" : ""}`}>
          <span className={`side-session-status ${state.kind}`} aria-hidden />
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
          className={`side-session${active ? " active" : ""}`}
          onClick={() => !active && actions.onResume(session.id)}
          disabled={disabled}
          aria-current={active ? "true" : undefined}
          title={`${title}\n${session.provider}/${session.model}`}
        >
          <span className={`side-session-status ${state.kind}`} role="img" aria-label={state.label} title={state.label} />
          <span className="side-session-title">{title}</span>
        </button>
      )}
      {!renaming && (
        <button
          ref={moreRef}
          type="button"
          className="side-session-more"
          aria-label={`Actions for ${title}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          title="More actions"
          disabled={disabled}
          onClick={() => setMenu((v) => !v)}
        >
          <EllipsisVertical size={14} aria-hidden />
        </button>
      )}
      {menu && moreRef.current && (
        <SessionMenu session={session} unread={unread} anchor={moreRef.current} onAction={act} onClose={() => setMenu(false)} />
      )}
    </li>
  );
}
