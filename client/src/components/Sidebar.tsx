import { useEffect, useState } from "react";
import { ChevronRight, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, GitMerge, Plus, Search, type LucideIcon } from "lucide-react";
import type { ConnectionStatus } from "../daemon/connection";
import type { PrStatus, ProjectItem, RunningSession, SessionSummary } from "../daemon/protocol";
import { loadPref, savePref } from "../lib/prefs";
import { parentHints } from "../lib/projectLabels";
import { reorder, useSortable } from "../lib/useSortable";
import { PointMenu } from "./PointMenu";
import { SessionRow, sessionState, type NestedActivity, type SessionActions, type SessionState } from "./SessionRow";
import { SidebarFilter, loadView, saveView, type SidebarView, type SortBy, type StatusFilter } from "./SidebarFilter";

export { sessionState } from "./SessionRow";

/** A nav item ("Capabilities") or a pane button of the "More" group ("Permission rules"). */
export interface SessionTool {
  key: string;
  icon: LucideIcon;
  label: string;
  active: boolean; // The pane or the page is open.
  detail?: string; // Short text on the right, for example "2/3" for the MCP servers.
  alert?: boolean; // A red dot: for example, an MCP server failed.
  title?: string; // The hover tip.
  onClick: () => void;
}

// A project shows this many sessions. "Show more" shows the rest.
const SHOWN_SESSIONS = 8;
const EXPANDED_PREF = "sidebar.expanded";
const MORE_PREF = "sidebar.more"; // "1": the "More" accordion is open.
const ORDER_PREF = "sidebar.order"; // The project keys, in the order of the user.
const NESTED_PREF = "sidebar.nested"; // The sessions with nested sessions that the user opened or closed.

/** A key to compare folder paths: "/" separators, no trailing "/", and no case on Windows paths. */
export function pathKey(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(p) ? p.toLowerCase() : p;
}

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export interface ProjectGroup {
  key: string; // pathKey of the folder.
  name: string;
  path: string;
  projectId: string | null; // null: a folder of a session that is not a saved project.
  sessions: SessionSummary[]; // Newest first.
}

/** The sessions newest first: by the last activity, or by the creation time. */
export function sortSessions(sessions: SessionSummary[], sortBy: SortBy): SessionSummary[] {
  const time = (s: SessionSummary) => (sortBy === "created" ? s.created_at : s.updated_at);
  return [...sessions].sort((a, b) => time(b) - time(a));
}

/** The sessions that the status filter shows. */
export function filterStatus(sessions: SessionSummary[], status: StatusFilter): SessionSummary[] {
  if (status === "all") return sessions;
  return sessions.filter((s) => !!s.archived === (status === "archived"));
}

/**
 * The nested sessions of each listed session, by parent id, in the order of the list. A session is nested
 * when its parent is in the list and it is not pinned: a pinned session stays in the Pinned list.
 */
export function nestSessions(sessions: SessionSummary[]): Map<string, SessionSummary[]> {
  const ids = new Set(sessions.map((s) => s.id));
  const children = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const parent = s.parent_id;
    if (!parent || parent === s.id || !ids.has(parent) || s.pinned) continue;
    const list = children.get(parent);
    if (list) list.push(s);
    else children.set(parent, [s]);
  }
  return children;
}

/** The sessions that are not nested in another listed session: the rows at the top level. */
export function topSessions(sessions: SessionSummary[], children: Map<string, SessionSummary[]>): SessionSummary[] {
  const nested = new Set([...children.values()].flat().map((s) => s.id));
  return sessions.filter((s) => !nested.has(s.id));
}

/** The session and its parents, up to the top row. A loop in the data stops the walk. */
export function ancestry(id: string | null, sessions: SessionSummary[], children: Map<string, SessionSummary[]>): string[] {
  if (!id || !sessions.some((s) => s.id === id)) return [];
  const parentOf = new Map<string, string>();
  for (const [parent, list] of children) for (const s of list) parentOf.set(s.id, parent);
  const chain = [id];
  for (let at = parentOf.get(id); at && !chain.includes(at); at = parentOf.get(at)) chain.push(at);
  return chain;
}

