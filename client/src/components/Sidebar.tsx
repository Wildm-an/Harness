import { useState } from "react";
import { ChevronRight, Plus, Puzzle, type LucideIcon } from "lucide-react";
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

function ProjectSection({ group, open, activeId, running, unread, disabled, onToggle, actions, onNewSession }: {
  group: ProjectGroup;
  open: boolean;
  activeId: string | null;
  running: Map<string, RunningSession>;
  unread: Set<string>;
  disabled: boolean;
  onToggle: () => void;
  actions: SessionActions;
  onNewSession: () => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? group.sessions : group.sessions.slice(0, SHOWN_SESSIONS);
  const listId = `side-project-${group.key.replace(/[^a-z0-9]/gi, "-")}`;
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
  onPlugins,
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
  onPlugins: () => void;
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
  const groups = groupByProject(sessions.filter((s) => !s.pinned), projects);
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
      <div className="side-head" data-tauri-drag-region="deep">
        {head}
      </div>

      <div className="side-actions">
        <NavButton icon={Plus} label="New session" active={screen === "start"} disabled={!open} shortcut={newSessionKey} onClick={onNewSession} />
        <NavButton icon={Puzzle} label="Plugins" active={screen === "plugins"} disabled={!open} onClick={onPlugins} />
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
                actions={actions}
                onNewSession={() => onNewSessionIn(g)}
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
