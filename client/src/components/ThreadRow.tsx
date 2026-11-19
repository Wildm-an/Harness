// A row of the Threads layout of the sidebar, as the thread row of T3 Code (SidebarThreadRow.tsx of T3 Code, MIT).
// The user asked for the same UI as T3 Code (docs/UI_RULES.md 3.7).
//
// A card row (Pinned, Active, Working) has three lines:
//   1. The project icon, the pin, the project name, and at the right the status ("Working 1m", "Approval",
//      "Done") or the age of the last activity ("5m"). On hover, the status gives its place to the Snooze
//      button (a clock) and "✓ Settle".
//   2. The title, and the icon of the agent (the harness, or Harness itself) when line 3 is empty.
//   3. The branch, the pull request, and the icon of the agent. Only when the session has a branch or a PR.
// A slim row (Snoozed, Settled, and a nested session) is one line: the project icon (faded), the title, and the
// wake time or the settle age. On hover, "Wake thread now" or "Un-settle thread" takes the place of the time.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlarmClock, AlarmClockOff, CalendarClock, Check, ChevronRight, CircleCheck, CircleX, Clock, Folder, GitBranch, Pin, PinOff, ShieldQuestion, Undo2 } from "lucide-react";
import type { HarnessItem, PullRequest, SessionSummary } from "../daemon/protocol";
import { modelName } from "../lib/modelName";
import { useOverlay } from "../lib/overlay";
import { compactAge, nowSeconds, rowTime, snoozeChoices, whenText, workingDuration, type ThreadStatus } from "../lib/threads";
import { AgentIcon, BUILTIN_AGENT } from "./AgentBits";
import { PrMark, SessionMenu, splitItem, type MenuAction, type NestedInfo, type SessionActions, type ThreadMenuInfo } from "./SessionRow";

const ACP_PROVIDER = "acp"; // The provider of an ACP session in storage: the model is the harness id (daemon acp.py).

/** The agent of a session: a harness of the agent list, or the built-in loop of Harness. */
export function sessionAgent(s: Pick<SessionSummary, "provider" | "model">, agents: HarnessItem[] | null): { id: string; name: string; icon: string | null; detail: string } {
  if (s.provider === ACP_PROVIDER) {
    const item = agents?.find((a) => a.id === s.model);
    return { id: s.model, name: item?.name ?? s.model, icon: item?.icon ?? null, detail: item?.name ?? s.model };
  }
  return { id: BUILTIN_AGENT, name: "Harness", icon: null, detail: `Harness · ${modelName(s.model)}` };
}

/** The icon of "Working": a faint ring with an arc that turns (the user chose it from three choices). */
function ArcSpinner({ size }: { size: number }) {
  return (
    <svg className="thread-spinner" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" opacity={0.25} />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

const STATUS: Record<ThreadStatus, { label: string; Icon: React.ComponentType<{ size: number }> }> = {
  working: { label: "Working", Icon: ArcSpinner },
  approval: { label: "Approval", Icon: ShieldQuestion },
  done: { label: "Done", Icon: CircleCheck },
  failed: { label: "Failed", Icon: CircleX },
};

/** The icon before the project name: a folder, or the Routines icon for a session that a routine started. */
function ProjectIcon({ routine, faded }: { routine: boolean; faded?: boolean }) {
  const className = `thread-project-icon${faded ? " faded" : ""}`;
  return routine ? <CalendarClock size={14} className={className} role="img" aria-label="Routine" /> : <Folder size={14} className={className} aria-hidden />;
}

/** The time of work, in its own render each second, so the row does not render again. */
function WorkingTime({ since }: { since: number }) {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(nowSeconds()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="thread-duration">{workingDuration(now - since)}</span>;
}

/** The Snooze menu of the clock button of a card row: the choices, each with its wake time. */
function SnoozeMenu({ anchor, onSnooze, onClose }: { anchor: HTMLElement; onSnooze: (until: number) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at] = useState(() => new Date());
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useOverlay(true);
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const width = ref.current?.offsetWidth ?? 240;
    const height = ref.current?.offsetHeight ?? 150;
    const top = r.bottom + 4 + height > window.innerHeight ? Math.max(8, r.top - 4 - height) : r.bottom + 4;
    setPos({ top, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) });
  }, [anchor]);
  useEffect(() => {
    if (pos) ref.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [pos]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [anchor, onClose]);
  return (
    <div
      ref={ref}
      className="menu session-menu thread-snooze-menu"
      role="menu"
      aria-label="Snooze thread"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
          const i = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
        }
      }}
    >
      {snoozeChoices(at).map((c) => (
        <button
          key={c.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onSnooze(c.until);
          }}
        >
          <span className="session-menu-label">{c.label}</span>
          <span className="session-menu-detail">{whenText(c.until, at.getTime() / 1000)}</span>
        </button>
      ))}
    </div>
  );
}