/** The nested sessions of a row (at all depths) that work, await input, or have an unread response. */
export function hiddenActivity(id: string, children: Map<string, SessionSummary[]>, stateOf: (id: string) => SessionState["kind"]): NestedActivity {
  const activity: NestedActivity = { running: 0, awaiting: 0, unread: 0 };
  const seen = new Set<string>([id]);
  const walk = (parent: string) => {
    for (const s of children.get(parent) ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const kind = stateOf(s.id);
      if (kind !== "idle") activity[kind] += 1;
      walk(s.id);
    }
  };
  walk(id);
  return activity;
}

const PR_ICONS = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed };
const PR_STATES = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

/** The pull request of the branch of a project folder, next to the project name. */
function PrBadge({ status }: { status: PrStatus }) {
  const pr = status.pr;
  if (!pr) return null;
  const Icon = PR_ICONS[pr.state] ?? GitPullRequest;
  const tip = `${PR_STATES[pr.state] ?? pr.state} pull request #${pr.number}${pr.title ? `: ${pr.title}` : ""} (branch ${status.branch})`;
  return (
    <span className={`side-pr side-pr-${pr.state}`} title={tip} aria-label={tip}>
      <Icon size={12} aria-hidden />
      {pr.number}
    </span>
  );
}

/**
 * Groups the sessions by project folder. The saved projects are groups also with no session.
 * The group with the newest session is first. Groups with no session are last, by name.
 */
export function groupByProject(sessions: SessionSummary[], projects: ProjectItem[], sortBy: SortBy = "activity"): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const p of projects) {
    const key = pathKey(p.path);
    if (!groups.has(key)) groups.set(key, { key, name: p.name, path: p.path, projectId: p.id, sessions: [] });
  }
  for (const s of sortSessions(sessions, sortBy)) {
    const key = pathKey(s.cwd);
    let group = groups.get(key);
    if (!group) {
      group = { key, name: folderName(s.cwd), path: s.cwd, projectId: null, sessions: [] };
      groups.set(key, group);
    }
    group.sessions.push(s);
  }
  return [...groups.values()].sort((a, b) => latest(b) - latest(a) || a.name.localeCompare(b.name));
}

const latest = (g: ProjectGroup) => g.sessions[0]?.updated_at ?? -1;

/**
 * Puts the groups in the order of the user (a list of keys). A new session does not move a project.
 * A group that is not in the order is first, newest first: for example, the folder of a new session.
 */
