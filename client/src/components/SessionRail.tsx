// The session rail, as in the Claude Code desktop app: a column at the right of a session with the
// details of the session ("Session details"). Each section folds open or closed. In a narrow
// window the rail covers the workspace, and Esc or a click outside closes it.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, Check, ChevronDown, ChevronRight, Coffee, Folder, GitBranch, Globe, GripVertical, KeyRound, Maximize2, Monitor, X } from "lucide-react";
import { useSortable } from "../lib/useSortable";
import type { GitChanges } from "../daemon/protocol";
import { RailChanges, RailPrList } from "./RailChanges";
import { listedPrs, prKeyUrl, usePrInfos, usePrRefresh, type GitAction } from "../lib/pr";
import { captureAgentTab } from "../browser/BrowserPane";
import type { PrStatus, ServerItem, SessionWorktree, TaskItem } from "../daemon/protocol";
import type { ConnectionKind } from "../lib/connections";
import {
  RAIL_SECTIONS,
  contextShare,
  moveSection,
  sectionOrder,
  stepSection,
  foldedSections,
  foldedValue,
  percentText,
  railTasks,
  taskDetailText,
  taskSummary,
  toggleFolded,
  type RailSection,
} from "../lib/sessionRail";
import { formatTokens, type ContextUsage } from "../lib/context";
import { ContextBreakdown } from "./ContextRing";

export const SESSION_RAIL_ID = "session-rail";
const NARROW = "(max-width: 900px)";
const PLACE_ICONS = { local: Monitor, direct: Globe, ssh: KeyRound };
const SERVER_STATES: Record<ServerItem["state"], string> = { stopped: "Stopped", starting: "Starting", running: "Running", crashed: "Crashed" };

export interface RailEnvironment {
  placeKind: ConnectionKind;
  place: string; // The name of the computer: "This computer", or a connection name.
  placeDetail: string | null; // The host name.
  folder: string;
  path: string;
  branch: string | null; // The git branch of the folder. null: not a git repository, or not known yet.
  worktree: SessionWorktree | null;
}

/** The page where the agent works: its tab of the Browser pane, or the headless agent browser. */
export interface RailBrowser {
  tab: string | null; // The agent tab of the Browser pane. null: the headless browser.
  image: string | null; // The last frame of the headless browser.
  url: string;
  title: string;
  live: boolean; // The picture is live: the agent used the page a short time ago, or the user minimized it.
  agent: boolean; // The agent uses the page now: the picture has an outline.
}

/** A tab of the session, for the tab menu of the Browser section. */
export interface RailBrowserTab {
  id: string;
  label: string;
  rail: boolean; // The section shows this tab now.
}

// ms between two pictures of the agent tab. Each picture is a full-size PNG: a small view needs no more.
const LIVE_EVERY = 1000;

