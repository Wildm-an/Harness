import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  FileText,
  Folder,
  Globe as GlobeIcon,
  FileDiff,
  GitBranch,
  Globe,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  MessagesSquare,
  Settings as SettingsIcon,
  ListChecks,
  Monitor,
  PanelLeft,
  PanelRight,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Blocks,
  CalendarClock,
} from "lucide-react";
import { chatReducer, emptyChat, type PermissionItem } from "./chat/state";
import { DaemonConnection, type ConnectionStatus } from "./daemon/connection";
import type {
  CommandItem,
  Decision,
  DirListing,
  HostInfo,
  McpStatus,
  PluginsStatus,
  ProjectItem,
  ProviderFields,
  ProviderItem,
  PermissionMode,
  PlanDecision,
  RunningSession,
  PrStatus,
  SessionSummary,
  SkillDetail,
} from "./daemon/protocol";
import { ProvidersScreen, type ProviderSave, type ProviderTest } from "./components/ProvidersScreen";
import {
  deleteHfToken,
  deleteProviderKey,
  loadHfToken,
  loadProviderKey,
  renameProviderKey,
  saveHfToken,
  saveProviderKey,
  WEB_KEY_PROVIDERS,
  deleteWebKey,
  loadWebKey,
  saveWebKey,
  type WebKeyProvider,
} from "./lib/providerKeys";
import { CookbookScreen } from "./cookbook/CookbookScreen";
import { CapabilitiesPage, toCapTab, type CapTab, type ConnectorAction, type DeviceCode, type McpAuthAction } from "./components/CapabilitiesPage";
import { PluginsScreen } from "./components/PluginsScreen";
import { useCookbook } from "./cookbook/useCookbook";
import { ConnectionsScreen } from "./components/ConnectionsScreen";
import { FolderPicker } from "./components/FolderPicker";
import { DiffReview } from "./components/DiffReview";
import { ChangesView } from "./components/ChangesView";
import { RulesPanel, type Rules } from "./components/RulesPanel";
import { Workspace, type PaneSpec } from "./layout/Workspace";
import {
  closePane,
  defaultLayout,
  findGroupOf,
  ideLayoutFor,
  layoutSignature,
  legacyIdeLayoutFor,
  openPane,
  reopenInSlot,
  parseLayout,
  togglePane,
  type LayoutNode,
  type PaneId,
  type PaneSlot,
} from "./layout/model";
import {
  BACK_SHORTCUT,
  FORWARD_SHORTCUT,
  SIDEBAR_SHORTCUT,
  SIDE_CHAT_SHORTCUT,
  VIEW_SHORTCUT,
  isSidebarShortcut,
  isViewShortcut,
  isSideChatShortcut,
  isNewSessionShortcut,
  isSearchShortcut,
  NEW_SESSION_SHORTCUT,
  SEARCH_SHORTCUT,
  navShortcut,
  shortcutLabel,
  shortcutPane,
} from "./layout/shortcuts";
import { emptyHistory, forget, placeOf, samePlace, step, visit, type NavHistory, type Place } from "./layout/history";
import { TerminalPane, forgetSessionTerminals } from "./components/TerminalPane";
import { SideChat, useSideChat } from "./components/SideChat";
import { MoreMenu } from "./components/MoreMenu";
import { UpdateToast } from "./components/UpdateToast";
import { ToastStack } from "./components/ToastStack";
import { availableVersion, checkWhenShown, useUpdateState } from "./lib/updater";
import { AppearanceSettings, GeneralSettings, SETTINGS_SHORTCUT, SettingsDialog, busySend, isSettingsShortcut, type SettingsPage } from "./components/SettingsDialog";
import { YourHarnessSettings } from "./components/YourHarnessSettings";
import { OperatingHarnessSettings } from "./components/OperatingHarnessSettings";
import { HarnessMenu } from "./components/HarnessMenu";
import { StorageDialog } from "./components/StorageDialog";
import { TasksPane } from "./components/TasksPane";
import { PreviewPane } from "./preview/PreviewPane";
import { base64ToBytes, isPreviewFile, shownDocument, type PreviewDoc } from "./preview/document";
import { WindowControls, hasWindowControls } from "./components/WindowControls";
import { SIDEBAR_DEFAULT, SidebarResizer, clampSidebar } from "./components/SidebarResizer";
import { saveLastMode } from "./components/ModeMenu";
import { EditorPane } from "./editor/EditorPane";
import { useEditor } from "./editor/useEditor";
import { overlayOpen } from "./lib/overlay";
import { addErrorToast, addUndoToast, errorRoute, type ErrorToastItem } from "./lib/errorRoute";
import { waitingCardHint } from "./lib/cardKeys";
import { ErrorToasts } from "./components/ErrorToasts";
import { canStartPeek, peekGate } from "./lib/sidebarPeek";
import {
  BrowserPane,
  agentBrowserOf,
  browserTabsOf,
  clearBrowserData,
  closeTabById,
  hideRailBrowser,
  keepCookies,
  minimizeShownTab,
  onAgentBrowser,
  runAgentCall,
  showAgentTab,
  showTabInRail,
} from "./browser/BrowserPane";
import { pendingServerApprovals } from "./browser/ServerBlock";
import { annotationAttachment, screenshotAttachment } from "./browser/annotate";
import { AllowedSites } from "./components/AllowedSites";
import { openLink, setPaneOpener } from "./lib/openLink";
import { ROOM_PANES, railAfterPanes, railShown, setRailShown } from "./lib/sessionRail";
import { inlineEditPrompt, layoutKey, setViewMode, viewMode, type ViewMode } from "./lib/viewMode";
import { IDE_LAYOUT_EVENT, ideOptions } from "./lib/ideLayout";
import { IdeLayoutMenu } from "./components/IdeLayoutMenu";
import { SESSION_RAIL_ID, SessionRail } from "./components/SessionRail";
import { loadWorktreeChoice, worktreeKey } from "./components/WorktreeMenu";
import { useServers } from "./servers/useServers";
import type { AgentFrame, AgentServer, ClientMessage, ConnectorItem, Effort, GitBranches, GitChanges, GitDiff, GitDiffScope, RoutineItem, RoutineRun, ServerItem, SessionHarness, SessionWorktree, TaskDetail, TaskItem, UserSettings } from "./daemon/protocol";
import { RoutinesPage } from "./components/RoutinesPage";
import { notifyFilesSent, notifyRoutineRun, notifyTurnDone, onNotificationOpen } from "./lib/notify";
import { UpdateGuard } from "./components/UpdateGuard";
import { parseUnifiedDiff } from "./lib/diff";
import { OpenPathContext } from "./lib/openPath";
import { CardActionsContext, fileKind, opensInPane, type CardActions } from "./lib/cardActions";
import { normalizePath, openFolderBlocked } from "./editor/paths";
import { loadPref, savePref } from "./lib/prefs";
import type { ContextUsage } from "./lib/context";
import { ContextRing } from "./components/ContextRing";
import { MessageList, NO_QUEUE, reconcileQueue, type QueuedItem } from "./components/MessageList";
import { SplitDropZone, SplitEdge, SplitPane, useSplitDrop } from "./components/SplitView";
import { clampSplit, MAIN_PROMPT_ID, SPLIT_DEFAULT } from "./lib/split";
import { usePresence } from "./lib/motion";
import { isLoopback, setVisualDaemon } from "./lib/visual";
import { SessionSearch } from "./components/SessionSearch";
import { DOUBLE_ESC_MS, RewindDialog, rewindTargets } from "./components/RewindDialog";
import { DaemonUpdateToast, VersionWarning, type DaemonUpdate } from "./components/VersionWarning";
import { compareVersions } from "./lib/version";
import { ChangelogPage } from "./components/ChangelogPage";
import { PromptBox, type PromptAttachment, type Submission } from "./components/PromptBox";
import { mentionOrder } from "./components/mentions";
import { SessionStart } from "./components/SessionStart";
import { FolderChooser, samePath } from "./components/RecentFolders";
import { ArchiveConfirm } from "./components/ArchiveConfirm";
import { DeleteSessionConfirm } from "./components/DeleteSessionConfirm";
import { Sidebar, pathKey, type SessionTool } from "./components/Sidebar";
import { ModelMenu, type ModelList } from "./components/ModelMenu";
import { ModelUnavailable } from "./components/ModelUnavailable";
import { isModelUnavailable, networkModel, proposedModel, rememberModel } from "./lib/modelAvailability";
import { ModelChoice, isLocalProvider } from "./components/ModelChoice";
import { QuitGuard } from "./components/QuitGuard";
import { MODES, ModeMenu, nextMode } from "./components/ModeMenu";
import {
  LOCAL,
  closeTunnel,
  deleteToken,
  lastConnectionId,
  loadConnections,
  loadToken,
  resolveTarget,
  saveConnections,
  saveToken,
  setLastConnectionId,
  type Connection,
} from "./lib/connections";
import { appVersionOf, daemonWheel, forwardCloseAll, forwardOpen, isTauri, openExternal, openLocalPath, pickFiles, pickFolder, revealInExplorer } from "./lib/tauri";
import { filesPromptText } from "./lib/fileRefs";
import { noImageNote } from "./lib/images";
import { modelName } from "./lib/modelName";
import { ACTION_LABELS, ACTION_PROMPTS, prInfoStore, sessionPrUrls } from "./lib/pr";
import { FolderMenu } from "./components/FolderMenu";
import { SessionTitle } from "./components/SessionTitle";
import type { SessionActions } from "./components/SessionRow";

type Screen = "starting" | "connections" | "start" | "chat" | "providers" | "cookbook" | "plugins" | "capabilities" | "routines";

const PROVIDER_REPLY_TIMEOUT = 15_000;

// The remote folder picker. ``resolve`` returns the selected folder to the session start screen.
interface Picker {
  resolve: (path: string | null) => void;
  initial: string;
  listing: DirListing | null;
  error: string | null;
}

const CONNECTION_ICONS = { local: Monitor, direct: Globe, ssh: KeyRound };

// The sidebar asks for this many sessions of all projects.
const SIDEBAR_SESSIONS = 300;

// On a window this narrow, the sidebar covers the page (the same width as in styles.css).
const NARROW_QUERY = "(max-width: 900px)";
// The hidden sidebar: the time the pointer stays on the sidebar toggle before it shows, and the time
// after the pointer leaves it before it goes away.
const PEEK_OPEN_MS = 120;
const PEEK_CLOSE_MS = 300;

// Project files that open in the Browser pane. PDF and Word files open in the Preview pane.
const BROWSER_FILE_RE = /\.(html?|png|jpe?g|gif|svg|webp|avif|mp4|webm|mov|ogg|mp3|wav)$/i;

/** The saved layout of a project in a view, or the default layout of the view. */
function loadLayout(connectionId: string, cwd: string, mode: ViewMode): LayoutNode {
  const fallback = () => (mode === "ide" ? ideLayoutFor(ideOptions()) : defaultLayout());
  try {
    const saved = parseLayout(JSON.parse(loadPref(layoutKey(connectionId, cwd, mode), "null")));
    // A saved IDE layout that is still the old default (the file list in the editor) gets the
    // new default with the Files pane. A layout that the user changed stays.
    if (saved && mode === "ide" && layoutSignature(saved) === layoutSignature(legacyIdeLayoutFor(ideOptions()))) return fallback();
    return saved ?? fallback();
  } catch {
    return fallback();
  }
}

/** The layout with no editor and no Files pane: the Code view at a new session or after a switch from the IDE view. */
function withoutEditor(layout: LayoutNode): LayoutNode {
  return closePane(closePane(layout, "files"), "editor");
}