export function orderGroups(groups: ProjectGroup[], order: string[]): ProjectGroup[] {
  const rank = new Map(order.map((key, i) => [key, i]));
  const added = groups.filter((g) => !rank.has(g.key));
  const known = groups.filter((g) => rank.has(g.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  return [...added, ...known];
}

/** The order after a drag: `key` moves before or after `target`. The other keys keep their order. */
export function moveKey(order: string[], key: string, target: string, after: boolean): string[] {
  if (key === target) return order;
  const next = order.filter((k) => k !== key);
  const at = next.indexOf(target);
  if (at < 0) return order;
  next.splice(after ? at + 1 : at, 0, key);
  return next;
}

/** The order to save: the shown keys, then the keys of folders that are not shown now (for example, on another computer). */
export function mergeOrder(shown: string[], order: string[]): string[] {
  const keys = new Set(shown);
  return [...shown, ...order.filter((k) => !keys.has(k))];
}

function loadOrder(): string[] {
  try {
    const value = JSON.parse(loadPref(ORDER_PREF, "[]"));
    return Array.isArray(value) ? value.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function loadExpanded(pref = EXPANDED_PREF): Record<string, boolean> {
  try {
    const value = JSON.parse(loadPref(pref, "{}"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function NavButton({ icon: Icon, label, active, disabled, shortcut, onClick }: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  disabled?: boolean;
  shortcut?: string; // For the hover tip, for example "Ctrl+N".
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`side-item${active ? " active" : ""}`}
      title={shortcut ? `${label} (${shortcut})` : undefined}
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={16} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

/** A button that shows or hides a pane of the session, or ("page") opens a page. */
function ToolButton({ tool, disabled, page }: { tool: SessionTool; disabled: boolean; page?: boolean }) {
  const Icon = tool.icon;
  return (
    <button
      type="button"
      className={`side-item${tool.active ? " active" : ""}`}
      onClick={tool.onClick}
      disabled={disabled}
      aria-pressed={page ? undefined : tool.active}
      aria-current={page && tool.active ? "page" : undefined}
      title={tool.title}
    >
      <Icon size={16} aria-hidden />
      <span>{tool.label}</span>
      {(tool.detail || tool.alert) && (
        <span className="side-item-end">
          {tool.detail && <span className="side-item-detail">{tool.detail}</span>}
          {tool.alert && <span className="side-item-alert" role="img" aria-label="A server failed" />}
        </span>
      )}
    </button>
  );
}

function ProjectSection({ group, hint, pr, open, activeId, running, unread, disabled, onToggle, actions, renderRow, onNewSession, onRemove, sort, onMove, canMove, onSort }: {
  group: ProjectGroup;
  hint: string | null; // The parent folder, if another project has the same name.
  pr: PrStatus | null; // The pull request of the folder branch. null: "Show PR status" is off, or no data.
  open: boolean;
  activeId: string | null; // The open session, or the top row that holds it as a nested session.
  running: Map<string, RunningSession>;
  unread: Set<string>;
  disabled: boolean;
  onToggle: () => void;
  actions: SessionActions;
  renderRow: (s: SessionSummary) => React.ReactNode; // A session row with its nested sessions.
  onNewSession: () => void;
  onRemove: (projectId: string) => void; // Remove the saved project from the list.
  // Drag the project to move it: the project follows the pointer and the others slide (useSortable).
  sort: {
    ref: (el: HTMLElement | null) => void;
    style: React.CSSProperties | undefined;
    dragging: boolean;
    onPointerDown: (e: React.PointerEvent) => void;
    swallowClick: (e: React.MouseEvent) => void;
  };
  onMove: (step: -1 | 1) => void; // Alt+Up and Alt+Down move the project with the keyboard.
  canMove: { up: boolean; down: boolean };
  onSort: () => void; // Sort all projects A to Z.
}) {
  const [all, setAll] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null); // The right-click menu.
  const toArchive = group.sessions.filter((s) => !s.archived);
  const shown = all ? group.sessions : group.sessions.slice(0, SHOWN_SESSIONS);
  // A folded project still shows the open session, and the sessions that work, wait for the user, or have an unread reply.
  const pending = open ? [] : sessionsToShowFolded(group.sessions, running, unread, activeId);
  const listId = `side-project-${group.key.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <li
      ref={sort.ref}
      style={sort.style}
      className={`side-project${open ? " open" : ""}${sort.dragging ? " dragging" : ""}`}
      onClickCapture={sort.swallowClick}
    >
      <div
        className="side-project-head"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => {
          // The "+" button starts a session: it does not move the project.
          if ((e.target as Element).closest(".side-project-new")) return;
          sort.onPointerDown(e);
        }}
      >
        <button
          type="button"
          className="side-project-toggle"
          onClick={onToggle}
          onKeyDown={(e) => {
            if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
            e.preventDefault();
            onMove(e.key === "ArrowUp" ? -1 : 1);
          }}
          aria-expanded={open}
          aria-controls={listId}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          title={group.path}
        >
          <span className="side-project-name">
            {group.name}
            {hint && <span className="side-project-hint"> · {hint}</span>}
          </span>
          {pr && <PrBadge status={pr} />}
          <ChevronRight size={14} className="side-chevron" aria-hidden />
        </button>
        <button
          type="button"
          className="side-project-new"
          onClick={onNewSession}
          disabled={disabled}
          aria-label={`New session in ${group.name}${hint ? ` (${hint})` : ""}`}
          title={`New session in ${group.name}${hint ? ` (${hint})` : ""}`}
        >
          <Plus size={14} aria-hidden />
        </button>
      </div>
      {menuAt && (
        <PointMenu
          x={menuAt.x}
          y={menuAt.y}
          label={`The project ${group.name}`}
          onClose={() => setMenuAt(null)}
          items={[
            { label: "New session", onClick: onNewSession, disabled },
            { label: "Move up", onClick: () => onMove(-1), disabled: !canMove.up, separatorBefore: true },
            { label: "Move down", onClick: () => onMove(1), disabled: !canMove.down },
            { label: "Sort A to Z", onClick: onSort },
            {
              label: `Archive all (${toArchive.length})`,
              onClick: () => toArchive.forEach((s) => actions.onArchive(s.id, true)),
              disabled: disabled || toArchive.length === 0,
              separatorBefore: true,
            },
            // Only a saved project with no session in the list can go. The folder and its files stay.
            {
              label: "Remove from sidebar",
              onClick: () => group.projectId && onRemove(group.projectId),
              disabled: disabled || !group.projectId || group.sessions.length > 0,
            },
          ]}
        />
      )}
      {open && (
        <ul id={listId} className="side-project-sessions">
          {group.sessions.length === 0 && <li className="side-empty">No sessions yet.</li>}
          {shown.map(renderRow)}
          {group.sessions.length > SHOWN_SESSIONS && (
            <li>
              <button type="button" className="side-more" onClick={() => setAll((v) => !v)}>
                {all ? "Show less" : `Show ${group.sessions.length - SHOWN_SESSIONS} more`}
              </button>
            </li>
          )}
        </ul>
      )}
      {pending.length > 0 && (
        <ul id={listId} className="side-project-sessions" aria-label={`Active sessions in ${group.name}`}>
          {pending.map(renderRow)}
        </ul>
      )}
    </li>
  );
}

/** The sessions of a folded project that stay in view: the open session (``activeId``), and the sessions that run, await input, or are unread. */
export function sessionsToShowFolded<T extends { id: string }>(
  sessions: T[],
  running: Map<string, RunningSession>,
  unread: Set<string>,
  activeId: string | null = null,
): T[] {
  return sessions.filter((s) => s.id === activeId || sessionState(running.get(s.id), unread.has(s.id)).kind !== "idle");
}

export function Sidebar({
  sessions,
  projects,
  running,
  unread,
  activeId,
  screen,
  status,
  connection,
  settings,
  onNewSession,
  onNewSessionIn,
  onRemoveProject,
  actions,
  newSessionKey,
  head,
  nav = [],
  tools = [],
  prStatus,
  onRequestPr,
  onSearch,
  searchKey,
}: {
  sessions: SessionSummary[];
  projects: ProjectItem[];
  running: RunningSession[]; // The sessions with a running turn.
  unread: Set<string>; // The sessions with a turn that ended while the user was in another session.
  activeId: string | null;
  screen: string;
  status: ConnectionStatus;
  connection: React.ReactNode; // The computer button at the bottom.
  settings: React.ReactNode; // The Settings button, on the right of the computer button.
  onNewSession: () => void;
  onNewSessionIn: (group: ProjectGroup) => void;
  onRemoveProject: (projectId: string) => void; // Remove a saved project with no sessions from the list.
  actions: SessionActions; // Open, pin, mark as unread, rename, and delete a session.
  newSessionKey?: string; // "Ctrl+N".
  head: React.ReactNode; // The sidebar, back, and forward buttons at the top left.
  nav?: SessionTool[]; // The page items under "New session", always shown: "Capabilities".
  tools?: SessionTool[]; // The pane buttons of the open session. Empty on the other screens.
  prStatus: Map<string, PrStatus>; // By pathKey of the folder.
  onRequestPr: (paths: string[]) => void; // Ask the daemon for the pull requests of these folders.
  onSearch: () => void; // Open the session search.
  searchKey?: string; // "Ctrl+K".
}) {
  const [expanded, setExpanded] = useState(loadExpanded);
  const [moreOpen, setMoreOpen] = useState(() => loadPref(MORE_PREF, "0") === "1");
  const toggleMore = () => {
    setMoreOpen(!moreOpen);
    savePref(MORE_PREF, moreOpen ? "0" : "1");
  };
  const open = status === "open";
  const [view, setView] = useState<SidebarView>(loadView);
  const changeView = (next: SidebarView) => {
    setView(next);
    saveView(next);
  };
  const listed = filterStatus(sessions, view.status);
  // A nested session (a fork, or a session that the agent started) shows under its parent row.
  const children = nestSessions(sortSessions(listed, view.sortBy));
  const top = topSessions(listed, children);
  // Pinned sessions are in their own list at the top, as in Claude.
  const pinned = sortSessions(top.filter((s) => s.pinned), view.sortBy);
  const unpinned = top.filter((s) => !s.pinned);
  const [order, setOrder] = useState(loadOrder);
  const byRecency = groupByProject(unpinned, projects, view.sortBy);
  const allGroups = orderGroups(byRecency, order);
  const groups = view.showEmpty ? allGroups : allGroups.filter((g) => g.sessions.length > 0);
  const hints = parentHints(groups);
  const runningById = new Map(running.map((r) => [r.session_id, r]));
  // The open session and its parents. The top row of the chain opens its project.
  const activeChain = ancestry(activeId, listed, children);
  const activeTop = activeChain[activeChain.length - 1] ?? activeId;
  const activeKey = groups.find((g) => g.sessions.some((s) => s.id === activeTop))?.key;
  const newestKey = byRecency[0]?.key;

  // A folder that is not in the order yet goes into it at its first view. Then a new session does not move it.
  const shownKeys = groups.map((g) => g.key);
  const shownJoined = shownKeys.join("\n");
  useEffect(() => {
    if (shownKeys.every((k) => order.includes(k))) return;
    const next = mergeOrder(shownKeys, order);
    setOrder(next);
    savePref(ORDER_PREF, JSON.stringify(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shownJoined holds the shown keys.
  }, [shownJoined, order]);

  const saveOrder = (next: string[]) => {
    setOrder(next);
    savePref(ORDER_PREF, JSON.stringify(next));
  };
  // Drag a project to move it. The other projects slide out of the way while the user drags.
  const projectSort = useSortable(shownKeys, (key, target) => saveOrder(mergeOrder(reorder(shownKeys, key, target), order)));
  /** Sort A to Z: the projects in the order of their names. The order is saved, as after a drag. */
  const sortByName = () => {
    const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (hints.get(a.key) ?? "").localeCompare(hints.get(b.key) ?? ""));
    saveOrder(mergeOrder(sorted.map((g) => g.key), order));
  };
  const moveBy = (key: string, step: -1 | 1) => {
    const at = shownKeys.indexOf(key);
    const target = shownKeys[at + step];
    if (target) saveOrder(moveKey(mergeOrder(shownKeys, order), key, target, step === 1));
  };

  // "Show PR status": the daemon reads the pull request of each project folder, again each minute.
  const prPaths = view.showPr && open ? allGroups.map((g) => g.path) : [];
  const prJoined = prPaths.join("\n");
  useEffect(() => {
    if (prPaths.length === 0) return;
    onRequestPr(prPaths);
    const timer = window.setInterval(() => onRequestPr(prPaths), 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prJoined holds the paths.
  }, [prJoined]);

  // A row with nested sessions is closed until the user opens it. It opens for an open nested session.
  const [nestedOpen, setNestedOpen] = useState(() => loadExpanded(NESTED_PREF));
  const isNestedOpen = (id: string) => nestedOpen[id] ?? (activeChain.includes(id) && id !== activeId);
  const toggleNested = (id: string) => {
    const next = { ...nestedOpen, [id]: !isNestedOpen(id) };
    setNestedOpen(next);
    savePref(NESTED_PREF, JSON.stringify(next));
  };
  const stateOf = (id: string) => sessionState(runningById.get(id), unread.has(id));
  const renderRow = (s: SessionSummary): React.ReactNode => {
    const nested = children.get(s.id);
    const listId = `side-nested-${s.id}`;
    const opened = !!nested && isNestedOpen(s.id);
    return (
      <SessionRow
        key={s.id}
        session={s}
        active={s.id === activeId}
        state={stateOf(s.id)}
        unread={unread.has(s.id)}
        disabled={!open}
        actions={actions}
        nested={nested && { count: nested.length, open: opened, onToggle: () => toggleNested(s.id), hidden: hiddenActivity(s.id, children, (id) => stateOf(id).kind), listId }}
      >
        {nested && opened && (
          <ul id={listId} className="side-nested" aria-label={`Nested sessions of ${s.title ?? "Untitled session"}`}>
            {nested.map(renderRow)}
          </ul>
        )}
      </SessionRow>
    );
  };

  // A project that the user did not open or close: open for the active session and the newest project.
  const isOpen = (g: ProjectGroup) => expanded[g.key] ?? (g.key === activeKey || g.key === newestKey);
  const toggle = (g: ProjectGroup) => {
    const next = { ...expanded, [g.key]: !isOpen(g) };
    setExpanded(next);
    savePref(EXPANDED_PREF, JSON.stringify(next));
  };

  return (
    <nav className="sidebar" aria-label="Projects and tools">
      <div className="side-head" data-tauri-drag-region="deep">
        {head}
      </div>

      <div className="side-actions">
        <NavButton icon={Plus} label="New session" active={screen === "start"} disabled={!open} shortcut={newSessionKey} onClick={onNewSession} />
        {nav.map((item) => (
          <ToolButton key={item.key} tool={item} disabled={!open} page />
        ))}
        {/* The panes of the open session, in an accordion as the "More" row of Claude. */}
        {tools.length > 0 && (
          <>
            <button
              type="button"
              className={`side-item side-more-toggle${moreOpen ? " open" : ""}`}
              onClick={toggleMore}
              aria-expanded={moreOpen}
              aria-controls="side-more-list"
            >
              <ChevronRight size={16} className="side-more-chevron" aria-hidden />
              <span>More</span>
              {!moreOpen && tools.some((t) => t.alert) && (
                <span className="side-item-end">
                  <span className="side-item-alert" role="img" aria-label="A server failed" />
                </span>
              )}
            </button>
            {moreOpen && (
              <div id="side-more-list" className="side-more-list" role="group" aria-label="More">
                {tools.map((tool) => (
                  <ToolButton key={tool.key} tool={tool} disabled={!open} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="side-sessions">
        {pinned.length > 0 && (
          <>
            <h2 className="side-label">Pinned</h2>
            <ul className="side-pinned">{pinned.map(renderRow)}</ul>
          </>
        )}
        <div className="side-label-row">
          <h2 className="side-label">{view.groupBy === "folder" ? "Projects" : "Sessions"}</h2>
          <button
            type="button"
            className="icon-btn ghost side-label-btn"
            onClick={onSearch}
            aria-label={searchKey ? `Search the sessions (${searchKey})` : "Search the sessions"}
            title={searchKey ? `Search (${searchKey})` : "Search"}
          >
            <Search size={14} aria-hidden />
          </button>
          <SidebarFilter view={view} onChange={changeView} />
        </div>
        {view.groupBy === "none" ? (
          unpinned.length === 0 ? (
            <p className="side-empty">{!open ? "Connect to a computer to see its sessions." : view.status === "archived" ? "No archived sessions." : "No sessions yet."}</p>
          ) : (
            <ul className="side-pinned side-flat">{sortSessions(unpinned, view.sortBy).map(renderRow)}</ul>
          )
        ) : groups.length === 0 ? (
          <p className="side-empty">
            {!open
              ? "Connect to a computer to see its projects."
              : view.status === "archived"
                ? "No archived sessions."
                : "No projects yet. Start a session to add one."}
          </p>
        ) : (
          <ul className="side-projects">
            {groups.map((g) => (
              <ProjectSection
                key={g.key}
                group={g}
                hint={hints.get(g.key) ?? null}
                pr={view.showPr ? (prStatus.get(g.key) ?? null) : null}
                open={isOpen(g)}
                activeId={activeTop}
                running={runningById}
                unread={unread}
                disabled={!open}
                onToggle={() => toggle(g)}
                actions={actions}
                renderRow={renderRow}
                onNewSession={() => onNewSessionIn(g)}
                onRemove={onRemoveProject}
                sort={{
                  ref: projectSort.itemRef(g.key),
                  style: projectSort.styleOf(g.key),
                  dragging: projectSort.dragging === g.key,
                  onPointerDown: (e) => projectSort.onPointerDown(g.key, e),
                  swallowClick: projectSort.swallowClick,
                }}
                onMove={(step) => moveBy(g.key, step)}
                canMove={{ up: shownKeys.indexOf(g.key) > 0, down: shownKeys.indexOf(g.key) < shownKeys.length - 1 }}
                onSort={sortByName}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="side-foot">
        {connection}
        {settings}
      </div>
    </nav>
  );
}
