// The session rail, as in the Claude Code desktop app: a column at the right of a session with the
// details of the session ("Session details"). Each section folds open or closed. In a narrow
// window the rail covers the workspace, and Esc or a click outside closes it.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, ChevronRight, ExternalLink, Folder, GitBranch, GitPullRequest, Globe, KeyRound, Monitor } from "lucide-react";
import type { PrStatus, ServerItem, SessionWorktree, TaskItem } from "../daemon/protocol";
import type { ConnectionKind } from "../lib/connections";
import {
  RAIL_SECTIONS,
  contextShare,
  foldedSections,
  percentText,
  prStateText,
  sortTasks,
  taskSummary,
  toggleFolded,
  type RailSection,
} from "../lib/sessionRail";
import { formatTokens } from "../lib/context";

export const SESSION_RAIL_ID = "session-rail";
const NARROW = "(max-width: 900px)";
const PLACE_ICONS = { local: Monitor, direct: Globe, ssh: KeyRound };
const SERVER_STATES: Record<ServerItem["state"], string> = { stopped: "Stopped", starting: "Starting", running: "Running", crashed: "Crashed" };
const TASK_STATES: Record<TaskItem["status"], string> = { running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" };

export interface RailEnvironment {
  placeKind: ConnectionKind;
  place: string; // The name of the computer: "This computer", or a connection name.
  placeDetail: string | null; // The host name.
  folder: string;
  path: string;
  branch: string | null; // The git branch of the folder. null: not a git repository, or not known yet.
  worktree: SessionWorktree | null;
}

export function SessionRail({
  environment,
  context,
  running,
  onCompact,
  pr,
  onOpenPr,
  servers,
  onOpenServer,
  onShowServers,
  tasks,
  onShowTasks,
  onClose,
}: {
  environment: RailEnvironment;
  context: { tokens: number; length: number } | null;
  running: boolean; // A turn runs: the compaction waits.
  onCompact: () => void;
  pr: PrStatus["pr"];
  onOpenPr: (url: string) => void;
  servers: ServerItem[];
  onOpenServer: (server: ServerItem) => void;
  onShowServers: () => void;
  tasks: TaskItem[];
  onShowTasks: () => void;
  onClose: () => void; // Esc or a click outside, in a narrow window.
}) {
  const [folded, setFolded] = useState<RailSection[]>(foldedSections);
  const ref = useRef<HTMLElement>(null);

  // In a narrow window the rail is an overlay: Esc and a click outside close it.
  useEffect(() => {
    const narrow = () => window.matchMedia?.(NARROW).matches ?? false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && narrow() && ref.current?.contains(document.activeElement)) {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!narrow() || !target || ref.current?.contains(target) || target.closest(".session-rail-toggle")) return;
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [onClose]);

  const PlaceIcon = PLACE_ICONS[environment.placeKind];
  const share = context ? contextShare(context.tokens, context.length) : 0;
  const level = share >= 0.8 ? "high" : share >= 0.6 ? "mid" : "low";
  const sortedTasks = sortTasks(tasks);
  const branch = environment.worktree?.branch ?? environment.branch;

  const body: Record<RailSection, ReactNode | null> = {
    environment: (
      <dl className="rail-rows">
        <RailRow label="Computer" title={environment.placeDetail ?? undefined}>
          <PlaceIcon size={13} aria-hidden />
          <span className="rail-value-text">{environment.place}</span>
        </RailRow>
        <RailRow label="Folder" title={environment.path}>
          <Folder size={13} aria-hidden />
          <span className="rail-value-text">{environment.folder}</span>
        </RailRow>
        {branch && (
          <RailRow label="Branch" title={`Branch: ${branch}`}>
            <GitBranch size={13} aria-hidden />
            <span className="rail-value-text mono">{branch}</span>
          </RailRow>
        )}
        <RailRow
          label="Worktree"
          title={
            environment.worktree
              ? `${environment.worktree.path}${environment.worktree.base ? `. Started from ${environment.worktree.base}.` : ""}`
              : "This session works in the project folder."
          }
        >
          <span className="rail-value-text">{environment.worktree ? "On" : "Off"}</span>
        </RailRow>
      </dl>
    ),
    context: context ? (
      <div className="rail-context">
        <div className="rail-context-head">
          <span>
            {formatTokens(context.tokens)} of {formatTokens(context.length)} tokens
          </span>
          <span className="rail-context-pct">{percentText(share)}</span>
        </div>
        <div
          className={`rail-meter ${level}`}
          role="meter"
          aria-label="Context window"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
        >
          <span style={{ width: `${share * 100}%` }} />
        </div>
        <button type="button" className="btn btn-small rail-action" onClick={onCompact} disabled={running} title={running ? "Compaction waits for the end of the turn." : undefined}>
          <Archive size={13} aria-hidden /> Compact this session
        </button>
      </div>
    ) : (
      <p className="rail-empty">No context data yet. It shows after the first turn.</p>
    ),
    pullRequests: pr ? (
      <button type="button" className="rail-item" onClick={() => pr.url && onOpenPr(pr.url)} disabled={!pr.url} title={pr.url ? "Open the pull request" : undefined}>
        <GitPullRequest size={13} aria-hidden className={`rail-pr-icon ${pr.state}`} />
        <span className="rail-item-text">
          <span className="rail-item-title">
            #{pr.number} {pr.title ?? ""}
          </span>
          <span className="rail-item-detail">{prStateText(pr.state)}</span>
        </span>
        {pr.url && <ExternalLink size={12} aria-hidden className="rail-item-end" />}
      </button>
    ) : null,
    servers:
      servers.length > 0 ? (
        <ul className="rail-list">
          {servers.map((s) => (
            <li key={s.name}>
              <button type="button" className="rail-item" onClick={() => (s.url ? onOpenServer(s) : onShowServers())} title={s.url ?? "Show the servers"}>
                <span className={`rail-dot ${s.state}`} aria-hidden />
                <span className="rail-item-text">
                  <span className="rail-item-title">{s.name}</span>
                  <span className="rail-item-detail">
                    {SERVER_STATES[s.state]}
                    {s.port ? ` · port ${s.port}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null,
    backgroundTasks:
      tasks.length > 0 ? (
        <>
          <p className="rail-empty">{taskSummary(tasks)}</p>
          <ul className="rail-list">
            {sortedTasks.slice(0, 5).map((t) => (
              <li key={t.id}>
                <button type="button" className="rail-item" onClick={onShowTasks} title={t.command}>
                  <span className={`rail-dot ${t.status === "running" ? "running" : t.status === "done" ? "stopped" : "crashed"}`} aria-hidden />
                  <span className="rail-item-text">
                    <span className="rail-item-title">{t.description || t.command}</span>
                    <span className="rail-item-detail">{TASK_STATES[t.status]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null,
  };

  return (
    <aside ref={ref} id={SESSION_RAIL_ID} className="session-rail" role="group" aria-label="Session details" tabIndex={-1}>
      {RAIL_SECTIONS.filter((s) => body[s.id] !== null).map((s) => {
        const open = !folded.includes(s.id);
        const bodyId = `rail-section-${s.id}`;
        return (
          <section key={s.id} className={`rail-section${open ? " open" : ""}`}>
            <h3 className="rail-section-head">
              <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setFolded((f) => toggleFolded(f, s.id))}>
                <ChevronRight size={13} aria-hidden className="rail-chevron" />
                {s.title}
              </button>
            </h3>
            {open && (
              <div id={bodyId} className="rail-section-body">
                {body[s.id]}
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
}

function RailRow({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="rail-row">
      <dt>{label}</dt>
      <dd title={title}>{children}</dd>
    </div>
  );
}