export function SessionRail({
  sessionId,
  changes,
  onChangesAction,
  onOpenChanges,
  browser,
  onShowBrowser,
  browserTabs,
  onPickBrowserTab,
  onCloseBrowser,
  environment,
  context,
  usage,
  onReadUsage,
  running,
  onCompact,
  pr,
  sessionPrs,
  onOpenPr,
  servers,
  onOpenServer,
  onShowServers,
  tasks,
  onShowTasks,
  keepAwake,
  onKeepAwake,
  keepAwakeDisabled,
  onClose,
}: {
  sessionId: string;
  changes: GitChanges | null; // The changes of the session folder against its base branch.
  // Asks the agent to open a pull request, commit, or push. null: not possible now.
  onChangesAction: ((action: GitAction) => void) | null;
  onOpenChanges?: () => void; // Open the Changes pane (the diff of the session), as a click on the counts in the Claude app.
  browser: RailBrowser | null;
  onShowBrowser: () => void; // Open the Browser pane on the page of the agent.
  browserTabs: () => RailBrowserTab[]; // The tabs of the session, read when the tab menu opens.
  onPickBrowserTab: (id: string) => void; // The tab menu: the section shows this tab.
  onCloseBrowser: (() => void) | null; // "Close tab". null: the headless browser has no tab.
  environment: RailEnvironment;
  context: { tokens: number; length: number } | null;
  usage: ContextUsage | null; // The last context breakdown (context.usage).
  onReadUsage: () => void; // Asks the daemon for the breakdown (context.get).
  running: boolean; // A turn runs: the compaction waits.
  onCompact: () => void;
  pr: PrStatus["pr"];
  sessionPrs: string[]; // The URLs of the pull requests that the agent made in this session, the newest first.
  onOpenPr: (url: string) => void;
  servers: ServerItem[];
  onOpenServer: (server: ServerItem) => void;
  onShowServers: () => void;
  tasks: TaskItem[];
  onShowTasks: () => void;
  keepAwake: boolean; // "Keep computer awake" for this session (the same switch as in the ⋮ menu).
  onKeepAwake: (on: boolean) => void;
  keepAwakeDisabled: boolean; // Not connected.
  onClose: () => void; // Esc or a click outside, in a narrow window.
}) {
  // The Context section always starts folded (the user asked for this). Its heading shows the share in use.
  const [folded, setFolded] = useState<RailSection[]>(() => {
    const saved = foldedSections();
    return saved.includes("context") ? saved : [...saved, "context"];
  });
  const [order, setOrder] = useState<RailSection[]>(sectionOrder);
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

  // The open Context section shows the breakdown. Ask for it again after each change of the context.
  const contextOpen = context !== null && !folded.includes("context");
  useEffect(() => {
    if (contextOpen) onReadUsage();
  }, [contextOpen, context?.tokens, context?.length]);

  const PlaceIcon = PLACE_ICONS[environment.placeKind];
  const share = context ? contextShare(context.tokens, context.length) : 0;
  const level = share >= 0.8 ? "high" : share >= 0.6 ? "mid" : "low";
  // Only the running tasks (commands, monitors, agents, wakeups). An ended task goes away from the rail.
  const shownTasks = railTasks(tasks);
  // The time of a wakeup counts down.
  const [now, setNow] = useState(() => Date.now());
  const waiting = tasks.some((t) => (t.kind === "wakeup" || t.kind === "cron") && t.status === "running");
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [waiting]);
  const branch = environment.worktree?.branch ?? environment.branch;
  // The pull request of the branch: from git.changes (a newer daemon), else from the sidebar status.
  const branchPr = changes && changes.pr !== undefined ? changes.pr : pr;
  // The pull requests of the session, as in the Claude app. The rail keeps their state current: it asks
  // when it opens, every 30 seconds while the window shows, when the window comes back, and after each turn.
  const prInfo = usePrInfos();
  const branchKey = prKeyUrl(branchPr?.url);
  usePrRefresh(branchKey && !sessionPrs.includes(branchKey) ? [...sessionPrs, branchKey] : sessionPrs, running);
  const prs = listedPrs(sessionPrs, branchPr, prInfo);

  // Under the environment: the computer of the agent does not sleep while the agent works in this session.
  const awake = (
    <button
      type="button"
      role="switch"
      aria-checked={keepAwake}
      className="rail-awake"
      disabled={keepAwakeDisabled}
      onClick={() => onKeepAwake(!keepAwake)}
      aria-label="Keep computer awake"
      title="Only for this session"
    >
      {/* A small row with a small switch, as "Remote Control" in the Claude app. */}
      <Coffee size={13} aria-hidden className="rail-awake-icon" />
      <span className="rail-awake-text">Keep computer awake</span>
      <span className={`switch switch-small${keepAwake ? " on" : ""}`} aria-hidden>
        <span className="switch-knob" />
      </span>
    </button>
  );

  const body: Record<RailSection, ReactNode | null> = {
    browser: browser ? (
      <RailBrowserView browser={browser} onShow={onShowBrowser} tabs={browserTabs} onPick={onPickBrowserTab} onClose={onCloseBrowser} />
    ) : null,
    // The pull request of the branch, the work in three parts (uncommitted, not pushed, pushed),
    // and the git button ("Create PR", "Commit", "Push"), as in the Claude app.
    changes: changes?.repo ? (
      <RailChanges sessionId={sessionId} changes={changes} pr={branchPr} prs={prs} running={running} onAction={onChangesAction} onOpenChanges={onOpenChanges} onOpenPr={onOpenPr} />
    ) : null,
    environment: (
      <>
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
      {awake}
      </>
    ),
    context: context ? (
      <div className="rail-context">
        <div className="rail-context-head">
          <span>
            {formatTokens(context.tokens)} of {formatTokens(context.length)} tokens
          </span>
          <span className="rail-context-pct">{percentText(share)}</span>
        </div>
        {usage ? (
          <ContextBreakdown usage={usage} />
        ) : (
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
        )}
        <button type="button" className="btn btn-small rail-action" onClick={onCompact} disabled={running} title={running ? "Compaction waits for the end of the turn." : undefined}>
          <Archive size={13} aria-hidden /> Compact
        </button>
      </div>
    ) : (
      <p className="rail-empty">No context data yet. It shows after the first turn.</p>
    ),
    // The Changes section shows the pull request of a git folder. This section shows it only when
    // the Changes section does not show.
    pullRequests: prs.length > 0 && !changes?.repo ? <RailPrList prs={prs} onOpen={onOpenPr} /> : null,
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
      shownTasks.length > 0 ? (
        <>
          <p className="rail-empty">{taskSummary(shownTasks)}</p>
          <ul className="rail-list">
            {shownTasks.map((t) => (
              <li key={t.id}>
                <button type="button" className="rail-item" onClick={onShowTasks} title={t.command}>
                  <span className={`rail-dot ${t.status === "running" ? "running" : t.status === "done" ? "stopped" : "crashed"}`} aria-hidden />
                  <span className="rail-item-text">
                    <span className="rail-item-title">{t.description || t.command}</span>
                    <span className="rail-item-detail">{taskDetailText(t, now)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null,
  };

  const titles = Object.fromEntries(RAIL_SECTIONS.map((s) => [s.id, s.title])) as Record<RailSection, string>;
  const shown = order.filter((id) => body[id] !== null);
  // Drag a heading (or its grip at the right) to move the section. The other sections slide out of
  // the way while the user drags (useSortable). The order stays for new sessions.
  const sort = useSortable(shown, (id, target) => {
    const section = id as RailSection;
    setOrder((o) => {
      const rest = shown.filter((x) => x !== section);
      if (rest.length === 0) return o;
      return target < rest.length ? moveSection(o, section, rest[target], false) : moveSection(o, section, rest[rest.length - 1], true);
    });
  });

  return (
    <aside ref={ref} id={SESSION_RAIL_ID} className="session-rail" role="group" aria-label="Session details" tabIndex={-1}>
      {shown.map((id) => {
        const s = { id, title: titles[id] };
        const open = !folded.includes(s.id);
        const bodyId = `rail-section-${s.id}`;
        return (
          <section
            key={s.id}
            ref={sort.itemRef(s.id)}
            style={sort.styleOf(s.id)}
            className={`rail-section${open ? " open" : ""}${sort.dragging === s.id ? " dragging" : ""}`}
            onClickCapture={sort.swallowClick}
          >
            <h3 className="rail-section-head" onPointerDown={(e) => sort.onPointerDown(s.id, e)}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={bodyId}
                title="Drag to move. Alt+Up or Alt+Down also moves it."
                onClick={() => setFolded((f) => toggleFolded(f, s.id))}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  setOrder((o) => stepSection(o, shown, s.id, e.key === "ArrowUp" ? -1 : 1));
                }}
              >
                <ChevronRight size={13} aria-hidden className="rail-chevron" />
                {s.title}
                {!open && foldedValue(s.id, context) && (
                  <span className="rail-head-value" aria-label={`${foldedValue(s.id, context)} of the context window in use`}>
                    {foldedValue(s.id, context)}
                  </span>
                )}
              </button>
              {/* The grip at the far right shows on hover, as in the Claude app. */}
              <span className="rail-grip" aria-hidden>
                <GripVertical size={14} />
              </span>
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

/**
 * A small live view of the page where the agent works, as the small browser view of the Claude app:
 * a head with the page title (a menu of the tabs) and the buttons, then the picture of the page.
 * A click on the picture opens it in the Browser pane, where the user can use the same page. While
 * the agent uses the page, the picture has an outline in the accent color. The pictures of the
 * agent tab come from the tab itself.
 */
function RailBrowserView({
  browser,
  onShow,
  tabs,
  onPick,
  onClose,
}: {
  browser: RailBrowser;
  onShow: () => void;
  tabs: () => RailBrowserTab[];
  onPick: (id: string) => void;
  onClose: (() => void) | null;
}) {
  const [picture, setPicture] = useState<string | null>(null);
  const { tab, live } = browser;
  // The tab menu. It reads the tabs when it opens.
  const [menu, setMenu] = useState<RailBrowserTab[] | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menu !== null]);
  useEffect(() => {
    setPicture(null);
  }, [tab]);
  useEffect(() => {
    if (!tab) return;
    let stop = false;
    let timer = 0;
    const take = async () => {
      if (document.hidden) {
        // No one sees the window: no picture now.
        if (!stop && live) timer = window.setTimeout(take, LIVE_EVERY);
        return;
      }
      try {
        const image = await captureAgentTab(tab);
        if (!stop) setPicture(image);
      } catch {
        // The tab is hidden or busy. The last picture stays.
      }
      if (!stop && live) timer = window.setTimeout(take, LIVE_EVERY);
    };
    void take();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [tab, live]);
  const image = tab ? picture : browser.image;
  const label = browser.title.trim() || browser.url;
  const name = label || "Agent browser";
  return (
    <div className={`rail-browser${browser.agent ? " agent" : ""}`}>
      <div className="rail-browser-head">
        <div className="rail-browser-pick" ref={menuRef}>
          {/* The headless browser has one page: no tab menu. */}
          <button
            type="button"
            className="rail-browser-title"
            disabled={!tab}
            aria-haspopup={tab ? "menu" : undefined}
            aria-expanded={tab ? menu !== null : undefined}
            onClick={() => setMenu((m) => (m ? null : tabs()))}
            title={tab ? "Choose a tab" : undefined}
          >
            <Globe size={14} aria-hidden />
            <span className="rail-browser-name">{name}</span>
            {tab && <ChevronDown size={13} aria-hidden />}
          </button>
          {menu && (
            <div
              className="menu rail-browser-menu"
              role="menu"
              aria-label="Browser tabs"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setMenu(null);
                }
              }}
            >
              {menu.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={t.rail}
                  onClick={() => {
                    setMenu(null);
                    if (!t.rail) onPick(t.id);
                  }}
                >
                  <Globe size={14} aria-hidden />
                  <span className="rail-browser-name">{t.label}</span>
                  {t.rail && <Check size={14} aria-hidden />}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className="spacer" />
        <button type="button" className="icon-btn ghost" onClick={onShow} aria-label="Open in the Browser pane" title="Open in the Browser pane">
          <Maximize2 size={14} aria-hidden />
        </button>
        {onClose && (
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close tab" title="Close tab">
            <X size={15} aria-hidden />
          </button>
        )}
      </div>
      <button type="button" className="rail-browser-frame" onClick={onShow} title="Open in the Browser pane">
        {image ? <img src={image} alt={`The page: ${name}`} /> : <span className="rail-browser-empty">Opening the page…</span>}
      </button>
      {browser.agent && <span className="sr-only">The agent uses this page now.</span>}
    </div>
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
