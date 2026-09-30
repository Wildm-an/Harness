import { useState } from "react";
import { Boxes, Cable, ChevronRight, Folder, FolderOpen, PanelLeftClose, Plus, Puzzle, type LucideIcon } from "lucide-react";
import type { ConnectionStatus } from "../daemon/connection";
import type { ProjectItem, RunningSession, SessionSummary } from "../daemon/protocol";
import { loadPref, savePref } from "../lib/prefs";

// A project shows this many sessions. "Show more" shows the rest.
const SHOWN_SESSIONS = 8;
const EXPANDED_PREF = "sidebar.expanded";

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
  const latest = (g: ProjectGroup) => g.sessions[0]?.updated_at ?? -1;
  return [...groups.values()].sort((a, b) => latest(b) - latest(a) || a.name.localeCompare(b.name));
}

/** A short age for a session row: "now", "5m", "3h", "2d", or the date. */
export function shortAge(seconds: number, now: number = Date.now() / 1000): string {
  const diff = Math.max(0, now - seconds);
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function loadExpanded(): Record<string, boolean> {
  try {
    const value = JSON.parse(loadPref(EXPANDED_PREF, "{}"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
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

function NavButton({ icon: Icon, label, active, disabled, onClick }: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`side-item${active ? " active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={16} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

function ProjectSection({ group, open, activeId, running, unread, disabled, onToggle, onResume, onNewSession }: {
  group: ProjectGroup;
  open: boolean;
  activeId: string | null;
  running: Map<string, RunningSession>;
  unread: Set<string>;
  disabled: boolean;
  onToggle: () => void;
  onResume: (id: string) => void;
  onNewSession: () => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? group.sessions : group.sessions.slice(0, SHOWN_SESSIONS);
  const listId = `side-project-${group.key.replace(/[^a-z0-9]/gi, "-")}`;
  const Icon = open ? FolderOpen : Folder;
  return (
    <li className={`side-project${open ? " open" : ""}`}>
      <div className="side-project-head">
        <button
          type="button"
          className="side-project-toggle"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={listId}
          title={group.path}
        >
          <ChevronRight size={14} className="side-chevron" aria-hidden />
          <Icon size={15} aria-hidden />
          <span className="side-project-name">{group.name}</span>
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
          {shown.map((s) => {
            const active = s.id === activeId;
            const state = sessionState(running.get(s.id), unread.has(s.id));
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={`side-session${active ? " active" : ""}`}
                  onClick={() => !active && onResume(s.id)}
                  disabled={disabled}
                  aria-current={active ? "true" : undefined}
                  title={`${s.title ?? "Untitled session"}\n${s.provider}/${s.model}`}
                >
                  <span className={`side-session-status ${state.kind}`} role="img" aria-label={state.label} title={state.label} />
                  <span className="side-session-title">{s.title ?? "Untitled session"}</span>
                  <span className="side-session-age">{shortAge(s.updated_at)}</span>
                </button>
              </li>
            );
          })}
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
  onNewSession,
  onNewSessionIn,
  onResume,
  onLocalModels,
  onPlugins,
  onConnections,
  onCollapse,
}: {
  sessions: SessionSummary[];
  projects: ProjectItem[];
  running: RunningSession[]; // The sessions with a running turn.
  unread: Set<string>; // The sessions with a turn that ended while the user was in another session.
  activeId: string | null;
  screen: string;
  status: ConnectionStatus;
  connection: React.ReactNode; // The computer button at the bottom.
  onNewSession: () => void;
  onNewSessionIn: (group: ProjectGroup) => void;
  onResume: (id: string) => void;
  onLocalModels: () => void;
  onPlugins: () => void;
  onConnections: () => void;
  onCollapse: () => void;
}) {
  const [expanded, setExpanded] = useState(loadExpanded);
  const open = status === "open";
  const groups = groupByProject(sessions, projects);
  const runningById = new Map(running.map((r) => [r.session_id, r]));
  const activeKey = groups.find((g) => g.sessions.some((s) => s.id === activeId))?.key;

  // A project that the user did not open or close: open for the active session and the newest project.
  const isOpen = (g: ProjectGroup, index: number) => expanded[g.key] ?? (g.key === activeKey || index === 0);
  const toggle = (g: ProjectGroup, index: number) => {
    const next = { ...expanded, [g.key]: !isOpen(g, index) };
    setExpanded(next);
    savePref(EXPANDED_PREF, JSON.stringify(next));
  };

  return (
    <nav className="sidebar" aria-label="Projects and tools">
      <div className="side-head">
        <button type="button" className="icon-btn ghost" onClick={onCollapse} aria-label="Close the sidebar" title="Close the sidebar">
          <PanelLeftClose size={16} aria-hidden />
        </button>
      </div>

      <div className="side-actions">
        <NavButton icon={Plus} label="New session" active={screen === "start"} disabled={!open} onClick={onNewSession} />
        <NavButton icon={Boxes} label="Local Models" active={screen === "cookbook"} disabled={!open} onClick={onLocalModels} />
        <NavButton icon={Puzzle} label="Plugins" active={screen === "plugins"} disabled={!open} onClick={onPlugins} />
        <NavButton icon={Cable} label="Connections" active={screen === "providers"} disabled={!open} onClick={onConnections} />
      </div>

      <div className="side-sessions">
        <h2 className="side-label">Projects</h2>
        {groups.length === 0 ? (
          <p className="side-empty">{open ? "No projects yet. Start a session to add one." : "Connect to a computer to see its projects."}</p>
        ) : (
          <ul className="side-projects">
            {groups.map((g, i) => (
              <ProjectSection
                key={g.key}
                group={g}
                open={isOpen(g, i)}
                activeId={activeId}
                running={runningById}
                unread={unread}
                disabled={!open}
                onToggle={() => toggle(g, i)}
                onResume={onResume}
                onNewSession={() => onNewSessionIn(g)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="side-foot">{connection}</div>
    </nav>
  );
}
