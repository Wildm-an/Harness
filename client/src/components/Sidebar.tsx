import { useEffect, useState } from "react";
import { ChevronRight, Plus, type LucideIcon } from "lucide-react";
import type { ConnectionStatus } from "../daemon/connection";
import type { ProjectItem, RunningSession, SessionSummary } from "../daemon/protocol";
import { loadPref, savePref } from "../lib/prefs";
import { SessionRow, sessionState, type SessionActions } from "./SessionRow";

export { sessionState } from "./SessionRow";

/** A pane button of the "This session" group: Skills, MCP servers, or Permission rules. */
export interface SessionTool {
  key: string;
  icon: LucideIcon;
  label: string;
  active: boolean; // The pane is open.
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
const PROJECT_DRAG = "application/x-harness-project";

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

/**
 * Groups the sessions by project folder. The saved projects are groups also with no session.
 * The group with the newest session is first. Groups with no session are last, by name.
 */
export function groupByProject(sessions: SessionSummary[], projects: ProjectItem[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const p of projects) {
    const key = pathKey(p.path);
    if (!groups.has(key)) groups.set(key, { key, name: p.name, path: p.path, projectId: p.id, sessions: [] });
  }
  for (const s of [...sessions].sort((a, b) => b.updated_at - a.updated_at)) {
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

function loadExpanded(): Record<string, boolean> {
  try {
    const value = JSON.parse(loadPref(EXPANDED_PREF, "{}"));
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

/** A button that shows or hides a pane of the session. */
function ToolButton({ tool, disabled }: { tool: SessionTool; disabled: boolean }) {
  const Icon = tool.icon;
  return (
    <button
      type="button"
      className={`side-item${tool.active ? " active" : ""}`}
      onClick={tool.onClick}
      disabled={disabled}
      aria-pressed={tool.active}
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

/** Where a dragged project goes: before or after the project with this key. */
interface DropSpot {
  key: string;
  after: boolean;
}

function ProjectSection({ group, open, activeId, running, unread, disabled, onToggle, actions, onNewSession, dragging, drop, onDragStart, onDragOver, onDrop, onDragEnd, onMove }: {
  group: ProjectGroup;
  open: boolean;
  activeId: string | null;
  running: Map<string, RunningSession>;
  unread: Set<string>;
  disabled: boolean;
  onToggle: () => void;
  actions: SessionActions;
  onNewSession: () => void;
  dragging: boolean; // The user drags this project.
  drop: "before" | "after" | null; // The line that shows where the dragged project goes.
  onDragStart: () => void;
  onDragOver: (after: boolean) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onMove: (step: -1 | 1) => void; // Alt+Up and Alt+Down move the project with the keyboard.
}) {
  const [all, setAll] = useState(false);
  const shown = all ? group.sessions : group.sessions.slice(0, SHOWN_SESSIONS);
  const listId = `side-project-${group.key.replace(/[^a-z0-9]/gi, "-")}`;
  const isProjectDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(PROJECT_DRAG);
  return (
    <li
      className={`side-project${open ? " open" : ""}${dragging ? " dragging" : ""}${drop ? ` drop-${drop}` : ""}`}
      onDragOver={(e) => {
        if (!isProjectDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = e.currentTarget.getBoundingClientRect();
        onDragOver(e.clientY > r.top + r.height / 2);
      }}
      onDrop={(e) => {
        if (!isProjectDrag(e)) return;
        e.preventDefault();
        onDrop();
      }}
    >
      <div
        className="side-project-head"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PROJECT_DRAG, group.key);
          e.dataTransfer.effectAllowed = "move";
          onDragStart();
        }}
        onDragEnd={onDragEnd}
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
          <span className="side-project-name">{group.name}</span>
          <ChevronRight size={14} className="side-chevron" aria-hidden />
        </button>
        <button
          type="button"
          className="side-project-new"
          onClick={onNewSession}
          disabled={disabled}
          aria-label={`New session in ${group.name}`}
          title={`New session in ${group.name}`}
        >
          <Plus size={14} aria-hidden />
        </button>
      </div>
      {open && (
        <ul id={listId} className="side-project-sessions">
          {group.sessions.length === 0 && <li className="side-empty">No sessions yet.</li>}
          {shown.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              state={sessionState(running.get(s.id), unread.has(s.id))}
              unread={unread.has(s.id)}
              disabled={disabled}
              actions={actions}
            />
          ))}
          {group.sessions.length > SHOWN_SESSIONS && (
            <li>
              <button type="button" className="side-more" onClick={() => setAll((v) => !v)}>
                {all ? "Show less" : `Show ${group.sessions.length - SHOWN_SESSIONS} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
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
  actions,
  newSessionKey,
  head,
  tools = [],
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
  actions: SessionActions; // Open, pin, mark as unread, rename, and delete a session.
  newSessionKey?: string; // "Ctrl+N".
  head: React.ReactNode; // The sidebar, back, and forward buttons at the top left.
  tools?: SessionTool[]; // The pane buttons of the open session. Empty on the other screens.
}) {
  const [expanded, setExpanded] = useState(loadExpanded);
  const [moreOpen, setMoreOpen] = useState(() => loadPref(MORE_PREF, "0") === "1");
  const toggleMore = () => {
    setMoreOpen(!moreOpen);
    savePref(MORE_PREF, moreOpen ? "0" : "1");
  };
  const open = status === "open";
  // Pinned sessions are in their own list at the top, as in Claude.
  const pinned = sessions.filter((s) => s.pinned);
  const [order, setOrder] = useState(loadOrder);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropSpot, setDropSpot] = useState<DropSpot | null>(null);
  const byRecency = groupByProject(sessions.filter((s) => !s.pinned), projects);
  const groups = orderGroups(byRecency, order);
  const runningById = new Map(running.map((r) => [r.session_id, r]));
  const activeKey = groups.find((g) => g.sessions.some((s) => s.id === activeId))?.key;
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
  const endDrag = () => {
    setDragKey(null);
    setDropSpot(null);
  };
  const dropOn = (target: string) => {
    if (dragKey && dropSpot?.key === target) saveOrder(moveKey(mergeOrder(shownKeys, order), dragKey, target, dropSpot.after));
    endDrag();
  };
  const moveBy = (key: string, step: -1 | 1) => {
    const at = shownKeys.indexOf(key);
    const target = shownKeys[at + step];
    if (target) saveOrder(moveKey(mergeOrder(shownKeys, order), key, target, step === 1));
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
            <ul className="side-pinned">
              {pinned.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeId}
                  state={sessionState(runningById.get(s.id), unread.has(s.id))}
                  unread={unread.has(s.id)}
                  disabled={!open}
                  actions={actions}
                />
              ))}
            </ul>
          </>
        )}
        <h2 className="side-label">Projects</h2>
        {groups.length === 0 ? (
          <p className="side-empty">{open ? "No projects yet. Start a session to add one." : "Connect to a computer to see its projects."}</p>
        ) : (
          <ul className="side-projects">
            {groups.map((g) => (
              <ProjectSection
                key={g.key}
                group={g}
                open={isOpen(g)}
                activeId={activeId}
                running={runningById}
                unread={unread}
                disabled={!open}
                onToggle={() => toggle(g)}
                actions={actions}
                onNewSession={() => onNewSessionIn(g)}
                dragging={g.key === dragKey}
                drop={dragKey && dragKey !== g.key && dropSpot?.key === g.key ? (dropSpot.after ? "after" : "before") : null}
                onDragStart={() => setDragKey(g.key)}
                onDragOver={(after) => {
                  if (dropSpot?.key !== g.key || dropSpot.after !== after) setDropSpot({ key: g.key, after });
                }}
                onDrop={() => dropOn(g.key)}
                onDragEnd={endDrag}
                onMove={(step) => moveBy(g.key, step)}
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