/** An icon button in the top bar that shows or hides a pane. */
function PaneToggle({ icon: Icon, label, active, alert, onClick }: {
  icon: typeof Code2;
  label: string;
  active: boolean;
  alert?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ghost pane-toggle${active ? " active" : ""}`}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      <Icon size={16} aria-hidden />
      {alert && <span className="toggle-alert" aria-hidden />}
    </button>
  );
}

function ConnectionIcon({ connection }: { connection: Connection | null }) {
  const Icon = CONNECTION_ICONS[connection?.kind ?? "local"];
  return <Icon size={13} aria-hidden />;
}


interface ActiveSession {
  id: string;
  cwd: string;
  model: string;
  modelUnavailable: string | null; // Why the daemon cannot use the stored model (its provider is gone or off).
  harness: SessionHarness | null; // Another harness runs the agent loop through ACP. null: the built-in loop.
  title: string | null;
  project: string | null; // The name of the saved project.
  worktree: SessionWorktree | null; // The session works in this git worktree.
}

/** The daemon message of a prompt or a command, and the user message that the chat shows. */
function submissionMessage(s: Submission): { message: ClientMessage; shown: string; startsTurn: boolean; messageId?: string; images?: string[] } {
  if (s.kind === "prompt") {
    const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; // Rewind and fork find the message by this id.
    const images = s.images?.length ? s.images : undefined;
    return {
      message: { type: "prompt", text: s.text, id, ...(s.display ? { display: s.display } : {}), ...(images ? { images } : {}) },
      shown: s.display ?? s.text,
      startsTurn: true,
      messageId: id,
      images,
    };
  }
  // /compact runs like a turn: the daemon ends it with turn.end.
  return {
    message: { type: "command", name: s.name, args: s.args },
    shown: `/${s.name}${s.args ? ` ${s.args}` : ""}`,
    startsTurn: s.name === "compact",
  };
}

/** The longest wait between two automatic reconnect tries. */
const RECONNECT_MAX_MS = 30_000;
/** The wake check: a timer ticks each WAKE_TICK_MS. A gap above WAKE_GAP_MS shows a sleep of the computer. */
const WAKE_TICK_MS = 10_000;
const WAKE_GAP_MS = 45_000;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True when the agent can work in a tab of the Browser pane: the desktop app on Windows, with the daemon of this computer. */
function canHostAgentBrowser(kind: string | undefined): boolean {
  return isTauri() && kind === "local" && /Windows/i.test(navigator.userAgent);
}

export default function App() {
  // A ref, not useMemo: React Fast Refresh runs useMemo again, and a second connection object would be closed.
  const connRef = useRef<DaemonConnection | null>(null);
  connRef.current ??= new DaemonConnection();
  const conn = connRef.current;
  const [screen, setScreen] = useState<Screen>("starting");
  const [status, setStatus] = useState<ConnectionStatus>("closed");
  const [busy, setBusy] = useState(false);
  const [connections, setConnections] = useState<Connection[]>(() => loadConnections());
  const [current, setCurrent] = useState<Connection | null>(null); // The connection that is open or opens.
  const [hello, setHello] = useState<HostInfo | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connError, setConnError] = useState<{ id: string; message: string } | null>(null);
  const [tokenIds, setTokenIds] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<Picker | null>(null);
  const currentRef = useRef<Connection | null>(null);
  currentRef.current = current;
  const [startError, setStartError] = useState<string | null>(null);
  // The stored sessions of one folder (cwd), or of all folders (cwd null).
  const [recent, setRecent] = useState<SessionSummary[]>([]); // The sessions of all folders (the sidebar).
  // The connection whose session list the sidebar has. null: no list yet (the sidebar shows skeleton rows).
  const [recentOf, setRecentOf] = useState<string | null>(null);
  const recentOfRef = useRef(recentOf); // For afterConnect, which keeps its first closure.
  recentOfRef.current = recentOf;
  const [prStatus, setPrStatus] = useState<Map<string, PrStatus>>(() => new Map()); // By pathKey of the folder.
  // The changes of the session folder against its base branch, for the Changes section of the rail.
  const [gitChanges, setGitChanges] = useState<(GitChanges & { cwd: string }) | null>(null);
  // The full change of the session folder, for the Changes pane when no single change is in review.
  const [gitDiff, setGitDiff] = useState<(GitDiff & { cwd: string }) | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null); // The last git.diff request failed.
  const [diffScope, setDiffScope] = useState<GitDiffScope>("branch");
  const [searchOpen, setSearchOpen] = useState(false); // The session search (Ctrl+K).
  const [rewindOpen, setRewindOpen] = useState(false); // The Rewind dialog (Esc two times).
  const [runningSessions, setRunningSessions] = useState<RunningSession[]>([]); // The sessions with a running turn.
  // The sessions with no window that work or wait: routine runs and nested sessions (start_session).
  const [backgroundSessions, setBackgroundSessions] = useState<RunningSession[]>([]);
  // Split view (SplitView.tsx): the session at the right, with its own connection to the daemon.
  const [split, setSplit] = useState<string | null>(null);
  const [splitRunning, setSplitRunning] = useState<RunningSession | null>(null); // From the connection of the split pane.
  const [splitShare, setSplitShare] = useState(() => clampSplit(Number(loadPref("split.width", String(SPLIT_DEFAULT)))));
  const [splitFocus, setSplitFocus] = useState(0);
  const splitRowRef = useRef<HTMLDivElement>(null);
  // The sidebar shows all lists. A session of this window is first: it has the newer state.
  const allRunning = useMemo(() => {
    const own = splitRunning ? [...runningSessions, splitRunning] : runningSessions;
    const ids = new Set(own.map((r) => r.session_id));
    return [...own, ...backgroundSessions.filter((r) => !ids.has(r.session_id))];
  }, [runningSessions, backgroundSessions, splitRunning]);
  // The sessions with a turn that ended while the user was in another session (a blue dot in the sidebar).
  // The messages that wait for the running turn, for each session. The next one goes when the turn ends.
  const [queues, setQueues] = useState<Record<string, QueuedItem[]>>({});
  const showStartRef = useRef<() => void>(() => undefined);
  const [unreadSessions, setUnreadSessions] = useState<Set<string>>(() => new Set());
  const lastRunning = useRef<RunningSession[]>([]);
  const firstPrompt = useRef<Submission | null>(null); // The task or command from the start screen, for the new session.
  // The project that the start screen selects: from a "+" in the sidebar, or the last project at the start.
  const [startProject, setStartProject] = useState<{ id: string; key: number } | null>(null);
  const startPicked = useRef(false); // The start screen got the last project after this connection.
  const [fileMatches, setFileMatches] = useState<{ query: string; items: string[] } | null>(null); // The "@" menu.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null); // The context breakdown.
  // The app opens in the view that the user used last. The IDE view starts with the sidebar hidden.
  // The Code view shows it again (switchView).
  const [startView] = useState(viewMode);
  const [savedSidebar] = useState(() => loadPref("sidebar.open", "1") === "1" && !window.matchMedia(NARROW_QUERY).matches);
  const [sidebarOpen, setSidebarOpen] = useState(startView === "code" && savedSidebar);
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebar(Number(loadPref("sidebar.width", String(SIDEBAR_DEFAULT)))));
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [branches, setBranches] = useState<(GitBranches & { cwd: string }) | null>(null); // For the worktree chip.
  const [archiveAsk, setArchiveAsk] = useState<{ id: string; branch: string } | null>(null); // A worktree with changes.
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null); // The id of the session that "Delete session?" asks about.
  // The next prompt that the model predicts after a turn, for the session that got it.
  const [suggestion, setSuggestion] = useState<{ sessionId: string; text: string } | null>(null);
  // "Not now" on the unavailable model prompt, by "session id model". The prompt shows again after a restart.
  const [modelAskDismissed, setModelAskDismissed] = useState<Set<string>>(() => new Set());
  const [chat, dispatchNow] = useReducer(chatReducer, emptyChat);
  // The error popups at the bottom of the window: the errors that are not part of the conversation and
  // that no view shows itself (lib/errorRoute.ts, rule M18a).
  const [errorToasts, setErrorToasts] = useState<ErrorToastItem[]>([]);
  const errorToastId = useRef(0);
  const showError = useCallback((text: string) => setErrorToasts((l) => addErrorToast(l, text, ++errorToastId.current)), []);
  // The "Undo" popup of an action that does not ask first (rule R7a).
  const showUndo = useCallback(
    (text: string, undo: () => void) => setErrorToasts((l) => addUndoToast(l, text, undo, ++errorToastId.current)),
    [],
  );
  // The last submission that started a turn, for each session: "Try again" on an error card sends it again.
  const lastSubmission = useRef(new Map<string, Submission>());
  const filledText = useRef<string | null>(null); // The text of the last prompt.fill (a rewind or a fork).
  // The model streams many small "token" messages. The chat collects their text and renders it once a frame,
  // not once a message: each render of the chat is a render of the whole app.
  const pendingTokens = useRef("");
  const tokenFlush = useRef<{ raf: number; timer: number } | null>(null);
  const flushTokens = useCallback(() => {
    const scheduled = tokenFlush.current;
    if (scheduled) {
      cancelAnimationFrame(scheduled.raf);
      window.clearTimeout(scheduled.timer);
      tokenFlush.current = null;
    }
    const text = pendingTokens.current;
    if (!text) return;
    pendingTokens.current = "";
    dispatchNow({ type: "daemon", msg: { type: "token", text } });
  }, []);
  const queueToken = useCallback(
    (text: string) => {
      pendingTokens.current += text;
      if (tokenFlush.current) return;
      // A hidden window gets no animation frames. The timer then shows the text after a short time.
      tokenFlush.current = { raf: requestAnimationFrame(flushTokens), timer: window.setTimeout(flushTokens, 100) };
    },
    [flushTokens],
  );
  // All other chat actions come after the text that came before them.
  const dispatch = useCallback(
    (action: Parameters<typeof dispatchNow>[0]) => {
      flushTokens();
      dispatchNow(action);
    },
    [flushTokens],
  );
  const [layout, setLayout] = useState<LayoutNode>(defaultLayout);
  // The last place and size of each closed pane, per view. A pane that opens again goes back there.
  const closedSlots = useRef(new Map<ViewMode, Map<PaneId, PaneSlot>>());
  const lastLayout = useRef<LayoutNode | null>(null);
  // The Code view or the IDE view (the switch in the title bar). Each view has its own layout. The
  // app always opens in the Code view, and each new session starts in it (newSession, startSession).
  const [view, setView] = useState<ViewMode>(startView);
  const viewRef = useRef(view);
  viewRef.current = view;
  useLayoutEffect(() => {
    let slots = closedSlots.current.get(view);
    if (!slots) closedSlots.current.set(view, (slots = new Map()));
    const placed = reopenInSlot(lastLayout.current, layout, slots);
    lastLayout.current = placed;
    if (placed !== layout) setLayout(placed);
  }, [layout, view]);
  // The IDE view hides the sessions sidebar. This is the sidebar state of the Code view.
  const [ideStart, setIdeStart] = useState(0); // A new number: the start screen starts an empty session.
  // false: the start screen shows the recent folders in its center (the app just opened, "New
  // session", or the "+" of a project). A folder from that block, a new session, or an open session makes it true.
  const [folderChosen, setFolderChosen] = useState(false);
  const sidebarBeforeIde = useRef<boolean | null>(startView === "ide" ? savedSidebar : null);
  const ideStarting = useRef(false); // The IDE switch on the start screen starts this session: it stays in the IDE view.
  // The empty session that the IDE switch started: its editor shows the folder block until the user
  // opens a file or sends a prompt. ideBlockNext: the next new session gets the block.
  const [ideBlockFor, setIdeBlockFor] = useState<string | null>(null);
  const ideBlockNext = useRef(false);
  // The next new session starts in the Code view: it opens with the chat only, with no editor or Files pane.
  const codeStartNext = useRef(false);
  // The same empty session until the user sends a prompt. A switch back to the Code view removes it
  // and shows the start screen again: only the view changed.
  const ideEmptyFor = useRef<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null); // The chat item in the Changes pane.
  const [promptInsert, setPromptInsert] = useState<{ text: string; key: number; replace?: boolean } | null>(null);
  // A block of context for the prompt box, for example a browser annotation (a chip in the box).
  const [promptAttach, setPromptAttach] = useState<{ item: PromptAttachment; key: number } | null>(null);
  const [browserRequest, setBrowserRequest] = useState<{ url: string; key: number } | null>(null);
  const [previewServer, setPreviewServer] = useState<string | null>(null); // /preview waits for this server.
  const [filesToken, setFilesToken] = useState<string | null>(null);
  const [agentFrame, setAgentFrame] = useState<(AgentFrame & { key: number }) | null>(null); // The agent browser page.
  const [frameLive, setFrameLive] = useState(false); // The headless agent browser sent a live frame lately.
  const frameLiveTimer = useRef(0);
  const [showAgentView, setShowAgentView] = useState(0); // A change shows the headless agent page in the Browser pane.
  const [autoVerify, setAutoVerify] = useState(false);
  const targetRef = useRef<{ host: string; port: number; token: string } | null>(null);
  const [commands, setCommands] = useState<CommandItem[] | null>(null); // The / menu.
  // The Capabilities page: the skills, the open skill, the project folder, and whether a session is open in it.
  const [skillItems, setSkillItems] = useState<CommandItem[] | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null | "loading">(null);
  const [capsFolder, setCapsFolder] = useState<string | null>(null);
  const [capsLive, setCapsLive] = useState(false);
  const capsFallback = useRef(false); // An older daemon: the page asks for the skills and the MCP servers one at a time.
  const openCapabilitiesRef = useRef<(tab?: CapTab) => void>(() => {});
  // The tab of the Capabilities page. The page opens on the last tab.
  const [capsTab, setCapsTabState] = useState<CapTab>(() => toCapTab(loadPref("capabilitiesTab", "skills")));
  const setCapsTab = (tab: CapTab) => {
    setCapsTabState(tab);
    savePref("capabilitiesTab", tab);
  };
  const [instructions, setInstructions] = useState<string | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesSavedAt, setRulesSavedAt] = useState<number | null>(null);
  const rulesSaving = useRef(false);
  const sessionRef = useRef<ActiveSession | null>(null);
  sessionRef.current = session;

  // Settings > Appearance > IDE view changed: the open session shows the new IDE layout at once.
  useEffect(() => {
    const onChange = () => {
      if (viewRef.current === "ide" && sessionRef.current) setLayout(ideLayoutFor(ideOptions()));
    };
    window.addEventListener(IDE_LAYOUT_EVENT, onChange);
    return () => window.removeEventListener(IDE_LAYOUT_EVENT, onChange);
  }, []);
  // The Providers screen.
  const [providers, setProviders] = useState<{ items: ProviderItem[]; path: string } | null>(null);
  const [providerTest, setProviderTest] = useState<ProviderTest | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelList | null>(null); // The model menus: the models of the connections that are on.
  const providerWait = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const providerTestRef = useRef<string | null>(null);
  // The saved projects of the daemon (the start screen).
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const projectWait = useRef<{ resolve: (id: string) => void; reject: (e: Error) => void } | null>(null);
  // The routines of the daemon (the Routines page and the red dot of its nav item).
  const [routines, setRoutines] = useState<RoutineItem[] | null>(null);
  const [routineRuns, setRoutineRuns] = useState<{ routine_id: string; items: RoutineRun[] } | null>(null);
  const [routineError, setRoutineError] = useState<string | null>(null);
  const [routinesFolder, setRoutinesFolder] = useState<string | null>(null); // ~/.harness/routines on the daemon computer.
  const [routineSaved, setRoutineSaved] = useState<{ id: string; key: number } | null>(null);
  // The new API token of a routine, shown one time on the Routines page.
  const [routineToken, setRoutineToken] = useState<{ id: string; token: string } | null>(null);
  // The HTTP address of the daemon (http://host:port): the fire URL of a routine API trigger.
  const [daemonHttp, setDaemonHttp] = useState<string | null>(null);
  // The running servers that an agent started: a close of the window asks to stop them.
  const [agentServers, setAgentServers] = useState<AgentServer[]>([]);
  const shownIdRef = useRef<string | null>(null); // The session that the user sees now, for the message handler.

  /** Opens the Providers screen. Uses only refs and state setters: the message handler calls it too. */
  // The Settings dialog (Ctrl+,): General, Local Models, Providers, and Computers.
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [startHarness, setStartHarness] = useState<SessionHarness | null>(null); // The operating harness of new sessions.
  const [storageOpen, setStorageOpen] = useState(false); // Settings > General > Storage > Manage.
  useEffect(() => {
    if (!settingsPage) setStorageOpen(false); // The Storage dialog closes with Settings.
  }, [settingsPage]);
  const defaultModelKey = useRef<string | null>(null); // The preferred model settings of the last user_settings message.
  const [userSettingsInfo, setUserSettingsInfo] = useState<{ path: string; version: string } | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [daemonVersion, setDaemonVersion] = useState<string | null>(null); // From auth.ok of the connection.
  const [daemonUpdatable, setDaemonUpdatable] = useState(false); // The daemon can install an update from the app.
  const [remoteUpdate, setRemoteUpdate] = useState<DaemonUpdate | null>(null); // "Update daemon" in progress.
  const [remoteHidden, setRemoteHidden] = useState(false); // The user closed the progress of "Update daemon".
  const [versionClosed, setVersionClosed] = useState<string | null>(null); // "{connection}:{app}:{daemon}" of a closed version warning.
  // A new update, or an error, shows the daemon update popup again.
  useEffect(() => {
    if (!remoteUpdate || remoteUpdate.phase === "error") setRemoteHidden(false);
  }, [remoteUpdate]);
  useEffect(() => {
    if (isTauri()) void appVersionOf().then(setAppVersion, () => undefined);
    checkWhenShown(); // A quick look for a new version, only when the user can see the window.
  }, []);
  const newVersion = availableVersion(useUpdateState());
  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "user_settings") {
          setUserSettings(msg.values);
          setStartHarness(msg.harness ?? null);
          setUserSettingsInfo({ path: msg.path, version: msg.version });
          // A change of the preferred models changes the name on the "Default model" chip.
          const { auto_model, online_model, offline_model } = msg.values;
          const key = JSON.stringify([auto_model, online_model, offline_model]);
          if (defaultModelKey.current !== null && defaultModelKey.current !== key) conn.send({ type: "models.list" });
          defaultModelKey.current = key;
        } else if (msg.type === "error" && msg.ref === "user_settings.set") {
          setSettingsError(msg.message);
          try {
            conn.send({ type: "user_settings.get" }); // Show the saved values again.
          } catch {
            // Not connected.
          }
        }
      }),
    [conn],
  );

  /** Opens the Settings dialog at a page, and asks the daemon for the data of the page. */
  const openSettings = useCallback(
    (page: SettingsPage) => {
      setSettingsPage(page);
      setSettingsError(null);
      try {
        if (page === "general" || page === "harness" || page === "operating" || page === "connections") conn.send({ type: "user_settings.get" }); // Providers: the model by network.
        if (page === "connections") {
          setProviderError(null);
          setProviderTest(null);
          conn.send({ type: "providers.list" });
        }
      } catch {
        // Not connected. The page shows the last data.
      }
    },
    [conn],
  );

  // Ctrl+N shows the start screen for a new session, on any screen. In the terminal, Ctrl+N goes to the shell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isNewSessionShortcut(e)) return;
      if (e.target instanceof Element && e.target.closest(".terminal-pane")) return;
      e.preventDefault(); // Also stops the new browser window of the webview.
      e.stopPropagation();
      if (e.repeat || conn.status !== "open") return;
      setSettingsPage(null);
      showStartRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [conn]);

  // Ctrl+K opens the session search on any screen, and closes it. In the code editor, Ctrl+K is the
  // inline edit, as in Cursor (EditorPane.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      if (e.target instanceof Element && e.target.closest(".editor-surface .monaco-editor")) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      setSearchOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Ctrl+, opens the Settings dialog on any screen, and closes it. The dialog asks first when a form has typed text.
  const settingsClose = useRef<(() => void) | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSettingsShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (settingsPage) (settingsClose.current ?? (() => setSettingsPage(null)))();
      else openSettings("general");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [settingsPage, openSettings]);

  const showProviders = useCallback(() => {
    openSettings("connections");
  }, [openSettings]);


  const [hfTokenSaved, setHfTokenSaved] = useState(false);
  // The web search API keys in the keychain (Settings > General > Web).
  const [webKeysSaved, setWebKeysSaved] = useState<Record<WebKeyProvider, boolean>>({ brave: false, tavily: false });
  // The MCP servers of the Capabilities page.
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorItem[] | null>(null);
  const [connectorBusy, setConnectorBusy] = useState<string | null>(null);
  const [connectorError, setConnectorError] = useState<{ id: string; message: string } | null>(null);
  const connectorWait = useRef<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);
  const [pendingEdit, setPendingEdit] = useState<{ path: string; key: number } | null>(null); // A file for the editor.

  /** Opens the Cookbook screen (SPEC.md section 7). */
  const showCookbook = useCallback(() => openSettings("models"), [openSettings]);

  // The Plugins screen (docs/PLUGINS.md).
  const [plugins, setPlugins] = useState<PluginsStatus | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [pluginBusy, setPluginBusy] = useState(false);

  /** Opens the Plugins tab of the Capabilities page. The message handler calls it too. */
  const showPlugins = useCallback(() => openCapabilitiesRef.current("plugins"), []);

  /** Sends the keys from the keychain that the daemon does not have. */
  const syncProviderKeys = useCallback(
    async (items: ProviderItem[]) => {
      const connectionId = currentRef.current?.id;
      const missing = items.filter((i) => i.key.source === "client" && !i.key.set);
      if (!connectionId || missing.length === 0) return;
      const keys: Record<string, string> = {};
      for (const item of missing) {
        try {
          const key = await loadProviderKey(connectionId, item.name);
          if (key) keys[item.name] = key;
        } catch {
          // The keychain is not available. The screen shows "Key not sent".
        }
      }
      if (Object.keys(keys).length === 0) return;
      try {
        conn.send({ type: "providers.keys", keys });
      } catch {
        // Not connected. The next connection sends the keys.
      }
    },
    [conn],
  );

  /** Asks for the sessions of all folders, for the sidebar. */
  const listRecent = useCallback(() => {
    try {
      conn.send({ type: "session.list", limit: SIDEBAR_SESSIONS });
    } catch {
      // Not connected. The next connection asks again.
    }
  }, [conn]);

  // Route daemon messages.
  useEffect(() => {
    const offMessage = conn.onMessage((msg) => {
      switch (msg.type) {
        case "session.ready": {
          // The steer messages of this session: the window can have missed "steer.taken" or "steer.returned".
          setQueues((q) => {
            const list = q[msg.session_id];
            if (!list?.length) return q;
            const ids = new Set(msg.history.map((m) => (m as { id?: string }).id).filter((id): id is string => !!id));
            const next = reconcileQueue(list, ids, msg.steering);
            return next === list ? q : { ...q, [msg.session_id]: next };
          });
          if (sessionRef.current?.id !== msg.session_id) {
            setIdeBlockFor(ideBlockNext.current ? msg.session_id : null);
            ideEmptyFor.current = ideBlockNext.current ? msg.session_id : null;
            ideBlockNext.current = false;
            setReviewId(null);
            setRules(null);
            setAgentFrame(null);
            setFrameLive(false);
            setMcpStatus(null);
            const saved = loadLayout(currentRef.current?.id ?? "local", msg.cwd, viewRef.current);
            const codeStart = codeStartNext.current && viewRef.current === "code";
            codeStartNext.current = false;
            setLayout(codeStart ? withoutEditor(saved) : saved);
            // When no provider gives the model of the session, the model by network replaces it, or the chat asks.
            requestModels();
            sendSafely({ type: "user_settings.get" });
            // The agent works in a tab of the Browser pane: only the desktop app on Windows with the local daemon.
            sendSafely({ type: "browser.pane", enabled: canHostAgentBrowser(currentRef.current?.kind) });
          } else if (sessionRef.current.cwd !== msg.cwd) {
            // The session moved to another folder: the daemon stopped its shells. The terminal
            // pane opens a new shell in the new folder.
            forgetSessionTerminals(msg.session_id);
          }
          setSession({
            id: msg.session_id,
            cwd: msg.cwd,
            model: msg.model,
            modelUnavailable: msg.model_unavailable ?? null,
            harness: msg.harness ?? null,
            title: msg.title,
            project: msg.project?.name ?? null,
            worktree: msg.worktree ?? null,
          });
          dispatch({
            type: "load",
            history: msg.history,
            warnings: msg.warnings,
            summary: msg.summary,
            context: { tokens: msg.context_tokens, length: msg.context_length, source: msg.context_source },
            running: msg.running,
            partial: msg.partial,
            requests: msg.requests,
            turnStartedAt: msg.turn_started_at,
            turnTokens: msg.turn_tokens,
            imageInput: msg.image_input ?? null,
          });
          // A return to a turn that waits for approval of a change: show the change for review.
          const change = msg.running ? msg.requests?.find((r) => r.diff) : undefined;
          if (change) {
            setReviewId(change.request_id);
            setLayout((l) => openPane(l, "diff"));
          }
          setInstructions(msg.instructions);
          setFilesToken(msg.files_token);
          setAutoVerify(msg.auto_verify);
          setPermissionMode(msg.permission_mode ?? "default");
          setScreen("chat");
          setBusy(false);
          setStartError(null);
          listRecent();
          if (firstPrompt.current) {
            const first = submissionMessage(firstPrompt.current);
            if (first.startsTurn) lastSubmission.current.set(msg.session_id, firstPrompt.current);
            firstPrompt.current = null;
            conn.send(first.message);
            dispatch({ type: "user", text: first.shown, startsTurn: first.startsTurn, messageId: first.messageId, images: first.images });
          }
          return;
        }
        case "session.title":
          setSession((s) => (s && s.id === msg.id ? { ...s, title: msg.title } : s));
          listRecent();
          return;
        case "daemon.update":
          setRemoteUpdate((u) => (u ? { ...u, phase: msg.state, message: msg.message } : u));
          return;
        case "prompt.fill":
          // A rewind or a fork: the message goes back to the prompt box, so the user can change it.
          setPromptInsert((p) => ({ text: msg.text, key: (p?.key ?? 0) + 1, replace: true }));
          filledText.current = msg.text;
          return;
        case "rewind.undone": {
          // The message is in the conversation again: the copy in the prompt box goes, if the user did not change it.
          const box = document.getElementById(MAIN_PROMPT_ID) as HTMLTextAreaElement | null;
          if (box && filledText.current !== null && box.value === filledText.current) {
            setPromptInsert((p) => ({ text: "", key: (p?.key ?? 0) + 1, replace: true }));
          }
          filledText.current = null;
          break; // The chat shows the line.
        }
        case "prompt.suggestion": {
          const id = sessionRef.current?.id;
          if (id) setSuggestion({ sessionId: id, text: msg.text });
          return;
        }
        case "session.updated":
          setSession((s) => (s && s.id === msg.id ? { ...s, title: msg.title } : s));
          listRecent();
          return;
        case "git.diff": {
          const { type: _type, ...diff } = msg;
          if (sessionRef.current && samePath(diff.cwd, sessionRef.current.cwd)) setGitDiff(diff);
          setDiffError(null);
          return;
        }
        case "git.changes": {
          const { type: _type, ...changes } = msg;
          if (sessionRef.current && samePath(changes.cwd, sessionRef.current.cwd)) setGitChanges(changes);
          // The pull request of the folder: the session row and the project show it at once.
          if (changes.pr !== undefined) {
            const item = { path: changes.cwd, branch: changes.branch, pr: changes.pr ?? null };
            setPrStatus((m) => new Map(m).set(pathKey(changes.cwd), item));
          }
          return;
        }
        case "git.pr_info":
          prInfoStore.put(msg.url, msg.pr);
          return;
        case "pr_status":
          setPrStatus((m) => {
            const next = new Map(m);
            for (const item of msg.items) next.set(pathKey(item.path), item);
            return next;
          });
          return;
        case "git.branches": {
          const { type: _type, ...info } = msg;
          setBranches(info);
          return;
        }
        case "session.archive_confirm":
          setArchiveAsk({ id: msg.id, branch: msg.branch });
          return;
        case "session.deleted":
          if (sessionRef.current?.id === msg.id) showStartRef.current();
          setNav((h) => forget(h, msg.id)); // Back and Forward do not open a deleted session.
          setUnreadSessions((u) => {
            if (!u.has(msg.id)) return u;
            const next = new Set(u);
            next.delete(msg.id);
            return next;
          });
          setQueues((q) => {
            const { [msg.id]: _gone, ...rest } = q;
            return rest;
          });
          // The daemon deleted the routine runs of the session: remove them from the open run list too.
          setRoutineRuns((r) =>
            r && r.items.some((run) => run.session_id === msg.id)
              ? { ...r, items: r.items.filter((run) => run.session_id !== msg.id) }
              : r,
          );
          listRecent();
          return;
        case "steer.taken":
          // The message is in the history now. The chat shows it at this place.
          setQueues((q) => Object.fromEntries(Object.entries(q).map(([sid, list]) => [sid, list.filter((i) => i.id !== msg.id)])));
          break;
        case "steer.returned":
          // The turn ended first. The messages go to the agent as prompts, as queued messages do.
          setQueues((q) =>
            Object.fromEntries(Object.entries(q).map(([sid, list]) => [sid, list.map((i) => (msg.ids.includes(i.id) ? { ...i, steering: false } : i))])),
          );
          return;
        case "sessions.running":
          setRunningSessions(msg.items);
          listRecent(); // A turn in the background changes the title and the age of its session.
          return;
        case "sessions.background":
          setBackgroundSessions(msg.items);
          listRecent(); // A new nested session, or the end of its turn.
          return;
        case "sessions":
          // A list with no folder is the sidebar list.
          if (!msg.cwd) {
            setRecent(msg.items);
            setRecentOf(currentRef.current?.id ?? null);
          }
          return;
        case "turn.end":
          listRecent(); // The first turn gives the session a title.
          break;
        case "fs.found":
          setFileMatches({ query: msg.query, items: msg.items });
          return;
        case "context.usage": {
          const { type: _type, ...usage } = msg;
          setContextUsage(usage);
          return;
        }
        case "projects":
          setProjects(msg.items);
          if (msg.saved) projectWait.current?.resolve(msg.saved);
          projectWait.current = null;
          return;
        case "routines":
          setRoutines(msg.items);
          if (msg.folder) setRoutinesFolder(msg.folder);
          if (msg.saved) {
            const id = msg.saved;
            setRoutineError(null);
            setRoutineSaved((s) => ({ id, key: (s?.key ?? 0) + 1 }));
          }
          return;
        case "routine.runs":
          setRoutineRuns({ routine_id: msg.routine_id, items: msg.items });
          return;
        case "servers.agent":
          setAgentServers(msg.items);
          return;
        case "sessions.archived":
          listRecent(); // The sidebar shows them only with the "Archived" or "All" status filter.
          return;
        case "routine.token":
          setRoutineToken(msg.token ? { id: msg.id, token: msg.token } : null);
          return;
        case "turn.done": {
          const { type: _type, ...done } = msg;
          void notifyTurnDone(done, {
            windowVisible: !document.hidden,
            windowFocused: document.hasFocus(),
            shownSessionId: shownIdRef.current,
          });
          return;
        }
        case "routine.run": {
          // A run started, waits for an answer, or ended. The list shows the new state at once.
          const { routine_id, run_id, session_id, status: runStatus, error } = msg;
          setRoutines((list) =>
            list?.map((r) =>
              r.id !== routine_id
                ? r
                : {
                    ...r,
                    running: runStatus === "running" || runStatus === "waiting",
                    queued: false,
                    last_run: {
                      ...(r.last_run?.id === run_id ? r.last_run : { fire_at: Date.now() / 1000, started_at: Date.now() / 1000, ended_at: null }),
                      id: run_id,
                      routine_id,
                      session_id,
                      status: runStatus,
                      error,
                    },
                  },
            ) ?? list,
          );
          listRecent(); // The new session of the run shows in the sidebar.
          if (session_id && runStatus !== "skipped") {
            void notifyRoutineRun(
              { name: msg.name, status: runStatus, session_id },
              { windowVisible: !document.hidden, shownSessionId: shownIdRef.current },
            );
          }
          if (session_id && (runStatus === "done" || runStatus === "failed" || runStatus === "waiting") && session_id !== shownIdRef.current) {
            setUnreadSessions((u) => new Set([...u, session_id]));
          }
          return;
        }
        case "settings":
          setAutoVerify(msg.auto_verify);
          if (msg.permission_mode) setPermissionMode(msg.permission_mode);
          return;
        case "providers":
          setProviders({ items: msg.items, path: msg.path });
          setProviderError(null);
          providerWait.current?.resolve();
          providerWait.current = null;
          void syncProviderKeys(msg.items);
          return;
        case "providers.test": {
          const { type: _type, ...result } = msg;
          setProviderTest({ ...result, busy: false });
          return;
        }
        case "models":
          setModels({
            items: msg.items.map((i) => `${i.provider}/${i.model}`),
            errors: msg.errors,
            default: msg.default ?? null,
            noImages: msg.items.filter((i) => i.image_input === false).map((i) => `${i.provider}/${i.model}`),
            providers: msg.providers,
          });
          return;
        case "preview.frame": {
          const { type: _type, ...frame } = msg;
          setAgentFrame((f) => ({ ...frame, key: (f?.key ?? 0) + 1 }));
          // The headless agent browser sends live frames while it works.
          setFrameLive(true);
          window.clearTimeout(frameLiveTimer.current);
          frameLiveTimer.current = window.setTimeout(() => setFrameLive(false), 35_000);
          return;
        }
        case "browser.call": {
          // The agent works in its tab of the Browser pane. The answer goes back to the daemon.
          const session = msg.session_id ?? sessionRef.current?.id;
          const answer = (body: { tab?: string; result?: Record<string, unknown>; error?: string }) => {
            try {
              conn.send({ type: "browser.result", call_id: msg.call_id, ...body });
            } catch {
              // Not connected: the daemon stops the call.
            }
          };
          if (!session) {
            answer({ error: "No session." });
            return;
          }
          void runAgentCall(session, msg.method, msg.params, msg.timeout_ms)
            .then(({ tab, result }) => answer({ tab, result }))
            .catch((e) => answer({ error: e instanceof Error ? e.message : String(e) }));
          return;
        }
        case "permissions":
          setRules({ path: msg.path, allow: msg.allow, deny: msg.deny });
          setRulesBusy(false);
          if (rulesSaving.current) setRulesSavedAt(Date.now());
          rulesSaving.current = false;
          return;
        case "skills":
          setCommands(msg.items);
          return;
        case "acp.state":
          // The models and the commands of the ACP harness of the session. The / menu asks again for the commands.
          setSession((s) => (s && (!msg.session_id || msg.session_id === s.id) ? { ...s, harness: msg.harness } : s));
          setCommands(null);
          return;
        case "fs.dirs": {
          const { type: _type, ...listing } = msg;
          setPicker((p) => (p ? { ...p, listing, error: null } : p));
          return;
        }
        case "skill": {
          const { type: _type, ...detail } = msg;
          setSkillDetail(detail);
          return;
        }
        case "plugins": {
          const { type: _type, ...status } = msg;
          setPlugins(status);
          setPluginBusy(false);
          setPluginError(null);
          // The plugins can add / commands and skills. The / menu needs the new list.
          if (status.loaded) conn.send({ type: "skills.list" });
          return;
        }
        case "mcp": {
          const { type: _type, ...status } = msg;
          setMcpStatus(status);
          setMcpBusy(status.items.some((i) => i.state === "starting"));
          return;
        }
        case "connectors":
          setConnectors(msg.items);
          setConnectorBusy(null);
          setDeviceCode((c) => (c && msg.items.some((i) => i.id === c.id && i.signing_in) ? c : null));
          return;
        case "connectors.device_code":
          // A device sign-in (Outlook): the row shows the code. The user opens the page and enters it.
          setDeviceCode({ id: msg.id, url: msg.url, code: msg.code });
          return;
        case "mcp.auth_url":
          // The daemon sends it only after the user clicked Authenticate. Open the sign-in page in the browser.
          if (/^https?:\/\//.test(msg.url)) void openExternal(msg.url);
          return;
        case "capabilities":
          setSkillItems(msg.skills);
          setMcpStatus(msg.mcp);
          setMcpBusy(msg.mcp.items.some((i) => i.state === "starting"));
          setCapsLive(msg.live);
          setCapsFolder(msg.cwd);
          return;
        case "mcp.init":
          // The file opens in the editor of the session. The Capabilities page goes back to the session.
          setPendingEdit((p) => ({ path: msg.path, key: (p?.key ?? 0) + 1 }));
          if (sessionRef.current) setScreen("chat");
          return;
        case "permission.request":
          // Show each change for approval in the diff review pane.
          if (msg.diff) {
            setReviewId(msg.request_id);
            setLayout((l) => openPane(l, "diff"));
          }
          break;
        case "error":
          if ((msg.ref === "session.new" || msg.ref === "session.resume") && !sessionRef.current) {
            firstPrompt.current = null; // The start screen keeps the text, so the user can try again.
            setStartError(msg.message);
            setBusy(false);
            return;
          }
          if (msg.ref === "permissions.set" || msg.ref === "permissions.get") {
            setRulesBusy(false);
            rulesSaving.current = false;
          }
          if (msg.ref === "skills.get") setSkillDetail(null);
          if (msg.ref === "routines.save") {
            setRoutineError(msg.message);
            return;
          }
          if (msg.ref === "mcp.restart" || msg.ref === "mcp") setMcpBusy(false);
          if (msg.ref === "capabilities.list") {
            // An older daemon has no capabilities.list. With a session, ask for the two lists one at a time.
            if (sessionRef.current) {
              capsFallback.current = true;
              setCapsLive(true);
              conn.send({ type: "mcp.list" });
              conn.send({ type: "command", name: "skills", args: "" });
            } else {
              setSkillItems([]);
              setMcpStatus({ items: [], problems: [msg.message], paths: { user: "", project: "" } });
            }
            return;
          }
          if (msg.ref?.startsWith("connectors.")) {
            setConnectorBusy(null);
            setDeviceCode(null);
            setConnectorError({ id: connectorWait.current ?? "", message: msg.message });
            return;
          }
          if (msg.ref?.startsWith("plugins.")) {
            setPluginBusy(false);
            setPluginError(msg.message);
            return;
          }
          if (msg.ref === "projects.save" || msg.ref === "projects.delete") {
            if (projectWait.current) {
              projectWait.current.reject(new Error(msg.message));
              projectWait.current = null;
              return;
            }
            setStartError(msg.message);
            return;
          }
          if (msg.ref?.startsWith("providers.") || msg.ref === "models.list") {
            if (msg.ref === "providers.test" && providerTestRef.current) {
              setProviderTest({ ref: providerTestRef.current, name: "", ok: false, ms: 0, error: msg.message, busy: false });
            } else if (providerWait.current) {
              providerWait.current.reject(new Error(msg.message));
              providerWait.current = null;
            } else if (msg.ref !== "models.list") {
              setProviderError(msg.message);
            }
            return;
          }
          if (msg.ref?.startsWith("memory.")) return; // Settings > Your Harness shows the error.
          if (msg.ref === "disk.usage") return; // The Storage dialog shows the error.
          if (msg.ref === "daemon.update") {
            setRemoteUpdate((u) => (u ? { ...u, phase: "error", message: msg.message } : u));
            return;
          }
          if (msg.ref === "fs.dirs") {
            setPicker((p) => (p ? { ...p, error: msg.message } : p));
            return;
          }
          if (msg.ref === "git.diff") setDiffError(msg.message); // The Changes pane shows it, with "Try again".
          // Only an error of the conversation goes into the chat. An error of another request must not
          // go into the middle of a reply: its view shows it, or a popup does (lib/errorRoute.ts).
          switch (errorRoute(msg.ref)) {
            case "chat":
              break;
            case "toast":
              showError(msg.message);
              return;
            case "quiet":
              console.warn(`${msg.ref}: ${msg.message}`);
              return;
            default:
              return;
          }
          break;
        case "command.result":
          if (msg.name === "model" && msg.model) {
            setSession((s) => (s ? { ...s, model: msg.model!, modelUnavailable: null } : s));
          }
          if (msg.action === "open_panel" && msg.panel === "servers") {
            // The dev servers are in the Browser pane: an empty tab lists them.
            setLayout((l) => openPane(l, "browser"));
            if (msg.text) break; // Show the text in the chat too.
            return;
          }
          if (msg.action === "preview" && msg.server) {
            setPreviewServer(msg.server);
            setLayout((l) => openPane(l, "browser"));
            return;
          }
          if (msg.action === "open_panel" && msg.panel === "providers") {
            showProviders();
            return;
          }
          if (msg.action === "open_panel" && msg.panel === "cookbook") {
            showCookbook();
            return;
          }
          if (msg.action === "open_panel" && msg.panel === "plugins") {
            showPlugins();
            return;
          }
          // /mcp and /skills open the Capabilities page.
          if (msg.action === "open_panel" && msg.panel === "mcp") {
            openCapabilitiesRef.current("mcp");
            return;
          }
          if (msg.action === "open_panel" && msg.panel === "skills") {
            if (!capsFallback.current) {
              openCapabilitiesRef.current("skills");
              return;
            }
            setSkillItems(msg.items ?? []);
            setSkillDetail(null);
            setScreen("capabilities");
            return;
          }
          break;
      }
      if (msg.type === "token") queueToken(msg.text);
      else dispatch({ type: "daemon", msg });
    });
    const offStatus = conn.onStatus((next) => {
      setStatus(next);
      if (next === "closed" && sessionRef.current) dispatch({ type: "disconnected" });
    });
    setStatus(conn.status);
    // Only remove the listeners. The connection lives as long as the app.
    return () => {
      offMessage();
      offStatus();
    };
  }, [conn, showProviders, showCookbook, showPlugins, syncProviderKeys, listRecent, queueToken, dispatch]);

  const afterConnect = useCallback(() => {
    // The daemon lists the providers. The reply makes the app send the keys from the keychain.
    conn.send({ type: "providers.list" });
    conn.send({ type: "projects.list" });
    setRoutines(null);
    conn.send({ type: "routines.list" }); // The red dot of the Routines nav item.
    conn.send({ type: "user_settings.get" }); // The effort level of the model menu on the start screen.
    // A reconnect to the same computer keeps the list until the new list arrives (audit M16). Another computer
    // starts empty: the sidebar shows skeleton rows.
    if (recentOfRef.current !== currentRef.current?.id) {
      setRecent([]);
      setRecentOf(null);
    }
    lastRunning.current = [];
    setRunningSessions([]);
    setBackgroundSessions([]);
    setUnreadSessions(new Set());
    startPicked.current = false;
    conn.send({ type: "session.list", limit: SIDEBAR_SESSIONS });
    // The Hugging Face token of the Cookbook, from the keychain.
    const connectionId = currentRef.current?.id;
    if (connectionId) {
      void loadHfToken(connectionId)
        .then((token) => {
          setHfTokenSaved(!!token);
          if (token) conn.send({ type: "hf.token", token });
        })
        .catch(() => setHfTokenSaved(false));
      // The API keys of the web search providers, from the keychain.
      for (const provider of WEB_KEY_PROVIDERS) {
        void loadWebKey(connectionId, provider)
          .then((key) => {
            setWebKeysSaved((s) => ({ ...s, [provider]: !!key }));
            if (key) conn.send({ type: "web.key", provider, key });
          })
          .catch(() => setWebKeysSaved((s) => ({ ...s, [provider]: false })));
      }
    }
    const current = sessionRef.current;
    if (current) {
      conn.send({ type: "session.resume", session_id: current.id });
    } else {
      setScreen("start");
    }
  }, [conn]);

  // Tokens in the keychain: the Connections screen shows which connections have one.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const found = new Set<string>();
      for (const c of connections) {
        if (c.kind === "local") continue;
        try {
          if (await loadToken(c.id)) found.add(c.id);
        } catch {
          // The keychain is not available. The connection shows "No saved token".
        }
      }
      if (alive) setTokenIds(found);
    })();
    return () => {
      alive = false;
    };
  }, [connections]);

  /** Closes the current connection and forgets its session. */
  const leave = useCallback(async () => {
    const previous = currentRef.current;
    wantConnection.current = false; // The user closed it: no automatic reconnect.
    conn.close();
    setSession(null);
    dispatch({ type: "clear" });
    setReviewId(null);
    setCommands(null);
    setHello(null);
    setDaemonVersion(null);
    setRemoteUpdate(null); // Another daemon: the update of the old one does not show.
    setCurrent(null);
    if (previous) await closeTunnel(previous).catch(() => undefined);
  }, [conn]);

  const connectTo = useCallback(
    async (c: Connection) => {
      setConnectingId(c.id);
      setConnError(null);
      setBusy(true);
      wantConnection.current = false; // No automatic reconnect while the user connects.
      clearRetry();
      try {
        if (currentRef.current && currentRef.current.id !== c.id) await leave();
        setCurrent(c);
        const target = await resolveTarget(c);
        const { host, version, updatable } = await conn.connect(target.host, target.port, target.token);
        targetRef.current = target;
        setDaemonHttp(`http://${target.host}:${target.port}`);
        setVisualDaemon(target.host, target.port);
        setHello(host);
        setDaemonVersion(version);
        setDaemonUpdatable(updatable === true);
        updateConnected(c.id, version);
        setLastConnectionId(c.id);
        wantConnection.current = true;
        afterConnect();
      } catch (e) {
        setConnError({ id: c.id, message: errorText(e) });
        if (!sessionRef.current) setScreen("connections");
      } finally {
        setConnectingId(null);
        setBusy(false);
      }
    },
    [conn, afterConnect, leave],
  );

  /** After a connection: an update that restarted the daemon is done when the version is correct. */
  const updateConnected = (connectionId: string, version: string) =>
    setRemoteUpdate((u) => {
      if (!u || u.connectionId !== connectionId || (u.phase !== "restarting" && u.phase !== "installing")) return u;
      return version === u.version
        ? { ...u, phase: "done" }
        : { ...u, phase: "error", message: `The daemon restarted, but it is version ${version}, not ${u.version}.` };
    });

  /** "Update daemon": send the wheel of the app version to the remote daemon. */
  const startDaemonUpdate = async () => {
    const c = currentRef.current;
    if (!c || !appVersion) return;
    const host = hello?.hostname ?? c.name;
    setRemoteUpdate({ connectionId: c.id, host, version: appVersion, phase: "sending" });
    try {
      const wheel = await daemonWheel();
      conn.send({ type: "daemon.update", filename: wheel.filename, data: wheel.data });
    } catch (e) {
      setRemoteUpdate({ connectionId: c.id, host, version: appVersion, phase: "error", message: errorText(e) });
    }
  };

  // "Daemon updated" closes by itself after a short time.
  useEffect(() => {
    if (remoteUpdate?.phase !== "done") return;
    const timer = window.setTimeout(() => setRemoteUpdate(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [remoteUpdate?.phase]);

  // Automatic reconnect: after a sleep of the computer, or when the daemon or the network went away
  // for a short time. It runs only after a connection that the user did not close.
  const wantConnection = useRef(false);
  const retry = useRef<{ timer: number | null; attempt: number; inFlight: boolean }>({ timer: null, attempt: 0, inFlight: false });
  const [reconnecting, setReconnecting] = useState(false);
  const clearRetry = () => {
    if (retry.current.timer !== null) window.clearTimeout(retry.current.timer);
    retry.current.timer = null;
    retry.current.attempt = 0;
    setReconnecting(false);
  };
  const autoReconnectRef = useRef<() => void>(() => {});
  autoReconnectRef.current = () => {
    const c = currentRef.current;
    const r = retry.current;
    if (!c || !wantConnection.current || r.inFlight || conn.status !== "closed") return;
    if (r.timer !== null) window.clearTimeout(r.timer);
    r.timer = null;
    r.inFlight = true;
    setReconnecting(true);
    void (async () => {
      try {
        const target = await resolveTarget(c);
        const { host, version, updatable } = await conn.connect(target.host, target.port, target.token);
        targetRef.current = target;
        setDaemonHttp(`http://${target.host}:${target.port}`);
        setVisualDaemon(target.host, target.port);
        setHello(host);
        setDaemonVersion(version);
        setDaemonUpdatable(updatable === true);
        updateConnected(c.id, version);
        r.attempt = 0;
        setReconnecting(false);
        afterConnect();
      } catch (e) {
        r.inFlight = false; // Before scheduleReconnect, which waits for no try in flight.
        if (!wantConnection.current) return;
        if (/refused the token|no token/i.test(errorText(e))) {
          // The token is wrong: a retry cannot help. The Computers screen shows the error.
          wantConnection.current = false;
          setReconnecting(false);
          setConnError({ id: c.id, message: errorText(e) });
          return;
        }
        r.attempt++;
        scheduleReconnect();
      } finally {
        r.inFlight = false;
      }
    })();
  };
  /** The next try: after 1, 2, 4, 8, 16, then each 30 seconds. */
  const scheduleReconnect = () => {
    const r = retry.current;
    if (!wantConnection.current || r.inFlight || r.timer !== null) return;
    setReconnecting(true);
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** r.attempt);
    r.timer = window.setTimeout(() => {
      r.timer = null;
      autoReconnectRef.current();
    }, delay);
  };
  const scheduleRef = useRef(scheduleReconnect);
  scheduleRef.current = scheduleReconnect;

  // The socket closed, but the user did not close it: try again.
  useEffect(
    () =>
      conn.onStatus((next) => {
        if (next === "closed" && wantConnection.current && !retry.current.inFlight) scheduleRef.current();
      }),
    [conn],
  );

  // A wake from sleep: the timer stops while the computer sleeps, so a long gap between two ticks
  // shows a sleep. Then, and when the window shows again or the network comes back, check the
  // connection. A dead socket closes, and the reconnect starts at once.
  useEffect(() => {
    const check = async () => {
      if (!wantConnection.current) return;
      if (conn.status === "connecting" || retry.current.inFlight) return;
      if (conn.status === "open" && (await conn.checkAlive())) return;
      if (retry.current.timer !== null) window.clearTimeout(retry.current.timer);
      retry.current.timer = null;
      retry.current.attempt = 0;
      autoReconnectRef.current();
    };
    let last = Date.now();
    const tick = window.setInterval(() => {
      const now = Date.now();
      const slept = now - last > WAKE_GAP_MS;
      last = now;
      if (slept) void check();
    }, WAKE_TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onOnline = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [conn]);

  // Connect one time to the last connection. React StrictMode runs effects two times in development.
  const autoConnected = useRef(false);
  useEffect(() => {
    if (autoConnected.current) return;
    autoConnected.current = true;
    const last = connections.find((c) => c.id === lastConnectionId()) ?? LOCAL;
    if (last.kind === "local" && !isTauri()) setScreen("connections");
    else void connectTo(last);
  }, [connectTo, connections]);

  const reconnect = () => {
    if (currentRef.current) void connectTo(currentRef.current);
  };

  const saveConnection = async (c: Connection, token: string) => {
    if (token.trim()) await saveToken(c.id, token.trim());
    const next = connections.some((x) => x.id === c.id) ? connections.map((x) => (x.id === c.id ? c : x)) : [...connections, c];
    saveConnections(next);
    setConnections(next);
    if (currentRef.current?.id === c.id) setCurrent(c);
  };

  const deleteConnection = async (c: Connection) => {
    if (currentRef.current?.id === c.id) await leave();
    await deleteToken(c.id).catch(() => undefined);
    await closeTunnel(c).catch(() => undefined);
    const next = connections.filter((x) => x.id !== c.id);
    saveConnections(next);
    setConnections(next);
  };

  /** Connects with a second socket to check the address and the token, then closes it. */
  const testConnection = async (c: Connection, token: string): Promise<HostInfo> => {
    const target = await resolveTarget(c, false, token.trim() || undefined);
    const probe = new DaemonConnection();
    try {
      return (await probe.connect(target.host, target.port, target.token)).host;
    } finally {
      probe.close();
      if (currentRef.current?.id !== c.id) await closeTunnel(c).catch(() => undefined);
    }
  };

  const openConnections = () => openSettings("computers");

  /** The native dialog for this computer. The daemon folder picker for a remote daemon. */
  /** Ctrl+U in a prompt box: pick files on this computer, and get their references for the prompt. */
  const addFiles = async (cwd: string): Promise<string | null> => {
    if (currentRef.current?.kind !== "local" || !isTauri()) {
      dispatch({ type: "notice", level: "info", text: "Type @ in the prompt box to add a file of the project." });
      return null;
    }
    try {
      const files = await pickFiles(cwd || undefined);
      return files.length ? filesPromptText(files, cwd) : null;
    } catch (e) {
      dispatch({ type: "notice", level: "error", text: errorText(e) });
      return null;
    }
  };

  const browseFolder = (currentPath: string): Promise<string | null> => {
    if (currentRef.current?.kind === "local" && isTauri()) return pickFolder();
    return new Promise((resolve) => setPicker({ resolve, initial: currentPath, listing: null, error: null }));
  };

  const closePicker = (path: string | null) => {
    picker?.resolve(path);
    setPicker(null);
  };

  const navigatePicker = (path: string | undefined, hidden: boolean) => {
    setPicker((p) => (p ? { ...p, listing: null, error: null } : p));
    try {
      conn.send({ type: "fs.dirs", path, hidden });
    } catch (e) {
      setPicker((p) => (p ? { ...p, error: errorText(e) } : p));
    }
  };

  /** Starts a session. The first task from the start screen goes to the agent when the session is ready. */
  const startSession = (cwd: string, model: string, prompt: Submission | null, mode: PermissionMode,
    worktree: { base: string | null } | null) => {
    setBusy(true);
    setStartError(null);
    setFolderChosen(true);
    firstPrompt.current = prompt;
    if (!ideStarting.current) switchViewRef.current("code"); // A new session starts in the Code view.
    ideBlockNext.current = ideStarting.current;
    codeStartNext.current = !ideStarting.current;
    ideStarting.current = false;
    railAuto.current = false;
    setRail(true); // Each new session opens with the session rail. The saved preference does not change.
    sendStart({ type: "session.new", cwd, model, permission_mode: mode, ...(worktree ? { worktree } : {}) });
  };

  const resumeSession = (id: string) => {
    setFolderChosen(true);
    firstPrompt.current = null;
    setBusy(true);
    setStartError(null);
    codeStartNext.current = false; // An old session opens with its saved layout.
    sendStart({ type: "session.resume", session_id: id });
  };

  /** Sends a session start. With a closed connection the start screen unlocks and shows why (audit U5).
   *  The prompt box keeps its text, so the user can try again after a reconnect. */
  const startSendFailed = useRef(false);
  const sendStart = (msg: Parameters<DaemonConnection["send"]>[0]) => {
    try {
      conn.send(msg);
    } catch (e) {
      startSendFailed.current = true;
      firstPrompt.current = null;
      setBusy(false);
      setStartError(errorText(e));
      if (screen !== "start") showError(errorText(e));
    }
  };

  // The connection closed: no reply can come, so a start in progress stops. When it opens again, the
  // error of a start with no connection is old.
  useEffect(() => {
    if (status === "closed" && connectingId === null) setBusy(false);
    if (status === "open" && startSendFailed.current) {
      startSendFailed.current = false;
      setStartError(null);
    }
  }, [status, connectingId]);

  // A click on a Windows notification: the desktop app shows the window, and the app opens the session.
  const openFromNotice = useRef<(id: string) => void>(() => undefined);
  openFromNotice.current = (id: string) => {
    if (status !== "open") return;
    if (session?.id === id) setScreen("chat");
    else resumeSession(id);
  };
  useEffect(() => {
    let stop: (() => void) | null = null;
    let live = true;
    void onNotificationOpen((id) => openFromNotice.current(id)).then((s) => (live ? (stop = s) : s()));
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  // The session that the user sees now. Other sessions get a blue dot when their turn ends.
  const shownId = screen === "chat" ? (session?.id ?? null) : null;
  shownIdRef.current = shownId;
  useEffect(() => {
    const now = new Set(allRunning.map((r) => r.session_id));
    const ended = lastRunning.current.map((r) => r.session_id).filter((id) => !now.has(id) && id !== shownId && id !== split);
    lastRunning.current = allRunning;
    if (ended.length > 0) setUnreadSessions((u) => new Set([...u, ...ended]));
  }, [allRunning, shownId, split]);
  useEffect(() => {
    const seen = [shownId, split].filter((id): id is string => id !== null);
    if (seen.length === 0) return;
    setUnreadSessions((u) => {
      if (!seen.some((id) => u.has(id))) return u;
      const next = new Set(u);
      seen.forEach((id) => next.delete(id));
      return next;
    });
  }, [shownId, split]);
  // The split pane cannot show the session of the main view, for example after Back or a search.
  // A change of the daemon connection closes the split pane too.
  useEffect(() => {
    if (split !== null && session?.id === split) setSplit(null);
  }, [session?.id, split]);
  useEffect(() => setSplit(null), [current?.id]);

  /** Shows the start screen, with the folder block in its center. */
  const newSession = () => {
    switchViewRef.current("code"); // A new session starts in the Code view.
    showStart();
  };
  /** Leaves the session and shows the start screen in the current view. */
  const showStart = () => {
    setFolderChosen(false);
    conn.leaveSession(); // A running turn of the session continues in the background.
    setSession(null);
    dispatch({ type: "clear" });
    setScreen("start");
    if (conn.status === "open") conn.send({ type: "projects.list" });
  };
  showStartRef.current = newSession; // The message handler shows the start screen after a delete.

  // At the start, the start screen selects the project of the last prompt: the folder of the newest session.
  useEffect(() => {
    if (startPicked.current || screen !== "start" || session || !projects || recent.length === 0) return;
    startPicked.current = true;
    const last = projects.find((p) => pathKey(p.path) === pathKey(recent[0].cwd));
    if (last) setStartProject((p) => ({ id: last.id, key: (p?.key ?? 0) + 1 }));
  }, [recent, projects, screen, session]);

  /** Asks the daemon for the models of the connections that are on. The last list stays until the reply. */
  function requestModels() {
    sendSafely({ type: "models.list" });
  }

  /** Switch the model of the session. The model label under the prompt box shows it: the chat shows nothing. */
  const switchModel = (spec: string) => {
    sendSafely({ type: "command", name: "model", args: spec });
  };

  /** The saved project of a session: the project with the session folder, else the project with its name. */
  const sessionProject = (s: { cwd: string; project?: string | null }) =>
    projects?.find((p) => samePath(p.path, s.cwd)) ?? projects?.find((p) => p.name === s.project);

  /** The user chose a model for the session: the start screen shows it the next time (the model used last). */
  const chooseModel = (spec: string) => {
    switchModel(spec);
    const s = sessionRef.current;
    const project = s ? sessionProject(s) : undefined;
    rememberModel(currentRef.current?.id ?? "local", project?.id, spec);
  };

  // No provider gives the model of the session. With "Preferred providers" on, the model by
  // network replaces it with no question. Else the chat asks the user (ModelUnavailable).
  // An ACP session has no model of the providers: its harness chooses the model.
  const modelGone = !!session && !session.harness && isModelUnavailable(session.model, models, session.modelUnavailable);
  const autoModel = modelGone ? networkModel(status === "open" ? userSettings : null, models) : null;
  const autoSwitched = useRef<Set<string>>(new Set()); // "session id model": one try for each.
  useEffect(() => {
    if (!session || !autoModel || autoModel === session.model || chat.running || status !== "open") return;
    const key = `${session.id} ${session.model}`;
    if (autoSwitched.current.has(key)) return;
    autoSwitched.current.add(key);
    switchModel(autoModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- switchModel uses only the connection.
  }, [session?.id, session?.model, autoModel, chat.running, status]);

  /** Opens the start screen with a project selected. A folder that is not a saved project becomes one. */
  const newSessionIn = async (projectId: string | null, name: string, path: string) => {
    try {
      const id = projectId ?? (await saveProject({ name, path }));
      setStartProject((p) => ({ id, key: (p?.key ?? 0) + 1 }));
      newSession(); // The block shows, with the check mark on this project.
    } catch (e) {
      setStartError(errorText(e));
      newSession();
    }
  };

  /** Adds or changes a project. Resolves with its id when the daemon saved it. */
  const saveProject = (project: { id?: string; name: string; path: string; create?: boolean }) =>
    new Promise<string>((resolve, reject) => {
      projectWait.current?.reject(new Error("Replaced by a newer save."));
      projectWait.current = { resolve, reject };
      try {
        conn.send({ type: "projects.save", ...project });
      } catch (e) {
        projectWait.current = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

  const deleteProject = (id: string) => {
    try {
      conn.send({ type: "projects.delete", id });
    } catch (e) {
      setStartError(errorText(e));
    }
  };

  /** Waits for the daemon reply to a provider change: a "providers" message, or an error. */
  const waitProviders = () =>
    new Promise<void>((resolve, reject) => {
      providerWait.current?.resolve();
      const timer = window.setTimeout(() => {
        providerWait.current = null;
        reject(new Error("The daemon did not answer."));
      }, PROVIDER_REPLY_TIMEOUT);
      providerWait.current = {
        resolve: () => (window.clearTimeout(timer), resolve()),
        reject: (e) => (window.clearTimeout(timer), reject(e)),
      };
    });

  const saveProvider = async ({ fields, key, apiKeyEnv, newKey }: ProviderSave) => {
    const connectionId = currentRef.current?.id ?? "local";
    const previous = fields.previous_name;
    const done = waitProviders();
    conn.send({ type: "providers.save", ...fields, key, api_key_env: apiKeyEnv });
    await done;
    // The daemon saved the provider. Now change the keychain.
    if (previous && previous !== fields.name) {
      await (newKey ? deleteProviderKey(connectionId, previous) : renameProviderKey(connectionId, previous, fields.name)).catch(() => undefined);
    }
    if (newKey) {
      await saveProviderKey(connectionId, fields.name, newKey);
      conn.send({ type: "providers.keys", keys: { [fields.name]: newKey } });
    } else if (key === "env" || key === "none") {
      await deleteProviderKey(connectionId, fields.name).catch(() => undefined);
    }
  };

  const deleteProvider = async (name: string) => {
    const done = waitProviders();
    conn.send({ type: "providers.delete", name });
    await done;
    await deleteProviderKey(currentRef.current?.id ?? "local", name).catch(() => undefined);
  };

  const testProvider = (fields: ProviderFields, newKey: string | null, ref: string) => {
    providerTestRef.current = ref;
    setProviderTest({ ref, busy: true });
    if (!sendSafely({ type: "providers.test", ...fields, ref, ...(newKey ? { api_key: newKey } : {}) })) {
      setProviderTest({ ref, name: fields.name, ok: false, ms: 0, error: "The daemon is not connected.", busy: false });
    }
  };

  /** A model from a connection test: the model of the session, or the model of the start screen. */
  const selectProviderModel = (spec: string) => {
    setSettingsPage(null);
    if (sessionRef.current) {
      chooseModel(spec);
      setScreen("chat");
    } else {
      const scope = currentRef.current?.id ?? "local";
      rememberModel(scope, loadPref(`project.${scope}`, ""), spec); // The project of the start screen.
      setScreen("start");
    }
  };

  const cookbook = useCookbook(conn, settingsPage === "models" && status === "open");

  /** Saves or removes the Hugging Face token: the keychain of this computer, and the memory of the daemon. */
  const saveHfTokenValue = async (token: string | null) => {
    const connectionId = currentRef.current?.id ?? "local";
    try {
      if (token) await saveHfToken(connectionId, token);
      else await deleteHfToken(connectionId);
    } catch (e) {
      dispatch({ type: "notice", level: "error", text: `The keychain failed: ${errorText(e)}` });
    }
    setHfTokenSaved(!!token);
    try {
      conn.send({ type: "hf.token", token });
    } catch {
      // The next connection sends the token.
    }
  };

  /** Saves or removes a web search API key: the keychain of this computer, and the memory of the daemon. */
  const saveWebKeyValue = async (provider: WebKeyProvider, key: string | null) => {
    const connectionId = currentRef.current?.id ?? "local";
    try {
      if (key) await saveWebKey(connectionId, provider, key);
      else await deleteWebKey(connectionId, provider);
    } catch (e) {
      dispatch({ type: "notice", level: "error", text: `The keychain failed: ${errorText(e)}` });
    }
    setWebKeysSaved((s) => ({ ...s, [provider]: !!key }));
    try {
      conn.send({ type: "web.key", provider, key });
    } catch {
      // The next connection sends the key.
    }
  };

  // The start screen shows the models of the connections that are on.
  useEffect(() => {
    if (screen !== "start" || status !== "open") return;
    requestModels();
  }, [screen, status, conn]);

  const submit = (s: Submission): boolean => {
    setSuggestion(null);
    try {
      const { message, shown, startsTurn, messageId, images } = submissionMessage(s);
      conn.send(message);
      if (startsTurn && session) lastSubmission.current.set(session.id, s);
      dispatch({ type: "user", text: shown, startsTurn, messageId, images });
      return true;
    } catch (e) {
      dispatch({ type: "notice", level: "error", text: errorText(e) });
      return false;
    }
  };

  /** "Try again" on the error card of a failed turn: the last prompt goes to the agent again. */
  const retryLast = () => {
    const last = session && lastSubmission.current.get(session.id);
    if (last && !chat.running) submit(last);
  };

  /** A message during a turn waits in the queue. Else it goes to the agent now. */
  const submitOrQueue = (s: Submission): boolean => {
    setIdeBlockFor(null); // A prompt closes the folder block in the editor.
    ideEmptyFor.current = null; // The session started: it stays in the Code view.
    if (!session || !chat.running) return submit(s);
    const label = s.kind === "prompt" ? (s.display ?? s.text) : `/${s.name}${s.args ? ` ${s.args}` : ""}`;
    const item: QueuedItem = { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, submission: s, label };
    const mode = busySend(); // Settings > General.
    // Steer: the agent reads the message at its next step. The item waits in the queue until then.
    // A message with images waits in the queue: a steer message has only text.
    if (mode === "steer" && s.kind === "prompt" && !s.images?.length) {
      item.steering = sendSafely({ type: "steer", id: item.id, text: s.text, ...(s.display ? { display: s.display } : {}) });
    }
    setQueues((q) => ({ ...q, [session.id]: [...(q[session.id] ?? []), item] }));
    if (mode === "interrupt") sendNow(item.id);
    return true;
  };

  const queue = (session && queues[session.id]) || NO_QUEUE;

  // When the turn of the shown session ends, the next queued message goes to the agent.
  useEffect(() => {
    if (!session || chat.running || status !== "open" || screen !== "chat") return;
    const next = queues[session.id]?.find((i) => !i.steering); // The daemon has the steer messages.
    if (!next) return;
    setQueues((q) => ({ ...q, [session.id]: (q[session.id] ?? []).filter((i) => i.id !== next.id) }));
    submit(next.submission);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit uses only the connection and dispatch.
  }, [chat.running, queues, session?.id, status, screen]);

  /** "Send now": the message goes first, and the turn stops. The message then goes to the agent. */
  const sendNow = (id: string) => {
    if (!session) return;
    setQueues((q) => {
      const list = q[session.id] ?? [];
      const item = list.find((i) => i.id === id);
      return item ? { ...q, [session.id]: [item, ...list.filter((i) => i.id !== id)] } : q;
    });
    dispatch({ type: "sendNow" }); // The task list stays after this stop.
    interrupt();
  };

  const removeQueued = (id: string) => {
    if (!session) return;
    setQueues((q) => ({ ...q, [session.id]: (q[session.id] ?? []).filter((i) => i.id !== id) }));
  };

  // The questions before the first start of a server command. The empty browser tab shows them too.
  const serverApprovals = useMemo(() => pendingServerApprovals(chat.items), [chat.items]);
  // The pull requests that the agent made in this session: the PR list of the Changes section.
  const sessionPrs = useMemo(() => sessionPrUrls(chat.items), [chat.items]);

  const decide = useCallback(
    (requestId: string, decision: Decision) => {
      try {
        conn.send({ type: "permission.reply", request_id: requestId, decision });
        dispatch({ type: "decide", requestId, decision });
      } catch (e) {
        dispatch({ type: "notice", level: "error", text: errorText(e) });
      }
    },
    [conn],
  );

  /** The answers of a question card. null: the user skipped. */
  const answerQuestion = useCallback(
    (requestId: string, answers: Record<string, string> | null, notes?: Record<string, string>) => {
      try {
        conn.send({ type: "question.reply", request_id: requestId, answers, notes });
        dispatch({ type: "answer", requestId, answers, notes });
      } catch (e) {
        dispatch({ type: "notice", level: "error", text: errorText(e) });
      }
    },
    [conn],
  );

  /** The decision on a plan card. An accepted plan also changes the mode: the daemon replies with "settings". */
  const decidePlan = useCallback(
    (requestId: string, decision: PlanDecision, mode?: PermissionMode, feedback?: string) => {
      try {
        conn.send({ type: "plan.reply", request_id: requestId, decision, mode, feedback });
        dispatch({ type: "plan", requestId, decision, mode });
      } catch (e) {
        dispatch({ type: "notice", level: "error", text: errorText(e) });
      }
    },
    [conn],
  );

  const interrupt = () => {
    try {
      conn.send({ type: "interrupt" });
    } catch {
      // The connection is closed. The disconnect notice already shows.
    }
  };

  // Esc stops the agent from anywhere in the window, not only in the prompt box (the user asked for
  // this). An open menu or dialog, a text field, the terminal, the editor, and the split pane keep
  // their own Esc. The prompt box handles its Esc itself (defaultPrevented).
  const interruptRef = useRef(interrupt);
  interruptRef.current = interrupt;
  useEffect(() => {
    if (!chat.running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (overlayOpen()) return; // The menu or the dialog closes first.
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], .xterm, .monaco-editor, [role="dialog"], [role="menu"], [role="listbox"], .split-pane')) return;
      e.preventDefault();
      interruptRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chat.running]);

  // Esc two times opens the Rewind dialog, as in Claude. Not during a turn: then Esc stops the agent.
  // The prompt box counts, but not another text field, the terminal, the editor, or the split pane.
  const lastEsc = useRef(0);
  const runningRef = useRef(chat.running);
  runningRef.current = chat.running;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const target = e.target instanceof Element ? e.target : null;
      const field = target?.closest('input, textarea, select, [contenteditable="true"], .xterm, .monaco-editor, [role="dialog"], [role="menu"], [role="listbox"], .split-pane');
      if (e.defaultPrevented || runningRef.current || !sessionRef.current || overlayOpen() || (field && !field.closest(".prompt-anchor"))) {
        lastEsc.current = 0;
        return;
      }
      const now = performance.now();
      if (lastEsc.current && now - lastEsc.current < DOUBLE_ESC_MS) {
        lastEsc.current = 0;
        e.preventDefault();
        setRewindOpen(true);
      } else {
        lastEsc.current = now;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openRules = () => {
    setLayout((l) => openPane(l, "rules"));
    setRules(null);
    setRulesBusy(true);
    try {
      conn.send({ type: "permissions.get" });
    } catch (e) {
      setRulesBusy(false);
      dispatch({ type: "notice", level: "error", text: errorText(e) });
    }
  };

  const saveRules = useCallback(
    (allow: string[], deny: string[]) => {
      setRulesBusy(true);
      rulesSaving.current = true;
      try {
        conn.send({ type: "permissions.set", allow, deny });
      } catch (e) {
        setRulesBusy(false);
        rulesSaving.current = false;
        dispatch({ type: "notice", level: "error", text: errorText(e) });
      }
    },
    [conn],
  );

  const toggleReview = useCallback((id: string) => {
    setReviewId(id);
    setLayout((l) => openPane(l, "diff"));
  }, []);

  const hidePane = useCallback((pane: PaneId) => setLayout((l) => closePane(l, pane)), []);

  /** Shows or hides a pane of a shortcut. It opens on the right of the chat, as the other panes do. */
  const toggleShortcutPane = useCallback((pane: PaneId) => {
    setLayout((l) => togglePane(l, pane));
  }, []);

  // A pane to show now, also on a narrow window where only one tab shows (Workspace "reveal").
  const [reveal, setReveal] = useState<{ pane: PaneId; key: number } | null>(null);
  const showPane = useCallback((pane: PaneId) => {
    setLayout((l) => openPane(l, pane));
    setReveal((r) => ({ pane, key: (r?.key ?? 0) + 1 }));
  }, []);

  // The pane shortcuts. The capture phase runs before the editor and the terminal get the keys.
  useEffect(() => {
    if (screen !== "chat") return;
    const onKey = (e: KeyboardEvent) => {
      const pane = shortcutPane(e);
      if (!pane) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) toggleShortcutPane(pane);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [screen, toggleShortcutPane]);

  // The side chat (Ctrl+;): it floats over the chat, or it is a window of the workspace.
  const side = useSideChat(conn, session?.id ?? null);
  // Clear asks nothing: the popup has "Undo" (rule R7a).
  const clearSide = () => {
    const undo = side.clear();
    if (undo) showUndo("Cleared the side chat.", undo);
  };
  // The background tasks of the session, and the "Keep computer awake" switch (the ⋮ menu).
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [keepAwake, setKeepAwake] = useState(false);
  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "tasks") setTasks(msg.items);
        else if (msg.type === "task") {
          const { type: _type, ...detail } = msg;
          setTaskDetail(detail);
        } else if (msg.type === "keep_awake") setKeepAwake(msg.on);
        else if (msg.type === "session.ready") {
          setKeepAwake(!!msg.keep_awake);
          setTasks(null);
          setTaskDetail(null);
          try {
            conn.send({ type: "tasks.list" });
          } catch {
            // The next session.ready asks again.
          }
        }
      }),
    [conn],
  );
  const runningTasks = tasks?.filter((t) => t.status === "running").length ?? 0;
  // The session rail at the right of a session (the title bar button shows or hides it).
  const [rail, setRail] = useState(railShown);
  // True: a pane closed the rail. It opens again when all the panes are closed.
  const railAuto = useRef(false);
  const showRail = useCallback((on: boolean) => {
    railAuto.current = false; // The user decides now.
    setRail(on);
    setRailShown(on);
  }, []);
  const closeRail = useCallback(() => showRail(false), [showRail]);
  useEffect(() => {
    if (!session || status !== "open" || !rail) return;
    sendSafely({ type: "git.changes", cwd: session.cwd });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- A new session, the start and end of a turn, or the rail opens.
  }, [session?.id, session?.cwd, chat.running, status, rail]);
  // The agent tab of the Browser pane for this session (desktop app), or the headless agent browser.
  const sessionId = session?.id ?? null;
  const [agentTab, setAgentTab] = useState(() => agentBrowserOf(sessionId));
  useEffect(() => {
    const read = () => setAgentTab(agentBrowserOf(sessionId));
    read();
    return onAgentBrowser(read);
  }, [sessionId]);
  const agentWorking = agentTab ? agentTab.live : frameLive;
  // When the agent starts to work in the browser, the rail opens with a small live view of the page,
  // as in the Claude app. With the Browser pane open, the pane shows the page.
  useEffect(() => {
    if (!agentWorking || view !== "code" || findGroupOf(layout, "browser") !== null) return;
    setRail(true);
  }, [agentWorking]);
  const showAgentBrowser = useCallback(() => {
    if (sessionId && agentTab) showAgentTab(sessionId);
    else setShowAgentView((n) => n + 1);
    setLayout((l) => openPane(l, "browser"));
  }, [sessionId, agentTab]);
  // In the Code view, the rail closes when a pane opens (the browser, the files, the changes, and the
  // others), so the pane gets the room. When the last pane closes, the rail opens again. The saved
  // preference does not change, and the title bar button still opens the rail. A change of view only
  // records the panes.
  const roomPanes = useRef<{ view: ViewMode; open: string[] } | null>(null);
  useEffect(() => {
    const open = ROOM_PANES.filter((p) => findGroupOf(layout, p) !== null);
    const before = roomPanes.current;
    roomPanes.current = { view, open };
    if (view !== "code" || before?.view !== view) return;
    const next = railAfterPanes({ open: rail, auto: railAuto.current }, before.open, open);
    railAuto.current = next.auto;
    if (next.open !== rail) setRail(next.open);
  }, [layout, view]);
  // The next launch opens in this view.
  useEffect(() => setViewMode(view), [view]);
  // The start screen in the IDE view (at launch, or after a change of computer): start an empty
  // session in the selected project, as a switch to the IDE view does.
  useEffect(() => {
    if (screen !== "start" || viewRef.current !== "ide") return;
    ideStarting.current = true;
    setIdeStart((n) => n + 1);
  }, [screen, current?.id]);
  /** Change the view. Each view loads its own layout. The IDE view hides the sessions sidebar, and the Code view shows it again. */
  const switchView = (mode: ViewMode) => {
    if (mode === view) return;
    setView(mode);
    // On the start screen, the IDE view starts an empty session in the selected project, so the
    // file tree, the editor, and the terminal show at once.
    if (mode === "ide" && screen === "start") {
      ideStarting.current = true;
      setIdeStart((n) => n + 1);
    } else if (mode === "code") {
      ideStarting.current = false;
      // The IDE view started this empty session, and the user sent no prompt: go back to the start
      // screen, and remove the session.
      if (session && ideEmptyFor.current === session.id && !chat.running) {
        const id = session.id;
        ideEmptyFor.current = null;
        showStart();
        sendSafely({ type: "session.delete", session_id: id });
      }
    }
    if (session) {
      const next = loadLayout(currentRef.current?.id ?? "local", session.cwd, mode);
      // The Files window belongs to the IDE view: a switch to the Code view closes it.
      setLayout(mode === "code" ? withoutEditor(next) : next);
    }
    if (mode === "ide") {
      sidebarBeforeIde.current = sidebarOpen;
      setSidebarOpen(false);
    } else if (sidebarBeforeIde.current !== null) {
      setSidebarOpen(sidebarBeforeIde.current);
      sidebarBeforeIde.current = null;
    }
  };
  const switchViewRef = useRef(switchView);
  switchViewRef.current = switchView;
  const [sideFloating, setSideFloating] = useState(false);
  const [sideFocus, setSideFocus] = useState(0);
  const sideDocked = findGroupOf(layout, "side") !== null;
  const toggleSideChat = useCallback(() => {
    if (sideDocked) {
      setLayout((l) => closePane(l, "side"));
      return;
    }
    setSideFloating((open) => !open);
    setSideFocus((k) => k + 1);
  }, [sideDocked]);
  useEffect(() => {
    if (screen !== "chat") return;
    const onKey = (e: KeyboardEvent) => {
      if (!isSideChatShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) toggleSideChat();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [screen, toggleSideChat]);

  const sendSafely = useCallback(
    (msg: Parameters<DaemonConnection["send"]>[0]) => {
      try {
        conn.send(msg);
        return true;
      } catch (e) {
        showError(errorText(e)); // Many callers are not in the chat: the sidebar, a page, a pane.
        return false;
      }
    },
    [conn, showError],
  );

  // The pull request links of the chat ask the daemon for their pull request (the hover card).
  useEffect(() => {
    prInfoStore.setSender(status === "open" ? (url, fresh) => sendSafely(fresh ? { type: "git.pr_info", url, fresh } : { type: "git.pr_info", url }) : null);
  }, [status, sendSafely]);

  // Stable callbacks: each user message in the chat is memoized, and a new function renders all of them again.
  const rewind = useCallback(
    // A rewind always restores the code and the conversation (the user asked for this).
    (messageId: string) => void sendSafely({ type: "session.rewind", id: messageId, conversation: true, code: true }),
    [sendSafely],
  );
  const undoRewind = useCallback(() => void sendSafely({ type: "session.rewind_undo" }), [sendSafely]);
  const fork = useCallback((messageId: string) => void sendSafely({ type: "session.fork", id: messageId }), [sendSafely]);

  // The model menus: the providers on the computer of the daemon ("Local models"), and the effort level
  // (the user setting "effort").
  const localProviders = useMemo(
    () => new Set((providers?.items ?? []).filter((p) => p.enabled && isLocalProvider(p)).map((p) => p.name)),
    [providers],
  );
  const effortValue = status === "open" ? (userSettings?.effort ?? null) : null;
  const effortControl = useMemo(
    () =>
      status === "open" && userSettings
        ? { value: effortValue, onChange: (effort: Effort) => void sendSafely({ type: "user_settings.set", values: { effort } }) }
        : undefined,
    [status, userSettings !== null, effortValue, sendSafely],
  );

  // The Preview pane: a PDF or Word file of the session folder. The user opens it from the file tree
  // or a path in the chat. The agent opens it with the show_document tool. The daemon sends the
  // bytes ("fs.read_bytes"). Only the reply to the last request shows.
  const [preview, setPreview] = useState<PreviewDoc | null>(null);
  const previewPending = useRef(0);
  const openPreview = useCallback(
    (path: string) => {
      const rel = normalizePath(path, sessionRef.current?.cwd ?? "");
      setPreview({ path: rel, status: "loading" });
      showPane("preview");
      if (sendSafely({ type: "fs.read_bytes", path: rel })) previewPending.current += 1;
      else setPreview({ path: rel, status: "error", error: "Connect to the computer of the session, then try again." });
    },
    [sendSafely, showPane],
  );
  useEffect(() => {
    previewPending.current = 0;
    setPreview(null);
  }, [session?.id]);
  useEffect(() => {
    const toolCalls = new Map<string, { name: string; input: unknown }>();
    return conn.onMessage((msg) => {
      if (msg.type === "fs.bytes" || (msg.type === "error" && msg.ref === "fs.read_bytes")) {
        if (previewPending.current === 0) return;
        previewPending.current -= 1;
        if (previewPending.current > 0) return; // A newer request waits for its reply.
        if (msg.type === "fs.bytes") setPreview({ path: msg.path, status: "ready", data: base64ToBytes(msg.data) });
        else setPreview((p) => (p ? { path: p.path, status: "error", error: msg.message } : p));
      } else if (msg.type === "tool.start") {
        toolCalls.set(msg.id, { name: msg.name, input: msg.input });
      } else if (msg.type === "tool.result") {
        const call = toolCalls.get(msg.id);
        toolCalls.delete(msg.id);
        const path = call && shownDocument(call.name, call.input, msg.is_error, sessionRef.current?.cwd ?? "");
        if (path) openPreview(path);
      } else if (msg.type === "session.ready") {
        toolCalls.clear();
      }
    });
  }, [conn, openPreview]);

  const requestCommands = useCallback(() => {
    if (conn.status === "open") conn.send({ type: "skills.list" });
  }, [conn]);

  const mcpAuth = (action: McpAuthAction) => {
    if (action.kind === "code") sendSafely({ type: "mcp.auth_code", name: action.name, url: action.url });
    else if (action.kind === "auth") sendSafely({ type: "mcp.auth", name: action.name });
    else if (action.kind === "cancel") sendSafely({ type: "mcp.auth_cancel", name: action.name });
    else sendSafely({ type: "mcp.logout", name: action.name });
  };

  const connectorAction = (action: ConnectorAction) => {
    connectorWait.current = action.id;
    setConnectorError(null);
    setConnectorBusy(action.id);
    if (action.kind === "cancel") {
      sendSafely({ type: "connectors.cancel", id: action.id });
      return;
    }
    let sent: boolean;
    if (action.kind === "disconnect") sent = sendSafely({ type: "connectors.disconnect", id: action.id });
    else if (action.kind === "remove_account") sent = sendSafely({ type: "connectors.remove_account", id: action.id, login: action.login });
    else if (action.source === "token") sent = sendSafely({ type: "connectors.connect", id: action.id, source: "token", token: action.token });
    else if (action.source === "device") sent = sendSafely({ type: "connectors.connect", id: action.id, source: "device", options: action.options });
    else if (action.source === "mail") sent = sendSafely({ type: "connectors.connect", id: action.id, source: "mail", options: action.options });
    else if (action.source === "desktop") sent = sendSafely({ type: "connectors.connect", id: action.id, source: "desktop", options: action.options });
    else sent = sendSafely({ type: "connectors.connect", id: action.id, source: "gh" });
    if (!sent) setConnectorBusy(null);
  };

  const restartMcp = (name?: string) => {
    setMcpBusy(true);
    if (!sendSafely({ type: "mcp.restart", ...(name ? { name } : {}) })) setMcpBusy(false);
  };

  /**
   * Opens the Capabilities page: the skills and the MCP servers of the open session, or with no
   * session, of the folder of the start screen.
   */
  const openCapabilities = (tab?: CapTab) => {
    if (tab) setCapsTab(tab);
    // The project that the start screen selected (SessionStart saves its id).
    const startId = loadPref(`project.${current?.id ?? "local"}`, "");
    const folder = session ? null : ((projects ?? []).find((p) => p.id === startId && p.exists)?.path ?? null);
    capsFallback.current = false;
    setSkillItems(null);
    setSkillDetail(null);
    setMcpStatus(null);
    setCapsLive(session !== null);
    setCapsFolder(session?.cwd ?? folder);
    setPluginError(null);
    setSettingsPage(null);
    setScreen("capabilities");
    sendSafely({ type: "capabilities.list", ...(folder ? { cwd: folder } : {}) });
    sendSafely({ type: "plugins.list" }); // The Plugins tab, and its count.
    setConnectorError(null);
    sendSafely({ type: "connectors.list" }); // The Connectors tab. It needs no session.
  };
  openCapabilitiesRef.current = openCapabilities;

  /** Opens the Routines page: the prompts that the daemon runs on a schedule. */
  const openRoutines = () => {
    setRoutineError(null);
    setSettingsPage(null);
    setScreen("routines");
    sendSafely({ type: "routines.list" });
    if (!projects) sendSafely({ type: "projects.list" }); // The folder menu of the form.
  };

  const openSkill = useCallback(
    (name: string) => {
      setSkillDetail("loading");
      const cwd = !capsLive && capsFolder ? { cwd: capsFolder } : {};
      if (!sendSafely({ type: "skills.get", name, ...cwd })) setSkillDetail(null);
    },
    [sendSafely, capsLive, capsFolder],
  );

  const backToSkills = useCallback(() => setSkillDetail(null), []);

  // Save the layout for each project (SPEC.md section 8.4).
  useEffect(() => {
    if (session) savePref(layoutKey(currentRef.current?.id ?? "local", session.cwd, view), JSON.stringify(layout));
  }, [layout, session, view]);

  const editor = useEditor(conn, session?.id ?? null, session?.cwd ?? "");
  // An open file closes the folder block in the editor.
  useEffect(() => {
    if (editor.active && ideBlockFor) setIdeBlockFor(null);
  }, [editor.active, ideBlockFor]);

  /** A folder from the block in the editor: the empty session moves there, with its files and terminal. */
  const pickIdeFolder = (id: string, path: string) => {
    if (!session) return;
    savePref(`project.${currentRef.current?.id ?? "local"}`, id); // The start screen selects it next time.
    if (samePath(path, session.cwd)) return;
    if (session.worktree) {
      // A worktree session cannot move: a new empty session starts in the folder.
      ideStarting.current = true;
      startSession(path, session.model, null, permissionMode, null);
      return;
    }
    sendSafely({ type: "session.move", session_id: session.id, cwd: path });
  };
  const ideBlock =
    session && ideBlockFor === session.id ? (
      <>
        <p className="ide-start-title">Choose a folder to work in</p>
        <FolderChooser
          projects={projects}
          selectedId={projects?.find((p) => samePath(p.path, session.cwd))?.id ?? null}
          prefScope={currentRef.current?.id ?? "local"}
          onBrowse={browseFolder}
          onSaveProject={saveProject}
          onPicked={pickIdeFolder}
        />
      </>
    ) : undefined;
  const servers = useServers(conn, session?.id ?? null);

  const showInBrowser = useCallback((url: string) => {
    setBrowserRequest((r) => ({ url, key: (r?.key ?? 0) + 1 }));
    setLayout((l) => openPane(l, "browser"));
  }, []);

  // The cards of send_file and artifact: the Browser pane, and the files of a daemon on this computer.
  const cardActions = useMemo<CardActions>(() => {
    let local = false;
    try {
      local = !!daemonHttp && isTauri() && isLoopback(new URL(daemonHttp).hostname);
    } catch {
      local = false;
    }
    return { openInBrowser: showInBrowser, onError: showError, daemonBase: daemonHttp, local };
  }, [showInBrowser, showError, daemonHttp]);

  // "Open links in built-in browser": the chat links open in the Browser pane.
  useEffect(() => {
    setPaneOpener(showInBrowser);
    return () => setPaneOpener(null);
  }, [showInBrowser]);

  // "Manage allowed sites" of the Browser pane: the site rules of the project.
  const [sitesOpen, setSitesOpen] = useState(false);
  const openSites = () => {
    setSitesOpen(true);
    setRules(null);
    setRulesBusy(true);
    if (!sendSafely({ type: "permissions.get" })) setRulesBusy(false);
  };

  // The Browser pane is not the chat: its errors show in a popup, which stays clear of the page.
  const browserError = showError;

  /** A server URL for the Browser pane. A server on a remote daemon goes through a local forward port. */
  const openServer = useCallback(
    async (server: ServerItem) => {
      if (!server.url) return;
      const connection = currentRef.current;
      const target = targetRef.current;
      const remote = connection?.kind === "ssh" || (connection?.kind === "direct" && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(target?.host ?? ""));
      if (!remote) return showInBrowser(server.url);
      if (!isTauri() || !target || !sessionRef.current) {
        return browserError("A server on a remote daemon opens only in the desktop app, which forwards its port.");
      }
      try {
        const port = await forwardOpen({
          daemonHost: target.host,
          daemonPort: target.port,
          token: target.token,
          sessionId: sessionRef.current.id,
          server: server.name,
        });
        const u = new URL(server.url);
        showInBrowser(`http://127.0.0.1:${port}${u.pathname}${u.search}`);
      } catch (e) {
        browserError(errorText(e));
      }
    },
    [showInBrowser, browserError],
  );

  /** Open the page of the agent browser in the Browser pane. A server page goes through openServer (remote forward). */
  const openAgentPage = useCallback(
    (url: string) => {
      let port = "";
      try {
        const u = new URL(url);
        port = u.port || (u.protocol === "https:" ? "443" : "80");
      } catch {
        return browserError(`Not a valid address: ${url}`);
      }
      const server = servers.items.find((s) => s.state === "running" && s.port !== null && String(s.port) === port);
      if (server) void openServer({ ...server, url });
      else showInBrowser(url);
    },
    [servers.items, openServer, showInBrowser, browserError],
  );

  const changeAutoVerify = useCallback((enabled: boolean) => sendSafely({ type: "settings.set", auto_verify: enabled }), [sendSafely]);

  /** Changes the permission mode of the project. The daemon replies with "settings". */
  const changeMode = (mode: PermissionMode) => {
    if (!sendSafely({ type: "settings.set", permission_mode: mode })) return;
    setPermissionMode(mode);
    saveLastMode(currentRef.current?.id ?? "local", mode); // The start page selects the last mode.
    // The mode text under the prompt box shows the mode. Only the bypass mode also gets a warning.
    if (mode === "bypassPermissions") {
      const label = MODES.find((m) => m.mode === mode)?.label ?? mode;
      dispatch({ type: "notice", level: "warning", text: `${label} is on. The agent runs each action with no question. Only the deny rules apply.` });
    }
  };

  // /preview: open the default server when it runs.
  useEffect(() => {
    if (!previewServer) return;
    const server = servers.items.find((s) => s.name === previewServer);
    if (server?.state === "running") {
      setPreviewServer(null);
      void openServer(server);
    } else if (server?.state === "crashed" || (server?.state === "stopped" && server.error)) {
      setPreviewServer(null);
    }
  }, [previewServer, servers.items, openServer]);

  // "Keep cookies and storage when a server restarts" is off: clear them at each server start.
  const serverStates = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const s of servers.items) {
      const before = serverStates.current[s.name];
      if (s.state === "starting" && before && before !== "starting" && isTauri() && keepCookies() === "server") {
        void clearBrowserData().catch(() => undefined);
      }
      serverStates.current[s.name] = s.state;
    }
  }, [servers.items]);

  // Close the port forwards of the old session.
  useEffect(() => {
    if (isTauri()) void forwardCloseAll().catch(() => undefined);
  }, [session?.id]);

  const openPath = useCallback(
    (path: string, line?: number) => {
      // PDF and Word files open in the Preview pane. HTML, images, and video open in the Browser pane
      // (SPEC.md section 8.6). Other files open in the editor.
      if (isPreviewFile(path)) {
        openPreview(path);
        return;
      }
      const target = targetRef.current;
      if (BROWSER_FILE_RE.test(path) && target && filesToken) {
        const rel = normalizePath(path, sessionRef.current?.cwd ?? "");
        showInBrowser(`http://${target.host}:${target.port}/files/${filesToken}/${rel.split("/").map(encodeURIComponent).join("/")}`);
        return;
      }
      editor.openFile(path, line);
      setLayout((l) => openPane(l, "editor"));
    },
    [editor.openFile, filesToken, showInBrowser, openPreview],
  );

  // send_file: "render" opens the first file that a pane can show at once. "proactive" also shows a
  // notification when the user does not see the session. Only live results: not the history.
  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type !== "tool.result" || msg.card?.type !== "files") return;
        const card = msg.card;
        if (card.display === "render") {
          const first = card.files.find((f) => f.project && opensInPane(fileKind(f.name)));
          if (first) openPath(first.path);
        }
        if (card.status === "proactive") {
          const names = card.files.map((f) => f.name).join(", ");
          void notifyFilesSent(card.caption || names, sessionRef.current?.id ?? null, {
            windowVisible: !document.hidden,
            windowFocused: document.hasFocus(),
            shownSessionId: shownIdRef.current,
          });
        }
      }),
    [conn, openPath],
  );

  // mcp.init created (or found) .harness/mcp.json: open it in the editor.
  useEffect(() => {
    if (!pendingEdit) return;
    editor.openFile(pendingEdit.path);
    setLayout((l) => openPane(l, "editor"));
  }, [pendingEdit?.key]);

  const editLaunchConfig = useCallback(() => {
    editor.openFile(".harness/launch.json");
    setLayout((l) => openPane(l, "editor"));
  }, [editor.openFile]);

  const addReference = useCallback((text: string) => {
    setPromptInsert((p) => ({ text, key: (p?.key ?? 0) + 1 }));
    setLayout((l) => openPane(l, "chat"));
  }, []);

  // The lines that the agent changed in the current turn: the added lines of each diff since the last prompt.
  // The map changes only when a diff comes, not for each new text of the model: a new map sets the
  // decorations of the editor again.
  const turnDiffs = useRef<string[]>([]);
  let lastUser = chat.items.length - 1;
  while (lastUser >= 0 && chat.items[lastUser].kind !== "user") lastUser--;
  turnDiffs.current = chat.items.slice(lastUser + 1).flatMap((i) => (i.kind === "tool" && i.diff ? [i.diff] : []));
  const diffKey = turnDiffs.current.join("\u0000");
  const agentLines = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const diff of turnDiffs.current) {
      const parsed = parseUnifiedDiff(diff);
      const lines = parsed.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.newNo!));
      map.set(parsed.path, [...(map.get(parsed.path) ?? []), ...lines]);
    }
    return map;
  }, [diffKey]);

  // The chat item that the diff review pane shows.
  const reviewItem = reviewId ? chat.items.find((i) => i.id === reviewId) : undefined;
  const reviewDiff = reviewItem && (reviewItem.kind === "tool" || reviewItem.kind === "permission") ? reviewItem.diff : null;
  const paneVisible = (pane: PaneId) => findGroupOf(layout, pane)?.active === pane;

  // The Changes pane shows the full change of the folder: ask for it when the pane shows, at the start
  // and the end of a turn, and when the scope changes.
  const diffShown = paneVisible("diff") && !(reviewItem && reviewDiff);
  const requestDiff = useCallback(() => {
    if (session && status === "open") sendSafely({ type: "git.diff", cwd: session.cwd, scope: diffScope });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sendSafely is stable for the connection.
  }, [session?.cwd, status, diffScope]);
  useEffect(() => {
    if (diffShown) requestDiff();
  }, [diffShown, requestDiff, chat.running, session?.id]);
  // An error of another session or another scope is not the error of this view.
  useEffect(() => setDiffError(null), [session?.id, diffScope]);

  // A Rules tab from the saved layout has no data yet: load it when the tab shows.
  const rulesShown = session !== null && status === "open" && paneVisible("rules");
  useEffect(() => {
    if (rulesShown && rules === null && !rulesBusy) {
      setRulesBusy(true);
      try {
        conn.send({ type: "permissions.get" });
      } catch {
        setRulesBusy(false);
      }
    }
  }, [rulesShown, rules === null]);

  const folder = session?.project ?? session?.cwd.split(/[\\/]/).filter(Boolean).pop();

  // The sessions of the "@" menu: not this session, and the sessions of this project first.
  const mentionSessions = useMemo(
    () => (session ? mentionOrder(recent, session.cwd, session.id) : []),
    [recent, session?.id, session?.cwd],
  );

  // The closed connection shows on each screen that needs the daemon, not only in the chat (audit U5).
  // Reconnect is off only while a connection attempt runs. The banner stays during an automatic retry (no blink).
  const disconnectBanner = current !== null && (status === "closed" || (reconnecting && status !== "open")) && (
    <div className="banner" role="alert">
      <span>{reconnecting ? "The connection to the daemon closed. Reconnecting…" : "The connection to the daemon closed."}</span>
      <button type="button" className="btn" onClick={reconnect} disabled={connectingId !== null}>
        <RefreshCw size={14} aria-hidden />
        {reconnecting ? "Reconnect now" : "Reconnect"}
      </button>
    </div>
  );

  const chatPane = (
    <div className="chat">
      {sideFloating && !sideDocked && session && (
        <SideChat
          items={side.items}
          running={side.running}
          onAsk={side.ask}
          onStop={side.stop}
          onClear={clearSide}
          onClose={() => setSideFloating(false)}
          onPopOut={() => {
            setSideFloating(false);
            showPane("side");
          }}
          focusKey={sideFocus}
        />
      )}
      {disconnectBanner}
      <MessageList
        items={chat.items}
        queued={queue}
        running={chat.running}
        reviewId={paneVisible("diff") ? reviewId : null}
        onDecide={decide}
        onAnswer={answerQuestion}
        onRetry={session && status === "open" && lastSubmission.current.has(session.id) ? retryLast : undefined}
        turn={chat.turn}
        model={session?.harness?.name ?? session?.model ?? ""}
        footer={
          session &&
          !chat.running &&
          !modelAskDismissed.has(`${session.id} ${session.model}`) &&
          modelGone &&
          !autoModel && (
            <ModelUnavailable
              model={session.model}
              reason={session.modelUnavailable}
              models={models}
              proposed={proposedModel(models, [loadPref(`model.${currentRef.current?.id ?? "local"}`, "")])}
              disabled={status !== "open"}
              onRequestModels={requestModels}
              onSwitch={chooseModel}
              onDismiss={() => setModelAskDismissed((d) => new Set(d).add(`${session.id} ${session.model}`))}
              onManage={showProviders}
            />
          )
        }
        onPlan={decidePlan}
        onReview={toggleReview}
        onSendNow={sendNow}
        onRemoveQueued={removeQueued}
        onRewind={rewind}
        onUndoRewind={undoRewind}
        onFork={fork}
        onAction={(message) => submitOrQueue({ kind: "prompt", text: message })}
        emptyHint={
          <>
            <p>
              Ask the agent about <span className="mono">{folder}</span>.
            </p>
            <p className="help">
              Type <code>/help</code> for the commands. Press <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line.
            </p>
            {instructions && (
              <p className="help">
                The agent follows the project instructions in <code>{instructions}</code>.
              </p>
            )}
          </>
        }
      />
      <div className="composer">
        <div className="column">
          <PromptBox
            draftKey={session?.id ?? null}
            running={chat.running}
            answerHint={waitingCardHint(chat.items)}
            disabled={status !== "open"}
            onSubmit={submitOrQueue}
            onInterrupt={interrupt}
            commands={commands}
            onRequestCommands={requestCommands}
            insert={promptInsert}
            attach={promptAttach}
            onAddFiles={() => addFiles(session?.cwd ?? "")}
            sessions={mentionSessions}
            fileMatches={fileMatches}
            onFindFiles={(query) => sendSafely({ type: "fs.find", query })}
            onCycleMode={() => changeMode(nextMode(permissionMode))}
            suggestion={!chat.running && session && suggestion?.sessionId === session.id ? suggestion.text : null}
            onDismissSuggestion={() => setSuggestion(null)}
            imageNote={session && !session.harness && chat.imageInput === false ? noImageNote(modelName(session.model)) : null}
            below={
              session && (
                <>
                <ModeMenu mode={permissionMode} onChange={changeMode} />
                <div className="prompt-below-right">
                {session.harness ? (
                  <HarnessMenu
                    harness={session.harness}
                    disabled={chat.running}
                    onSelect={(model) => sendSafely({ type: "acp.model", model })}
                  />
                ) : (
                <ModelMenu
                  value={session.model}
                  models={models}
                  allowDefault={false}
                  up
                  alignRight
                  heading="Model · this session"
                  localProviders={localProviders}
                  effort={effortControl}
                  onOpen={requestModels}
                  onSelect={chooseModel}
                  onManage={showProviders}
                />
                )}
                {/* An ACP session shows the ring only when its harness reports the usage (usage_update). */}
                {chat.context && (!session.harness || chat.context.tokens > 0) && (
                  <ContextRing
                    tokens={chat.context.tokens}
                    length={chat.context.length}
                    source={chat.context.source}
                    usage={contextUsage}
                    running={chat.running}
                    onOpen={() => sendSafely({ type: "context.get" })}
                    onCompact={() => submit({ kind: "command", name: "compact", args: "" })}
                  />
                )}
                </div>
                </>
              )
            }
          />
        </div>
      </div>
    </div>
  );

  const dirtyCount = editor.files.filter((f) => f.dirty).length;
  const filesPaneOpen = findGroupOf(layout, "files") !== null;
  const panes: Record<PaneId, PaneSpec> = {
    chat: { title: "Chat", icon: MessageSquare, closable: false, render: () => chatPane },
    preview: {
      title: "Preview",
      icon: FileText,
      closable: true,
      render: () => (
        <PreviewPane doc={preview} onReload={() => preview && openPreview(preview.path)} onOpenLink={openLink} />
      ),
    },
    tasks: {
      title: "Background tasks",
      icon: ListChecks,
      closable: true,
      badge: runningTasks ? <span className="tab-badge" title={`${runningTasks} running`}>{runningTasks}</span> : undefined,
      render: () => (
        <TasksPane
          items={tasks}
          detail={taskDetail}
          onRequest={() => sendSafely({ type: "tasks.list" })}
          onOpen={(id) => sendSafely({ type: "task.get", id })}
          onStop={(id) => sendSafely({ type: "task.stop", id })}
        />
      ),
    },
    side: {
      title: "Side chat",
      icon: MessagesSquare,
      closable: true,
      render: () =>
        session ? (
          <SideChat
            items={side.items}
            running={side.running}
            onAsk={side.ask}
            onStop={side.stop}
            onClear={clearSide}
            onDock={() => {
              hidePane("side");
              setSideFloating(true);
              setSideFocus((k) => k + 1);
            }}
          />
        ) : (
          <p className="pane-empty">Open a session to use the side chat.</p>
        ),
    },
    editor: {
      // With the Files pane open (the IDE view), this window is only the editor.
      title: filesPaneOpen ? "Editor" : "Files",
      icon: filesPaneOpen ? Code2 : Folder,
      // The IDE view always shows the editor. The open files keep their close buttons.
      closable: view !== "ide",
      badge: dirtyCount ? <span className="tab-badge" title={`${dirtyCount} unsaved`}>{dirtyCount}</span> : undefined,
      render: () => (
        <EditorPane
          part={filesPaneOpen ? "editor" : "all"}
          api={editor}
          sessionKey={session?.id ?? ""}
          agentLines={agentLines}
          onReference={addReference}
          onInlineEdit={(reference, instruction) => submitOrQueue({ kind: "prompt", text: inlineEditPrompt(reference, instruction) })}
          onOpenFolder={() => void changeFolder()}
          onPreview={openPreview}
          openFolderBlocked={openFolderBlocked({ connected: status === "open", running: chat.running, worktree: !!session?.worktree })}
          emptyContent={ideBlock}
        />
      ),
    },
    // The file list and search in their own window, as VS Code's Explorer (the IDE view).
    files: {
      title: "Files",
      icon: Folder,
      closable: true,
      render: () => (
        <EditorPane
          part="files"
          api={editor}
          sessionKey={session?.id ?? ""}
          agentLines={agentLines}
          onReference={addReference}
          onInlineEdit={(reference, instruction) => submitOrQueue({ kind: "prompt", text: inlineEditPrompt(reference, instruction) })}
          onOpenFolder={() => void changeFolder()}
          onPreview={openPreview}
          openFolderBlocked={openFolderBlocked({ connected: status === "open", running: chat.running, worktree: !!session?.worktree })}
        />
      ),
    },
    diff: {
      title: "Changes",
      icon: FileDiff,
      closable: true,
      // The branch changes draw "{base} → {branch}" and their buttons in the window header.
      ownHeader: !(reviewItem && reviewDiff) && !!session,
      render: () =>
        reviewItem && reviewDiff ? (
          <DiffReview
            key={reviewItem.id}
            diff={reviewDiff}
            permission={reviewItem.kind === "permission" ? (reviewItem as PermissionItem) : null}
            onDecide={decide}
            onClose={() => hidePane("diff")}
          />
        ) : session ? (
          <ChangesView
            diff={gitDiff && samePath(gitDiff.cwd, session.cwd) && gitDiff.scope === diffScope ? gitDiff : null}
            scope={diffScope}
            onScope={setDiffScope}
            onRefresh={requestDiff}
            error={diffError}
            onOpenFile={(path, line) => openPath(path, line)}
            connected={status === "open"}
          />
        ) : (
          <p className="pane-empty">No change to review. The Changes pane shows each change that the agent asks to make.</p>
        ),
    },
    rules: {
      title: "Rules",
      icon: ShieldCheck,
      closable: true,
      render: () => (
        <RulesPanel rules={rules} busy={rulesBusy} savedAt={rulesSavedAt} onSave={saveRules} onClose={() => hidePane("rules")} />
      ),
    },
    terminal: {
      title: "Terminal",
      icon: SquareTerminal,
      closable: true,
      ownHeader: true, // Its tabs are in the window header.
      render: () => (
        <TerminalPane conn={conn} sessionKey={session?.id ?? ""} connected={status === "open"} onEmpty={() => hidePane("terminal")} />
      ),
    },
    browser: {
      title: "Browser",
      icon: GlobeIcon,
      closable: true,
      ownHeader: true, // Its tabs are in the window header.
      // A double-click on the divider next to the browser minimizes it to the session rail (only the Code view has the rail).
      onMinimize:
        view === "code" && session
          ? () => {
              minimizeShownTab(session.id);
              hidePane("browser");
              showRail(true);
            }
          : undefined,
      // The X: the session rail stops its view of the agent page (the user asked for this). The next
      // agent call in the browser shows it again.
      onClose: () => {
        if (session) hideRailBrowser(session.id);
        setAgentFrame(null);
        setFrameLive(false);
      },
      render: () => (
        <BrowserPane
          session={session?.id ?? null}
          request={browserRequest}
          serverApi={servers}
          agentFrame={agentFrame}
          showAgent={showAgentView}
          onOpenServer={(s) => void openServer(s)}
          onOpenAgentPage={openAgentPage}
          onError={browserError}
          onEmpty={() => hidePane("browser")}
          autoVerify={session ? autoVerify : null}
          onAutoVerify={changeAutoVerify}
          onManageSites={openSites}
          onEditLaunch={editLaunchConfig}
          serverApprovals={serverApprovals}
          onDecide={decide}
          // A note on an element goes into the prompt box as a chip. The Browser pane stays open for more notes.
          onAnnotate={(note) => setPromptAttach((p) => ({ item: annotationAttachment(note), key: (p?.key ?? 0) + 1 }))}
          onScreenshot={(image, url) => setPromptAttach((p) => ({ item: screenshotAttachment(image, url), key: (p?.key ?? 0) + 1 }))}
          // "Minimize": the pane closes, and the session rail shows the page (only the Code view has the rail).
          onMinimize={
            view === "code" && session
              ? () => {
                  hidePane("browser");
                  showRail(true);
                }
              : undefined
          }
        />
      ),
    },
  };

  /** Move the session to another folder. The daemon opens it again there. */
  const changeFolder = async () => {
    if (!session) return;
    const path = await browseFolder(session.cwd);
    if (path && path !== session.cwd) sendSafely({ type: "session.move", session_id: session.id, cwd: path });
  };

  // The menu of a session row: open, pin, mark as unread, rename, and delete.
  const sessionActions: SessionActions = {
    // The session of the split pane stays there: a click puts the focus in its prompt box.
    onResume: (id) => (id === split ? setSplitFocus((k) => k + 1) : fromSidebar(() => resumeSession(id))()),
    onOpenSplit: (id) => openSplit(id),
    onOpenPr: (url) => openLink(url),
    onPin: (id, pinned) => void sendSafely({ type: "session.update", session_id: id, pinned }),
    onArchive: (id, archived) => void sendSafely({ type: "session.update", session_id: id, archived }),
    // No question first: the popup has "Undo" (rule R7a). A session with uncommitted changes in a worktree still asks.
    onArchiveAll: (ids) => {
      if (!ids.every((id) => sendSafely({ type: "session.update", session_id: id, archived: true }))) return;
      showUndo(ids.length === 1 ? "Archived 1 session." : `Archived ${ids.length} sessions.`, () =>
        ids.forEach((id) => sendSafely({ type: "session.update", session_id: id, archived: false })),
      );
    },
    onMarkUnread: (id, on) =>
      setUnreadSessions((u) => {
        const next = new Set(u);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    onRename: (id, title) => void sendSafely({ type: "session.update", session_id: id, title }),
    onDelete: (id) => setDeleteAsk(id), // Delete always asks first (UI_RULES S8).
  };

  /** "Open in" > "Split view", or a drop on the main view: the session opens at the right of the shown session. */
  const openSplit = (id: string) => {
    if (screen !== "chat" || !session || view !== "code") {
      fromSidebar(() => resumeSession(id))(); // No session to split with: the session opens in the main view.
      return;
    }
    if (id === session.id) return;
    setSplit(id);
    setSplitFocus((k) => k + 1);
  };
  const splitShown = split !== null && screen === "chat" && session !== null && view === "code";
  const splitDrop = useSplitDrop(screen === "chat" && session !== null && view === "code", session?.id ?? null, openSplit);

  const narrow = () => window.matchMedia(NARROW_QUERY).matches;
  const showSidebar = (open: boolean) => {
    setSidebarOpen(open);
    // The saved state is the state of the Code view. The IDE view does not change it.
    if (!narrow() && viewRef.current !== "ide") savePref("sidebar.open", open ? "1" : "0");
  };

  // Ctrl+E switches between the Code view and the IDE view, only on the chat screen. On other screens
  // the key does nothing. The capture phase runs before the editor and the terminal get the key.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isViewShortcut(e)) return;
      e.preventDefault(); // Also on other screens, so the WebView does not do its own Ctrl+E action.
      e.stopPropagation();
      if (e.repeat || screenRef.current !== "chat") return;
      switchViewRef.current(viewRef.current === "ide" ? "code" : "ide");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Ctrl+B shows or hides the sidebar on every screen. The capture phase runs before the editor
  // and the terminal get the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSidebarShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      setSidebarOpen(!sidebarOpen);
      if (!window.matchMedia(NARROW_QUERY).matches && viewRef.current !== "ide") savePref("sidebar.open", sidebarOpen ? "0" : "1");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sidebarOpen]);
  // The hidden sidebar shows over the view while the pointer is on the sidebar toggle, or on the sidebar.
  const [peek, setPeek] = useState(false);
  // The pointer is on the sidebar toggle. The browser does not update the hover while the sidebar
  // reveals under a still pointer, so the toggle in the sidebar keeps the hover look until the pointer moves off it.
  const [toggleHot, setToggleHot] = useState(false);
  const peekRef = useRef<HTMLDivElement>(null);
  // M15: the peek fades out (120 ms) when the pointer leaves it. Ctrl+B removes it at once.
  const peekShown = usePresence(peek, 120);
  const peekTimer = useRef<number | null>(null);
  const cancelPeek = () => {
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };
  // A click on "Hide sidebar" blocks the peek until the pointer leaves the toggle (see sidebarPeek.ts).
  const peekBlocked = useRef(false);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!peekBlocked.current) return;
      const overToggle = e.target instanceof Element && e.target.closest(".sidebar-toggle") !== null;
      peekBlocked.current = peekGate(peekBlocked.current, { type: "pointer", overToggle });
    };
    document.addEventListener("pointermove", onMove);
    return () => document.removeEventListener("pointermove", onMove);
  }, []);
  const startPeek = (e: React.MouseEvent) => {
    if (!canStartPeek(peekBlocked.current, e.buttons)) return;
    cancelPeek();
    peekTimer.current = window.setTimeout(() => {
      peekTimer.current = null;
      setToggleHot(true);
      setPeek(true);
    }, PEEK_OPEN_MS);
  };
  useEffect(() => {
    if (sidebarOpen) setPeek(false);
  }, [sidebarOpen]);
  // The sidebar goes away a short time after the pointer leaves it. A menu or a dialog of the
  // sidebar keeps it. Esc closes it.
  useEffect(() => {
    if (!peek) return;
    let closeTimer: number | null = null;
    const keep = (target: EventTarget | null) =>
      target instanceof Element && (peekRef.current?.contains(target) || target.closest('[role="menu"], [role="dialog"], [role="listbox"], .tooltip') !== null);
    const onMove = (e: PointerEvent) => {
      setToggleHot(e.target instanceof Element && e.target.closest(".sidebar-toggle") !== null);
      if (keep(e.target)) {
        if (closeTimer !== null) window.clearTimeout(closeTimer);
        closeTimer = null;
      } else if (closeTimer === null) {
        closeTimer = window.setTimeout(() => setPeek(false), PEEK_CLOSE_MS);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="menu"], [role="dialog"]')) setPeek(false);
    };
    const onLeaveWindow = (e: MouseEvent) => {
      if (!e.relatedTarget) setPeek(false);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mouseout", onLeaveWindow);
    return () => {
      if (closeTimer !== null) window.clearTimeout(closeTimer);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mouseout", onLeaveWindow);
    };
  }, [peek]);
  /** On a narrow window the sidebar covers the page. Close it after a choice. The shown-over sidebar also closes. */
  const fromSidebar = (action: () => void) => () => {
    action();
    setPeek(false);
    if (narrow()) setSidebarOpen(false);
  };
  // Back and forward, as in Claude. Each new screen or session goes into the history.
  const [nav, setNav] = useState<NavHistory>(emptyHistory);
  const navTarget = useRef<Place | null>(null); // The place that a back or forward step opens.
  useEffect(() => {
    const place = placeOf(screen, session?.id);
    if (!place) return;
    const target = navTarget.current;
    navTarget.current = null;
    if (!samePlace(target ?? undefined, place)) setNav((h) => visit(h, place));
  }, [screen, session?.id]);

  const openPlace = (place: Place) => {
    switch (place.screen) {
      case "start":
        return newSession();
      case "chat":
        return session?.id === place.id ? setScreen("chat") : resumeSession(place.id);
      case "cookbook":
        return showCookbook();
      case "plugins":
        return showPlugins();
      case "providers":
        return showProviders();
      case "connections":
        return openConnections();
      case "capabilities":
        return openCapabilities();
      case "routines":
        return openRoutines();
    }
  };
  const canNav = status === "open" && !busy;
  const goNav = (delta: -1 | 1) => {
    const next = canNav ? step(nav, delta) : null;
    if (!next) return;
    navTarget.current = next.place;
    setNav(next.history);
    openPlace(next.place);
  };
  const goNavRef = useRef(goNav);
  goNavRef.current = goNav;

  // Alt+Left and Alt+Right go back and forward. The terminal keeps these keys for the shell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const delta = navShortcut(e);
      if (delta === null) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(".xterm")) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) goNavRef.current(delta);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // The sidebar button and the back and forward buttons. They are at the far left of the title
  // bar: in the sidebar when it is open, and in the top bar when it is closed.
  // The logo, the sidebar toggle, and Back and Forward. The Code / IDE view is in the ⋮ menu and on Ctrl+E.
  const titleNav = () => (
    <div className="title-nav">
      <img className="title-logo" src="/app-logo.png" alt="Harness" width={20} height={20} draggable={false} />
      <button
        type="button"
        className={`icon-btn ghost sidebar-toggle${peek && toggleHot ? " hot" : ""}`}
        onClick={() => {
          if (sidebarOpen) peekBlocked.current = peekGate(peekBlocked.current, { type: "hide-click" });
          showSidebar(!sidebarOpen);
        }}
        // While the sidebar is hidden, the pointer on this button shows the sidebar over the view.
        onMouseEnter={sidebarOpen ? undefined : startPeek}
        onMouseLeave={() => {
          cancelPeek();
          peekBlocked.current = peekGate(peekBlocked.current, { type: "leave" });
        }}
        aria-label={sidebarOpen ? "Hide the sidebar" : "Show the sidebar"}
        title={`${sidebarOpen ? "Hide sidebar" : "Show sidebar"} (${SIDEBAR_SHORTCUT})`}
      >
        <PanelLeft size={16} aria-hidden />
      </button>
      <button
        type="button"
        className="icon-btn ghost"
        onClick={() => goNav(-1)}
        disabled={!canNav || nav.index <= 0}
        aria-label="Back"
        title={`Back (${BACK_SHORTCUT})`}
      >
        <ArrowLeft size={16} aria-hidden />
      </button>
      <button
        type="button"
        className="icon-btn ghost"
        onClick={() => goNav(1)}
        disabled={!canNav || nav.index >= nav.stack.length - 1}
        aria-label="Forward"
        title={`Forward (${FORWARD_SHORTCUT})`}
      >
        <ArrowRight size={16} aria-hidden />
      </button>
    </div>
  );

  // The "Capabilities" nav item: the skills and the MCP servers. A red dot shows when a server failed.
  const mcpFailed = mcpStatus?.items.filter((i) => i.state === "failed").length ?? 0;
  const capabilitiesNav: SessionTool = {
    key: "capabilities",
    icon: Blocks,
    label: "Capabilities",
    active: screen === "capabilities",
    alert: mcpFailed > 0,
    title: mcpFailed > 0 ? (mcpFailed === 1 ? "1 MCP server failed" : `${mcpFailed} MCP servers failed`) : "Skills and MCP servers",
    onClick: fromSidebar(() => openCapabilities()),
  };
  // The "Routines" nav item. A red dot shows when the last run of a routine failed.
  const routinesFailed = routines?.filter((r) => r.error || r.last_run?.status === "failed").length ?? 0;
  const routinesNav: SessionTool = {
    key: "routines",
    icon: CalendarClock,
    label: "Routines",
    active: screen === "routines",
    alert: routinesFailed > 0,
    title: routinesFailed > 0 ? (routinesFailed === 1 ? "1 routine has a problem" : `${routinesFailed} routines have a problem`) : "Prompts that run on a schedule",
    onClick: fromSidebar(openRoutines),
  };

  // The panes of the open session in the sidebar: Permission rules.
  const sessionTools: SessionTool[] =
    screen === "chat" && session
      ? [
          {
            key: "rules",
            icon: ShieldCheck,
            label: "Permission rules",
            active: paneVisible("rules"),
            onClick: fromSidebar(paneVisible("rules") ? () => hidePane("rules") : openRules),
          },
        ]
      : [];

  const statusText = status === "open" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected";

  const sidebarView = (
    <Sidebar
      sessions={recent}
      running={allRunning}
      unread={unreadSessions}
      activeId={shownId}
      screen={screen}
      status={status}
      projects={projects ?? []}
      loading={status === "open" && (recentOf === null || projects === null)}
      onNewSession={fromSidebar(newSession)}
      onNewSessionIn={(group) => fromSidebar(() => void newSessionIn(group.projectId, group.name, group.path))()}
      onRemoveProject={deleteProject}
      actions={sessionActions}
      newSessionKey={NEW_SESSION_SHORTCUT}
      head={titleNav()}
      nav={[routinesNav, capabilitiesNav]}
      tools={sessionTools}
      prStatus={prStatus}
      onRequestPr={(paths) => {
        if (conn.status === "open") conn.send({ type: "git.pr_status", paths });
      }}
      onSearch={() => setSearchOpen(true)}
      searchKey={SEARCH_SHORTCUT}
      connection={
        <button
          type="button"
          className={`conn conn-${status}${screen === "connections" ? " active" : ""}`}
          onClick={fromSidebar(openConnections)}
          title={`${statusText}${hello ? ` ${status === "closed" ? "from" : "to"} ${hello.hostname} (${hello.platform})` : ""}. Open the computers.`}
        >
          <span className="conn-dot" aria-hidden />
          <ConnectionIcon connection={current} />
          <span className="conn-text">
            <span className="conn-name">{current?.name ?? "No connection"}</span>
            <span className="conn-host">{hello ? `${statusText} · ${hello.hostname}` : statusText}</span>
          </span>
        </button>
      }
      settings={
        <button
          type="button"
          className={`icon-btn ghost side-settings${settingsPage ? " active" : ""}`}
          onClick={() => (settingsPage ? setSettingsPage(null) : openSettings("general"))}
          aria-label={newVersion ? `Settings (${SETTINGS_SHORTCUT}). Version ${newVersion} is available.` : `Settings (${SETTINGS_SHORTCUT})`}
          title={newVersion ? `Settings (${SETTINGS_SHORTCUT}): version ${newVersion} is available` : `Settings (${SETTINGS_SHORTCUT})`}
        >
          <SettingsIcon size={16} aria-hidden />
          {newVersion && <span className="update-dot" aria-hidden />}
        </button>
      }
    />
  );

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      {sidebarOpen && (
        <>
          {sidebarView}
          <SidebarResizer
            width={sidebarWidth}
            onChange={setSidebarWidth}
            onDone={(w) => {
              setSidebarWidth(w);
              savePref("sidebar.width", String(w));
            }}
          />
          <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-hidden />
        </>
      )}
      {/* The sidebar is hidden: the pointer on the sidebar toggle shows it over the view. */}
      {!sidebarOpen && peekShown.mounted && (
        <div className={`sidebar-peek${peekShown.leaving ? " leaving" : ""}`} ref={peekRef}>
          {sidebarView}
        </div>
      )}
      <div className="shell">
        <header className={`topbar${hasWindowControls() ? " has-window-controls" : ""}${screen === "start" ? " no-line" : ""}`} data-tauri-drag-region="deep">
          {/* With the sidebar hidden, the title bar has the switch only in the IDE view (the user asked for this). */}
          {!sidebarOpen && titleNav()}
          <div className="topbar-title">
            {screen === "chat" && session && (
              <>
                <FolderMenu
                  name={folder ?? session.cwd}
                  path={session.cwd}
                  canReveal={isTauri() && current?.kind === "local"}
                  canChange={!chat.running && status === "open" && !session.worktree}
                  onReveal={() => void revealInExplorer(session.cwd).catch((e) => dispatch({ type: "notice", level: "error", text: errorText(e) }))}
                  onChange={() => void changeFolder()}
                  onOpenTerminal={() => showPane("terminal")}
                />
                <span className="topbar-divider" aria-hidden>|</span>
                <SessionTitle
                  id={session.id}
                  // The daemon gives the title after the first turn. The sidebar list has it.
                  title={session.title ?? recent.find((r) => r.id === session.id)?.title ?? "Untitled session"}
                  summary={recent.find((r) => r.id === session.id)}
                  unread={unreadSessions.has(session.id)}
                  pr={session.worktree ? (prStatus.get(pathKey(session.cwd))?.pr ?? null) : null}
                  actions={sessionActions}
                />
                {session.worktree && (
                  <span
                    className="topbar-branch"
                    title={`Worktree: ${session.worktree.path}${session.worktree.base ? `. Started from ${session.worktree.base}.` : ""}`}
                  >
                    <GitBranch size={12} aria-hidden />
                    <span className="mono">{session.worktree.branch}</span>
                  </span>
                )}
              </>
            )}
          </div>
          {screen === "chat" && (
            <div className="topbar-actions">
              {view === "ide" && <IdeLayoutMenu onOpenSettings={() => openSettings("appearance")} />}
              {/* The session rail toggle is first, as in the Claude app. The servers are in the Browser pane. */}
              {view === "code" && (
                <button
                  type="button"
                  className={`icon-btn ghost pane-toggle session-rail-toggle${rail ? " active" : ""}`}
                  onClick={() => showRail(!rail)}
                  aria-label="Session rail"
                  aria-pressed={rail}
                  aria-expanded={rail}
                  aria-controls={rail ? SESSION_RAIL_ID : undefined}
                  title={rail ? "Hide session rail" : "Show session rail"}
                >
                  <PanelRight size={16} aria-hidden />
                </button>
              )}
              {/* A line between the session rail toggle and the pane buttons (the user asked for this). */}
              {view === "code" && <span className="topbar-sep" aria-hidden />}
              <PaneToggle
                icon={SquareTerminal}
                label={`Terminal (${shortcutLabel("terminal")})`}
                active={paneVisible("terminal")}
                onClick={() => toggleShortcutPane("terminal")}
              />
              <PaneToggle
                icon={FileDiff}
                label={`Changes (${shortcutLabel("diff")})`}
                active={paneVisible("diff")}
                onClick={() => toggleShortcutPane("diff")}
              />
              <PaneToggle
                icon={GlobeIcon}
                label={`Browser (${shortcutLabel("browser")})`}
                active={paneVisible("browser")}
                onClick={() => toggleShortcutPane("browser")}
              />
              <PaneToggle
                icon={Folder}
                label={`Files (${shortcutLabel("editor")})`}
                active={paneVisible("editor")}
                onClick={() => toggleShortcutPane("editor")}
              />
              <MoreMenu
                sideChatKey={SIDE_CHAT_SHORTCUT}
                sideChatOpen={sideDocked || sideFloating}
                onSideChat={toggleSideChat}
                ideKey={VIEW_SHORTCUT}
                ideOpen={view === "ide"}
                onIde={() => switchView(view === "ide" ? "code" : "ide")}
                runningTasks={runningTasks}
                onTasks={() => showPane("tasks")}
                previewOpen={paneVisible("preview")}
                onPreview={() => toggleShortcutPane("preview")}
                keepAwake={keepAwake}
                onKeepAwake={(on) => {
                  if (sendSafely({ type: "session.keep_awake", on })) setKeepAwake(on);
                }}
                disabled={status !== "open"}
              />
            </div>
          )}
          {hasWindowControls() && <WindowControls />}
        </header>
        {/* A warning before the app closes while the agent works on this computer (as in the Claude app).
            A session that waits for an answer does not count: the agent is not working. */}
        {/* An app update restarts the daemon of this computer: it asks first while the agent works. */}
        <UpdateGuard working={current?.kind === "local" && status === "open" ? allRunning.length : 0} />
        <QuitGuard
          working={current?.kind === "local" && status === "open" ? runningSessions.filter((r) => !r.waiting).length : 0}
          agentServers={status === "open" ? agentServers.map((s) => s.name) : []}
          onStopAgentServers={() => void sendSafely({ type: "server.stop_agent" })}
        />

      <main className="main">
        {/* The chat has its own banner, in the chat column. The Computers screen shows the state of each connection. */}
        {(screen === "start" || screen === "routines" || screen === "capabilities") && disconnectBanner}
        {screen === "starting" && (
          <div className="center-status" role="status">
            <LoaderCircle size={20} className="spin" aria-hidden />
            {current?.kind === "local" || !current ? "Starting the local daemon" : `Connecting to ${current.name}`}
          </div>
        )}
        {screen === "connections" && (
          <ConnectionsScreen
            connections={connections}
            currentId={status === "open" ? (current?.id ?? null) : null}
            connectingId={connectingId}
            error={connError}
            tokenIds={tokenIds}
            canReturn={status === "open"}
            hasSession={session !== null}
            onConnect={(c) => void connectTo(c)}
            onSave={saveConnection}
            onDelete={(c) => void deleteConnection(c)}
            onTest={testConnection}
            onReturn={() => setScreen(session ? "chat" : "start")}
          />
        )}
        {screen === "routines" && (
          <RoutinesPage
            routines={routines}
            folder={routinesFolder}
            runs={routineRuns}
            projects={projects ?? []}
            defaultMode={userSettings?.permission_mode}
            models={models}
            error={routineError}
            saved={routineSaved}
            onRequestModels={() => sendSafely({ type: "models.list" })}
            onManageProviders={showProviders}
            onBrowse={(initial) => browseFolder(initial || hello?.home || "")}
            onSave={(fields, id) => {
              setRoutineError(null);
              sendSafely({ type: "routines.save", ...(id ? { id } : {}), ...fields });
            }}
            onDelete={(id) => sendSafely({ type: "routines.delete", id })}
            onRun={(id) => sendSafely({ type: "routines.run", id })}
            onToggle={(item, enabled) =>
              sendSafely({
                type: "routines.save",
                id: item.id,
                name: item.name,
                prompt: item.prompt,
                cwd: item.cwd,
                model: item.model,
                permission_mode: item.permission_mode,
                schedule: item.schedule,
                enabled,
              })
            }
            onRequestRuns={(id) => sendSafely({ type: "routines.runs", id })}
            apiBase={daemonHttp}
            newToken={routineToken}
            onToken={(id, action) => {
              setRoutineToken(null);
              sendSafely({ type: "routines.token", id, action });
            }}
            onTokenDone={() => setRoutineToken(null)}
            onOpenSession={resumeSession}
          />
        )}
        {screen === "capabilities" && (
          <CapabilitiesPage
            tab={capsTab}
            onTab={setCapsTab}
            folder={capsFolder}
            live={capsLive && session !== null}
            skills={skillItems}
            skillDetail={skillDetail}
            mcp={mcpStatus}
            mcpBusy={mcpBusy}
            onOpenSkill={openSkill}
            onBack={backToSkills}
            onRestart={restartMcp}
            onMcpAuth={mcpAuth}
            connectors={connectors}
            connectorBusy={connectorBusy}
            connectorError={connectorError}
            deviceCode={deviceCode}
            onConnector={connectorAction}
            onEditConfig={() => sendSafely({ type: "mcp.init" })}
            plugins={plugins}
            pluginsTab={
              <PluginsScreen
                status={plugins}
                error={pluginError}
                busy={pluginBusy}
                onInstall={(source, replace) => {
                  setPluginError(null);
                  if (sendSafely({ type: "plugins.install", source, replace })) setPluginBusy(true);
                }}
                onRemove={(name) => {
                  setPluginError(null);
                  if (sendSafely({ type: "plugins.remove", name })) setPluginBusy(true);
                }}
                onSetBundle={(name, enabled) => sendSafely({ type: "plugins.set_bundle", name, enabled })}
                onSetPlugin={(id, enabled) => sendSafely({ type: "plugins.set_plugin", id, enabled })}
                onReload={() => {
                  setPluginError(null);
                  if (sendSafely({ type: "plugins.reload" })) setPluginBusy(true);
                }}
                onBrowse={(initial) => browseFolder(initial ?? hello?.home ?? "")}
              />
            }
          />
        )}
        {screen === "start" && (
          <SessionStart
            key={current?.id ?? "none"}
            projects={projects}
            busy={busy}
            error={startError}
            onStart={startSession}
            branches={branches}
            onRequestBranches={(cwd) => void sendSafely({ type: "git.branches", cwd })}
            prefScope={current?.id ?? "local"}
            onBrowse={browseFolder}
            models={models}
            localProviders={localProviders}
            effort={effortControl}
            onRequestModels={requestModels}
            onManageProviders={showProviders}
            harness={status === "open" ? startHarness : null}
            onManageHarness={() => openSettings("operating")}
            onSaveProject={saveProject}
            onDeleteProject={deleteProject}
            selectProject={startProject}
            commands={commands}
            onRequestCommands={(cwd) => sendSafely({ type: "skills.list", cwd })}
            recentSessions={recent}
            fileMatches={fileMatches}
            onFindFiles={(query, cwd) => sendSafely({ type: "fs.find", query, cwd })}
            startRequest={ideStart}
            onAddFiles={addFiles}
            folderChosen={folderChosen}
            onChooseFolder={() => setFolderChosen(true)}
            view={view}
          />
        )}
        {sitesOpen && (
          <AllowedSites rules={rules} busy={rulesBusy} onSave={saveRules} onClose={() => setSitesOpen(false)} />
        )}
        {searchOpen && (
          <SessionSearch
            sessions={recent}
            projects={projects ?? []}
            activeId={session?.id ?? null}
            onOpen={(id) => resumeSession(id)}
            onClose={() => setSearchOpen(false)}
          />
        )}
        {rewindOpen && session && (
          <RewindDialog targets={rewindTargets(chat.items)} onRewind={rewind} onClose={() => setRewindOpen(false)} />
        )}
        {/* The popups at the bottom right: the app update, the daemon version, and the daemon update. */}
        <ToastStack>
          <ErrorToasts items={errorToasts} onClose={(id) => setErrorToasts((l) => l.filter((t) => t.id !== id))} />
          {!settingsPage && <UpdateToast currentVersion={appVersion} onView={() => openSettings("general")} />}
          {/* The X hides the warning for this daemon and these versions. It shows again for another daemon or another version. */}
          {appVersion &&
            daemonVersion &&
            status === "open" &&
            compareVersions(appVersion, daemonVersion) !== 0 &&
            versionClosed !== `${current?.id}:${appVersion}:${daemonVersion}` &&
            !(remoteUpdate && remoteUpdate.connectionId === current?.id && remoteUpdate.phase !== "error") && (
              <VersionWarning
                appVersion={appVersion}
                daemonVersion={daemonVersion}
                host={hello?.hostname ?? current?.name ?? "the daemon computer"}
                canUpdate={isTauri() && daemonUpdatable && current?.kind !== "local" && compareVersions(daemonVersion, appVersion) < 0}
                onUpdate={() => void startDaemonUpdate()}
                onComputers={() => openSettings("computers")}
                onClose={() => setVersionClosed(`${current?.id}:${appVersion}:${daemonVersion}`)}
              />
            )}
          {remoteUpdate && !remoteHidden && (
            <DaemonUpdateToast
              update={remoteUpdate}
              onClose={() => {
                // A running update goes on: its popup shows again only for an error.
                if (remoteUpdate.phase === "done" || remoteUpdate.phase === "error") setRemoteUpdate(null);
                else setRemoteHidden(true);
              }}
            />
          )}
        </ToastStack>
        {archiveAsk && (
          <ArchiveConfirm
            title={recent.find((r) => r.id === archiveAsk.id)?.title ?? "this session"}
            branch={archiveAsk.branch}
            onCancel={() => setArchiveAsk(null)}
            onArchive={() => {
              sendSafely({ type: "session.update", session_id: archiveAsk.id, archived: true, force: true });
              setArchiveAsk(null);
            }}
          />
        )}
        {deleteAsk && (
          <DeleteSessionConfirm
            title={recent.find((r) => r.id === deleteAsk)?.title ?? "Untitled session"}
            branch={recent.find((r) => r.id === deleteAsk)?.branch}
            onCancel={() => setDeleteAsk(null)}
            onDelete={() => {
              if (deleteAsk === split) setSplit(null);
              sendSafely({ type: "session.delete", session_id: deleteAsk });
              setDeleteAsk(null);
            }}
          />
        )}
        {settingsPage && (
          <SettingsDialog
            page={settingsPage}
            onPage={openSettings}
            onClose={() => setSettingsPage(null)}
            closeRef={settingsClose}
            configPath={userSettingsInfo?.path ?? null}
            onOpenConfig={
              userSettingsInfo && isTauri() && current?.kind === "local"
                ? () => void openLocalPath(userSettingsInfo.path).catch((e) => setSettingsError(errorText(e)))
                : null
            }
          >
            {settingsPage === "changelog" && <ChangelogPage appVersion={appVersion} />}
            {settingsPage === "appearance" && <AppearanceSettings />}
            {settingsPage === "operating" && (
              <OperatingHarnessSettings
                conn={conn}
                connected={status === "open"}
                values={status === "open" ? userSettings : null}
                error={settingsError}
                onSet={(values) => {
                  setSettingsError(null);
                  sendSafely({ type: "user_settings.set", values });
                }}
              />
            )}
            {settingsPage === "general" && (
              <GeneralSettings
                values={status === "open" ? userSettings : null}
                connected={status === "open"}
                appVersion={appVersion}
                daemonVersion={userSettingsInfo?.version ?? null}
                error={settingsError}
                webKeys={webKeysSaved}
                onSaveWebKey={(provider, key) => void saveWebKeyValue(provider, key)}
                onSet={(values) => {
                  setSettingsError(null);
                  sendSafely({ type: "user_settings.set", values });
                }}
                onManageStorage={status === "open" ? () => setStorageOpen(true) : undefined}
              />
            )}
            {settingsPage === "harness" && (
              <YourHarnessSettings
                values={status === "open" ? userSettings : null}
                connected={status === "open"}
                error={settingsError}
                conn={conn}
                projects={projects}
                currentProject={session?.cwd ?? null}
                onSet={(values) => {
                  setSettingsError(null);
                  sendSafely({ type: "user_settings.set", values });
                }}
              />
            )}
            {settingsPage === "models" && (
              <CookbookScreen
                embedded
                api={cookbook}
                hasSession={session !== null}
                tokenSaved={hfTokenSaved}
                onSaveToken={(token) => void saveHfTokenValue(token)}
                onUseModel={selectProviderModel}
                onReturn={() => setSettingsPage(null)}
              />
            )}
            {settingsPage === "connections" && (
              <ProvidersScreen
                embedded
                modelChoice={
                  <ModelChoice
                    values={status === "open" ? userSettings : null}
                    models={models}
                    providers={providers?.items ?? null}
                    onRequestModels={requestModels}
                    onSet={(values) => {
                      setSettingsError(null);
                      sendSafely({ type: "user_settings.set", values });
                    }}
                  />
                }
                items={providers?.items ?? null}
                path={providers?.path ?? ""}
                host={hello?.hostname ?? null}
                error={providerError}
                test={providerTest}
                hasSession={session !== null}
                onSave={saveProvider}
                onDelete={deleteProvider}
                onEnable={(name, enabled) => sendSafely({ type: "providers.enable", name, enabled })}
                onTest={testProvider}
                onUse={selectProviderModel}
                onReturn={() => setSettingsPage(null)}
                loadKey={(provider) => {
                  const connectionId = currentRef.current?.id;
                  return connectionId ? loadProviderKey(connectionId, provider) : Promise.resolve(null);
                }}
              />
            )}
            {settingsPage === "computers" && (
              <ConnectionsScreen
                embedded
                connections={connections}
                currentId={status === "open" ? (current?.id ?? null) : null}
                connectingId={connectingId}
                error={connError}
                tokenIds={tokenIds}
                canReturn={false}
                hasSession={session !== null}
                onConnect={(c) => void connectTo(c)}
                onSave={saveConnection}
                onDelete={(c) => void deleteConnection(c)}
                onTest={testConnection}
                onReturn={() => setSettingsPage(null)}
              />
            )}
          </SettingsDialog>
        )}
        {storageOpen && settingsPage && (
          <StorageDialog conn={conn} remoteName={current?.kind === "local" ? null : (current?.name ?? null)} onClose={() => setStorageOpen(false)} />
        )}
        {picker && (
          <FolderPicker
            host={hello}
            listing={picker.listing}
            error={picker.error}
            initialPath={picker.initial}
            onNavigate={navigatePicker}
            onSelect={(path) => closePicker(path)}
            onClose={() => closePicker(null)}
          />
        )}
        {screen === "chat" && session && (
          <OpenPathContext.Provider value={openPath}>
            <CardActionsContext.Provider value={cardActions}>
            <div className="split-row" ref={splitRowRef} {...splitDrop.handlers}>
            <div className="session-body">
              <Workspace layout={layout} onChange={setLayout} panes={panes} reveal={reveal} />
              {/* The split pane gets the room of the session rail, as a pane does (V6t). */}
              {rail && view === "code" && !splitShown && (
                <SessionRail
                  key={session.id} // Each session starts with its Context section folded.
                  sessionId={session.id}
                  environment={{
                    placeKind: current?.kind ?? "local",
                    place: current?.kind === "local" || !current ? "This computer" : current.name,
                    placeDetail: hello?.hostname ?? null,
                    folder: folder ?? session.cwd,
                    path: session.cwd,
                    branch: prStatus.get(pathKey(session.cwd))?.branch ?? null,
                    worktree: session.worktree,
                    worktreeOption: loadWorktreeChoice(worktreeKey(current?.id ?? "local", sessionProject(session)?.id)).on,
                  }}
                  context={chat.context ? { tokens: chat.context.tokens, length: chat.context.length } : null}
                  usage={contextUsage}
                  onReadUsage={() => sendSafely({ type: "context.get" })}
                  running={chat.running}
                  onCompact={() => submit({ kind: "command", name: "compact", args: "" })}
                  pr={prStatus.get(pathKey(session.cwd))?.pr ?? null}
                  sessionPrs={sessionPrs}
                  onOpenPr={openLink}
                  servers={servers.items}
                  onOpenServer={(s) => void openServer(s)}
                  onShowServers={() => setLayout((l) => openPane(l, "browser"))}
                  browser={
                    agentTab
                      ? { tab: agentTab.tab, image: null, url: agentTab.url, title: agentTab.title, live: agentTab.live, agent: agentTab.agent }
                      : agentFrame
                        ? { tab: null, image: agentFrame.image, url: agentFrame.url, title: agentFrame.title, live: frameLive, agent: frameLive }
                        : null
                  }
                  onShowBrowser={showAgentBrowser}
                  browserTabs={() => (sessionId ? browserTabsOf(sessionId) : [])}
                  onPickBrowserTab={(id) => sessionId && showTabInRail(sessionId, id)}
                  onCloseBrowser={agentTab ? () => closeTabById(agentTab.tab) : null}
                  changes={gitChanges && samePath(gitChanges.cwd, session.cwd) ? gitChanges : null}
                  onOpenChanges={() => {
                    setReviewId(null); // The pane shows all the changes of the branch, not an old single change.
                    setLayout((l) => openPane(l, "diff"));
                  }}
                  onChangesAction={
                    status === "open" ? (action) => submitOrQueue({ kind: "prompt", text: ACTION_PROMPTS[action], display: ACTION_LABELS[action] }) : null
                  }
                  tasks={tasks ?? []}
                  onShowTasks={() => showPane("tasks")}
                  keepAwake={keepAwake}
                  onKeepAwake={(on) => {
                    if (sendSafely({ type: "session.keep_awake", on })) setKeepAwake(on);
                  }}
                  keepAwakeDisabled={status !== "open"}
                  onClose={closeRail}
                />
              )}
            </div>
            {splitShown && split && (
              <>
                <SplitEdge
                  share={splitShare}
                  row={splitRowRef}
                  onChange={setSplitShare}
                  onDone={(share) => {
                    setSplitShare(share);
                    savePref("split.width", String(share));
                  }}
                />
                <div className="split-slot" style={{ width: `${splitShare * 100}%` }}>
                  <SplitPane
                    sessionId={split}
                    target={status === "open" ? targetRef.current : null}
                    main={conn}
                    focusKey={splitFocus}
                    onClose={() => setSplit(null)}
                    onState={setSplitRunning}
                  />
                </div>
              </>
            )}
            {splitDrop.over && <SplitDropZone />}
            </div>
            </CardActionsContext.Provider>
          </OpenPathContext.Provider>
        )}
      </main>
      </div>
    </div>
  );
}