export interface ThreadRowDrag {
  ref: (el: HTMLLIElement | null) => void;
  className?: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onClickCapture: (e: React.MouseEvent) => void;
}

export function ThreadRow({
  session,
  variant,
  action,
  active,
  status,
  workingSince,
  unread,
  disabled,
  project,
  agent,
  pr,
  now,
  actions,
  thread,
  canSnooze,
  drag,
  nested,
  motion,
  children,
}: {
  session: SessionSummary;
  variant: "card" | "slim";
  action: "settle" | "unsettle" | "wake"; // The hover button: Settle (Pinned, Active, Working), Un-settle, or Wake.
  active: boolean;
  status: ThreadStatus | null;
  workingSince: number | null; // The start of the work (seconds), for "Working 1m".
  unread: boolean;
  disabled: boolean;
  project: string;
  agent: { id: string; name: string; icon: string | null; detail: string };
  pr: PullRequest | null;
  now: number;
  actions: SessionActions;
  thread: ThreadMenuInfo;
  canSnooze: boolean; // The clock button of a card row.
  drag?: ThreadRowDrag;
  nested?: NestedInfo;
  // The move of a session that finished its work: "leave" slides the row out of Working to the left,
  // then "arrive" slides it into its new place from the left (ThreadsList.tsx).
  motion?: "leave" | "arrive";
  children?: React.ReactNode;
}) {
  const [menu, setMenu] = useState<false | "button" | { x: number; y: number }>(false);
  const [snooze, setSnooze] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const snoozeRef = useRef<HTMLButtonElement>(null);
  const title = session.title ?? "Untitled session";

  const act = (a: MenuAction) => {
    setMenu(false);
    if (a === "pin") actions.onPin(session.id, !session.pinned);
    else if (a === "unread") actions.onMarkUnread(session.id, !unread);
    else if (a === "rename") setRenaming(true);
    else if (a === "archive") actions.onArchive(session.id, !session.archived);
    else if (a === "split") actions.onOpenSplit?.(session.id);
    else if (a === "pr") pr?.url && actions.onOpenPr?.(pr.url);
    else actions.onDelete(session.id);
  };
  const finishRename = (value: string | null) => {
    setRenaming(false);
    const next = value?.trim();
    if (next && next !== title) actions.onRename(session.id, next);
  };
  const open = () => {
    if (!disabled && !renaming && !active) actions.onResume(session.id);
  };
  // A button in the row does its own action: the row does not open the session.
  const own = (run: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    run();
  };

  const tooltip = [title, project, agent.detail, session.branch ? `Branch: ${session.branch}` : null, session.routine_id ? "Started by a routine" : null].filter(Boolean).join("\n");

  const titleEl = renaming ? (
    <input
      className="thread-rename"
      aria-label="The name of the thread"
      defaultValue={title}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finishRename(e.currentTarget.value);
        else if (e.key === "Escape") finishRename(null);
      }}
      onBlur={(e) => finishRename(e.currentTarget.value)}
    />
  ) : (
    <span className={`thread-title${status === "working" ? " side-session-running" : ""}${thread.retitling ? " retitling" : ""}`}>{title}</span>
  );

  const agentIcon = (
    <span className="thread-agent" title={agent.detail}>
      <AgentIcon id={agent.id} name={agent.name} icon={agent.icon} size={14} />
    </span>
  );
  const nestToggle = nested && (
    <button
      type="button"
      className={`thread-nest${nested.open ? " open" : ""}`}
      onClick={own(nested.onToggle)}
      aria-expanded={nested.open}
      aria-controls={nested.listId}
      aria-label={`${nested.open ? "Hide" : "Show"} ${nested.count} nested ${nested.count === 1 ? "session" : "sessions"}`}
      title={`${nested.count} nested ${nested.count === 1 ? "session" : "sessions"}`}
    >
      {nested.count}
      <ChevronRight size={12} aria-hidden />
    </button>
  );

  const pinEl = session.pinned && (
    <button type="button" className="thread-pin" onClick={own(() => actions.onPin(session.id, false))} aria-label="Unpin thread" title="Unpin thread" disabled={disabled}>
      <Pin size={12} className="thread-pin-on" aria-hidden />
      <PinOff size={12} className="thread-pin-off" aria-hidden />
    </button>
  );

  const statusEl = status ? (
    <span className={`thread-status ${status}`}>
      {(() => {
        const { Icon, label } = STATUS[status];
        return (
          <>
            <Icon size={variant === "card" ? 14 : 12} aria-hidden />
            {label}
            {status === "working" && workingSince !== null && <WorkingTime since={workingSince} />}
          </>
        );
      })()}
    </span>
  ) : null;

  const hoverButton =
    action === "settle" ? (
      <button type="button" className="thread-act thread-settle" onClick={own(() => actions.onArchive(session.id, true))} aria-label="Settle thread" title="Settle thread" disabled={disabled}>
        <Check size={variant === "card" ? 14 : 12} aria-hidden />
        {variant === "card" && "Settle"}
      </button>
    ) : action === "unsettle" ? (
      <button type="button" className="thread-act" onClick={own(() => actions.onArchive(session.id, false))} aria-label="Un-settle thread" title="Un-settle thread" disabled={disabled}>
        <Undo2 size={14} aria-hidden />
      </button>
    ) : (
      <button type="button" className="thread-act" onClick={own(thread.onWake)} aria-label="Wake thread now" title="Wake thread now" disabled={disabled}>
        <AlarmClockOff size={12} aria-hidden />
      </button>
    );

  const rowProps = {
    ref: rowRef,
    role: "button",
    tabIndex: disabled ? -1 : 0,
    "aria-current": active ? ("true" as const) : undefined,
    "aria-disabled": disabled || undefined,
    "aria-busy": thread.retitling || undefined,
    title: renaming ? undefined : tooltip,
    onClick: open,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (renaming || e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      } else if (e.key === "F2") {
        e.preventDefault();
        setRenaming(true);
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      if (renaming || disabled) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY });
    },
    onPointerDown: (e: React.PointerEvent) => {
      // A button of the row does not start a drag.
      if (!drag || renaming || (e.target as Element).closest("button, input")) return;
      drag.onPointerDown(e);
    },
  };

  const classes = [
    "thread-row",
    variant,
    active && "active",
    unread && "unread",
    menu || snooze ? "menu-open" : null,
    status === "working" && !active && "recede",
    disabled && "disabled",
  ]
    .filter(Boolean)
    .join(" ");

  const metaEmpty = !session.branch && !pr;

  return (
    <li
      ref={drag?.ref}
      className={`thread-item${drag?.className ? ` ${drag.className}` : ""}${motion ? ` thread-${motion}` : ""}`}
      onClickCapture={drag?.onClickCapture}
      inert={motion === "leave" || undefined}
    >
      {variant === "card" ? (
        <div className={classes} {...rowProps}>
          <div className="thread-top">
            <ProjectIcon routine={!!session.routine_id} />
            {pinEl}
            <span className="thread-project">{project}</span>
            <span className="thread-slot">
              <span className="thread-time">{statusEl ?? compactAge(rowTime(session), now)}</span>
              <span className="thread-acts">
                {canSnooze && (
                  <button
                    ref={snoozeRef}
                    type="button"
                    className="thread-act"
                    onClick={own(() => setSnooze((v) => !v))}
                    aria-label="Snooze thread"
                    aria-haspopup="menu"
                    aria-expanded={snooze}
                    title="Snooze thread"
                    disabled={disabled}
                  >
                    <Clock size={12} aria-hidden />
                  </button>
                )}
                {hoverButton}
              </span>
            </span>
          </div>
          <div className="thread-title-line">
            {titleEl}
            {nestToggle}
            {metaEmpty && agentIcon}
          </div>
          {!metaEmpty && (
            <div className="thread-meta">
              {session.branch ? (
                <>
                  <GitBranch size={12} aria-hidden />
                  <span className="thread-branch">{session.branch}</span>
                </>
              ) : (
                <span className="thread-spacer" />
              )}
              {pr && <PrMark pr={pr} />}
              {agentIcon}
            </div>
          )}
        </div>
      ) : (
        <div className={classes} {...rowProps}>
          <ProjectIcon routine={!!session.routine_id} faded />
          {titleEl}
          {nestToggle}
          <span className="thread-slot">
            <span className="thread-time">
              {action === "wake" && typeof session.snoozed_until === "number" ? (
                <span className="thread-wake">
                  <AlarmClock size={12} aria-hidden />
                  {whenText(session.snoozed_until, now)}
                </span>
              ) : (
                statusEl ?? compactAge(rowTime(session), now)
              )}
            </span>
            <span className="thread-acts">{hoverButton}</span>
          </span>
        </div>
      )}
      {snooze && snoozeRef.current && <SnoozeMenu anchor={snoozeRef.current} onSnooze={thread.onSnooze} onClose={() => setSnooze(false)} />}
      {menu && rowRef.current && (
        <SessionMenu
          session={session}
          unread={unread}
          prItem={!!pr?.url && !!actions.onOpenPr}
          split={splitItem(actions, active)}
          anchor={rowRef.current}
          at={typeof menu === "object" ? menu : null}
          thread={thread}
          onAction={act}
          onClose={() => setMenu(false)}
        />
      )}
      {nested?.open && children}
    </li>
  );
}
