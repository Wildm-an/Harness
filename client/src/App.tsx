import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Code2,
  Files,
  Globe as GlobeIcon,
  Server,
  FileDiff,
  Globe,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  Monitor,
  PanelLeft,
  Plug,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
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
  RunningSession,
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
} from "./lib/providerKeys";
import { CookbookScreen } from "./cookbook/CookbookScreen";
import { McpPanel } from "./components/McpPanel";
import { PluginsScreen, type PendingBuilds } from "./components/PluginsScreen";
import { useCookbook } from "./cookbook/useCookbook";
import { ConnectionsScreen } from "./components/ConnectionsScreen";
import { FolderPicker } from "./components/FolderPicker";
import { DiffReview } from "./components/DiffReview";
import { RulesPanel, type Rules } from "./components/RulesPanel";
import { Workspace, type PaneSpec } from "./layout/Workspace";
import {
  closePane,
  defaultLayout,
  findGroupOf,
  openPane,
  parseLayout,
  togglePane,
  type LayoutNode,
  type PaneId,
} from "./layout/model";
import {
  BACK_SHORTCUT,
  FORWARD_SHORTCUT,
  SIDEBAR_SHORTCUT,
  isSidebarShortcut,
  navShortcut,
  shortcutLabel,
  shortcutPane,
} from "./layout/shortcuts";
import { emptyHistory, placeOf, samePlace, step, visit, type NavHistory, type Place } from "./layout/history";
import { TerminalPane } from "./components/TerminalPane";
import { WorkingLine } from "./components/WorkingLine";
import { SlashIcon } from "./components/SlashIcon";
import { WindowControls, hasWindowControls } from "./components/WindowControls";
import { SIDEBAR_DEFAULT, SidebarResizer, clampSidebar } from "./components/SidebarResizer";
import { saveLastMode } from "./components/ModeMenu";
import { EditorPane } from "./editor/EditorPane";
import { useEditor } from "./editor/useEditor";
import { BrowserPane } from "./browser/BrowserPane";
import { ServerMenu } from "./servers/ServerMenu";
import { ServersPane } from "./servers/ServersPane";
import { useServers } from "./servers/useServers";
import type { AgentFrame, ServerItem } from "./daemon/protocol";
import { parseUnifiedDiff } from "./lib/diff";
import { OpenPathContext } from "./lib/openPath";
import { normalizePath } from "./editor/paths";
import { loadPref, savePref } from "./lib/prefs";
import type { ContextUsage } from "./lib/context";
import { ContextRing } from "./components/ContextRing";
import { MessageList } from "./components/MessageList";
import { PromptBox, type Submission } from "./components/PromptBox";
import { SessionStart } from "./components/SessionStart";
import { Sidebar, pathKey } from "./components/Sidebar";
import { ModelMenu, type ModelList } from "./components/ModelMenu";
import { MODES, ModeMenu, nextMode } from "./components/ModeMenu";
import { SkillsPanel } from "./components/SkillsPanel";
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
import { browserView, forwardCloseAll, forwardOpen, isTauri, pickFolder, revealInExplorer } from "./lib/tauri";
import { FolderMenu } from "./components/FolderMenu";
import { QueuedPrompts } from "./components/QueuedPrompts";
import type { SessionActions } from "./components/SessionRow";

type Screen = "starting" | "connections" | "start" | "chat" | "providers" | "cookbook" | "plugins";

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

// Project files that open in the Browser pane.
const BROWSER_FILE_RE = /\.(html?|pdf|png|jpe?g|gif|svg|webp|avif|mp4|webm|mov|ogg|mp3|wav)$/i;

function layoutKey(connectionId: string, cwd: string): string {
  return `layout.${connectionId}:${cwd}`;
}

/** The saved layout of a project, or the default layout. */
function loadLayout(connectionId: string, cwd: string): LayoutNode {
  try {
    return parseLayout(JSON.parse(loadPref(layoutKey(connectionId, cwd), "null"))) ?? defaultLayout();
  } catch {
    return defaultLayout();
  }
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
  title: string | null;
  project: string | null; // The name of the saved project.
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  const [sessions, setSessions] = useState<{ cwd: string | null; items: SessionSummary[] }>({ cwd: null, items: [] });
  const [recent, setRecent] = useState<SessionSummary[]>([]); // The sessions of all folders (the sidebar).
  const [runningSessions, setRunningSessions] = useState<RunningSession[]>([]); // The sessions with a running turn.
  // The sessions with a turn that ended while the user was in another session (a blue dot in the sidebar).
  // The messages that wait for the running turn, for each session. The next one goes when the turn ends.
  const [queues, setQueues] = useState<Record<string, { id: string; submission: Submission; label: string }[]>>({});
  const showStartRef = useRef<() => void>(() => undefined);
  const [unreadSessions, setUnreadSessions] = useState<Set<string>>(() => new Set());
  const lastRunning = useRef<RunningSession[]>([]);
  const firstPrompt = useRef<string | null>(null); // The task from the start screen, for the new session.
  // The project that the start screen selects: from a "+" in the sidebar, or the last project at the start.
  const [startProject, setStartProject] = useState<{ id: string; key: number } | null>(null);
  const startPicked = useRef(false); // The start screen got the last project after this connection.
  const [fileMatches, setFileMatches] = useState<{ query: string; items: string[] } | null>(null); // The "@" menu.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null); // The context breakdown.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => loadPref("sidebar.open", "1") === "1" && !window.matchMedia(NARROW_QUERY).matches,
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebar(Number(loadPref("sidebar.width", String(SIDEBAR_DEFAULT)))));
  const [session, setSession] = useState<ActiveSession | null>(null);
  // The next prompt that the model predicts after a turn, for the session that got it.
  const [suggestion, setSuggestion] = useState<{ sessionId: string; text: string } | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, emptyChat);
  const [layout, setLayout] = useState<LayoutNode>(defaultLayout);
  const [reviewId, setReviewId] = useState<string | null>(null); // The chat item in the Diff pane.
  const [promptInsert, setPromptInsert] = useState<{ text: string; key: number } | null>(null);
  const [browserRequest, setBrowserRequest] = useState<{ url: string; key: number } | null>(null);
  const [previewServer, setPreviewServer] = useState<string | null>(null); // /preview waits for this server.
  const [filesToken, setFilesToken] = useState<string | null>(null);
  const [agentFrame, setAgentFrame] = useState<(AgentFrame & { key: number }) | null>(null); // The agent browser page.
  const [autoVerify, setAutoVerify] = useState(false);
  const targetRef = useRef<{ host: string; port: number; token: string } | null>(null);
  const [commands, setCommands] = useState<CommandItem[] | null>(null); // The / menu.
  const [skillItems, setSkillItems] = useState<CommandItem[] | null>(null); // The Skills panel.
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null | "loading">(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesSavedAt, setRulesSavedAt] = useState<number | null>(null);
  const rulesSaving = useRef(false);
  const sessionRef = useRef<ActiveSession | null>(null);
  sessionRef.current = session;
  // The Providers screen.
  const [providers, setProviders] = useState<{ items: ProviderItem[]; path: string } | null>(null);
  const [providerTest, setProviderTest] = useState<ProviderTest | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelList | null>(null); // The model menus: the models of the connections that are on.
  const providerWait = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  const providerTestRef = useRef<string | null>(null);
  const returnScreen = useRef<Screen>("start"); // The screen before the Providers screen.
  // The saved projects of the daemon (the start screen).
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const projectWait = useRef<{ resolve: (id: string) => void; reject: (e: Error) => void } | null>(null);

  /** Opens the Providers screen. Uses only refs and state setters: the message handler calls it too. */
  const showProviders = useCallback(() => {
    setScreen((s) => {
      if (s !== "providers") returnScreen.current = s === "chat" || s === "start" ? s : "start";
      return "providers";
    });
    setProviderError(null);
    setProviderTest(null);
    try {
      conn.send({ type: "providers.list" });
    } catch {
      // Not connected. The screen shows the last list.
    }
  }, [conn]);

  const [hfTokenSaved, setHfTokenSaved] = useState(false);
  // The MCP servers of the session (the MCP panel).
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [pendingEdit, setPendingEdit] = useState<{ path: string; key: number } | null>(null); // A file for the editor.

  /** Opens the Cookbook screen (SPEC.md section 7). */
  const showCookbook = useCallback(() => {
    setScreen((s) => {
      if (s !== "cookbook") returnScreen.current = s === "chat" || s === "start" ? s : "start";
      return "cookbook";
    });
  }, []);

  // The Plugins screen (docs/PLUGINS.md).
  const [plugins, setPlugins] = useState<PluginsStatus | null>(null);
  const [pluginError, setPluginError] = useState<string | null>(null);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [pendingBuilds, setPendingBuilds] = useState<PendingBuilds | null>(null); // A DeepSeek install that waits for approval.

  /** Opens the Plugins screen. Uses only refs and state setters: the message handler calls it too. */
  const showPlugins = useCallback(() => {
    setScreen((s) => {
      if (s !== "plugins") returnScreen.current = s === "chat" || s === "start" ? s : "start";
      return "plugins";
    });
    setPluginError(null);
    try {
      conn.send({ type: "plugins.list" });
    } catch {
      // Not connected. The screen shows the last list.
    }
  }, [conn]);

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
          if (sessionRef.current?.id !== msg.session_id) {
            setReviewId(null);
            setRules(null);
            setAgentFrame(null);
            setMcpStatus(null);
            setLayout(loadLayout(currentRef.current?.id ?? "local", msg.cwd));
          }
          setSession({ id: msg.session_id, cwd: msg.cwd, model: msg.model, title: msg.title, project: msg.project?.name ?? null });
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
            const text = firstPrompt.current;
            firstPrompt.current = null;
            conn.send({ type: "prompt", text });
            dispatch({ type: "user", text, startsTurn: true });
          }
          return;
        }
        case "session.title":
          setSession((s) => (s && s.id === msg.id ? { ...s, title: msg.title } : s));
          listRecent();
          return;
        case "prompt.suggestion": {
          const id = sessionRef.current?.id;
          if (id) setSuggestion({ sessionId: id, text: msg.text });
          return;
        }
        case "session.updated":
          setSession((s) => (s && s.id === msg.id ? { ...s, title: msg.title } : s));
          listRecent();
          return;
        case "session.deleted":
          if (sessionRef.current?.id === msg.id) showStartRef.current();
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
          listRecent();
          return;
        case "sessions.running":
          setRunningSessions(msg.items);
          listRecent(); // A turn in the background changes the title and the age of its session.
          return;
        case "sessions":
          // A list with no folder is the sidebar list. The start screen asks for the list of one folder.
          if (msg.cwd) setSessions({ cwd: msg.cwd, items: msg.items });
          else setRecent(msg.items);
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
          setModels({ items: msg.items.map((i) => `${i.provider}/${i.model}`), errors: msg.errors });
          return;
        case "preview.frame": {
          const { type: _type, ...frame } = msg;
          setAgentFrame((f) => ({ ...frame, key: (f?.key ?? 0) + 1 }));
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
          if (status.installed) setPendingBuilds(null);
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
        case "mcp.init":
          setPendingEdit((p) => ({ path: msg.path, key: (p?.key ?? 0) + 1 }));
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
          if (msg.ref === "mcp.restart" || msg.ref === "mcp") setMcpBusy(false);
          if (msg.ref?.startsWith("plugins.")) {
            setPluginBusy(false);
            setPluginError(msg.message);
            const keys = msg.data?.pending_builds;
            setPendingBuilds(msg.ref === "plugins.install" && keys?.length && msg.data?.source ? { source: msg.data.source, keys } : null);
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
          if (msg.ref === "fs.dirs") {
            setPicker((p) => (p ? { ...p, error: msg.message } : p));
            return;
          }
          break;
        case "command.result":
          if (msg.name === "model" && msg.model) {
            setSession((s) => (s ? { ...s, model: msg.model! } : s));
          }
          if (msg.action === "open_panel" && msg.panel === "servers") {
            setLayout((l) => openPane(l, "servers"));
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
          if (msg.action === "open_panel" && msg.panel === "mcp") {
            setLayout((l) => openPane(l, "mcp"));
            conn.send({ type: "mcp.list" });
            return;
          }
          if (msg.action === "open_panel" && msg.panel === "skills") {
            setSkillItems(msg.items ?? []);
            setSkillDetail(null);
            setLayout((l) => openPane(l, "skills"));
            return;
          }
          break;
      }
      dispatch({ type: "daemon", msg });
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
  }, [conn, showProviders, showCookbook, showPlugins, syncProviderKeys, listRecent]);

  const afterConnect = useCallback(() => {
    // The daemon lists the providers. The reply makes the app send the keys from the keychain.
    conn.send({ type: "providers.list" });
    conn.send({ type: "projects.list" });
    setRecent([]);
    lastRunning.current = [];
    setRunningSessions([]);
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
    conn.close();
    setSession(null);
    dispatch({ type: "clear" });
    setReviewId(null);
    setCommands(null);
    setHello(null);
    setCurrent(null);
    if (previous) await closeTunnel(previous).catch(() => undefined);
  }, [conn]);

  const connectTo = useCallback(
    async (c: Connection) => {
      setConnectingId(c.id);
      setConnError(null);
      setBusy(true);
      try {
        if (currentRef.current && currentRef.current.id !== c.id) await leave();
        setCurrent(c);
        const target = await resolveTarget(c);
        const { host } = await conn.connect(target.host, target.port, target.token);
        targetRef.current = target;
        setHello(host);
        setLastConnectionId(c.id);
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

  const openConnections = () => setScreen("connections");

  /** The native dialog for this computer. The daemon folder picker for a remote daemon. */
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
  const startSession = (cwd: string, model: string, prompt: string, mode: PermissionMode) => {
    setBusy(true);
    setStartError(null);
    firstPrompt.current = prompt || null;
    conn.send({ type: "session.new", cwd, model, permission_mode: mode });
  };

  const resumeSession = (id: string) => {
    firstPrompt.current = null;
    setBusy(true);
    setStartError(null);
    conn.send({ type: "session.resume", session_id: id });
  };

  // The session that the user sees now. Other sessions get a blue dot when their turn ends.
  const shownId = screen === "chat" ? (session?.id ?? null) : null;
  useEffect(() => {
    const now = new Set(runningSessions.map((r) => r.session_id));
    const ended = lastRunning.current.map((r) => r.session_id).filter((id) => !now.has(id) && id !== shownId);
    lastRunning.current = runningSessions;
    if (ended.length > 0) setUnreadSessions((u) => new Set([...u, ...ended]));
  }, [runningSessions, shownId]);
  useEffect(() => {
    if (!shownId) return;
    setUnreadSessions((u) => {
      if (!u.has(shownId)) return u;
      const next = new Set(u);
      next.delete(shownId);
      return next;
    });
  }, [shownId]);

  const newSession = () => {
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

  /** Opens the start screen with a project selected. A folder that is not a saved project becomes one. */
  const newSessionIn = async (projectId: string | null, name: string, path: string) => {
    try {
      const id = projectId ?? (await saveProject({ name, path }));
      setStartProject((p) => ({ id, key: (p?.key ?? 0) + 1 }));
      newSession();
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

  const listSessions = (cwd: string) => {
    try {
      conn.send({ type: "session.list", cwd });
    } catch {
      // Not connected. The list stays empty.
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
    if (sessionRef.current) {
      sendSafely({ type: "command", name: "model", args: spec });
      setScreen("chat");
    } else {
      savePref(`model.${currentRef.current?.id ?? "local"}`, spec);
      setScreen("start");
    }
  };

  const cookbook = useCookbook(conn, screen === "cookbook" && status === "open");

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

  // The start screen shows the models of the connections that are on.
  useEffect(() => {
    if (screen !== "start" || status !== "open") return;
    requestModels();
  }, [screen, status, conn]);

  const submit = (s: Submission): boolean => {
    setSuggestion(null);
    try {
      if (s.kind === "prompt") {
        conn.send({ type: "prompt", text: s.text, ...(s.display ? { display: s.display } : {}) });
        dispatch({ type: "user", text: s.display ?? s.text, startsTurn: true });
      } else {
        conn.send({ type: "command", name: s.name, args: s.args });
        // /compact runs like a turn: the daemon ends it with turn.end.
        dispatch({ type: "user", text: `/${s.name}${s.args ? ` ${s.args}` : ""}`, startsTurn: s.name === "compact" });
      }
      return true;
    } catch (e) {
      dispatch({ type: "notice", level: "error", text: errorText(e) });
      return false;
    }
  };

  /** A message during a turn waits in the queue. Else it goes to the agent now. */
  const submitOrQueue = (s: Submission): boolean => {
    if (!session || !chat.running) return submit(s);
    const label = s.kind === "prompt" ? (s.display ?? s.text) : `/${s.name}${s.args ? ` ${s.args}` : ""}`;
    const item = { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, submission: s, label };
    setQueues((q) => ({ ...q, [session.id]: [...(q[session.id] ?? []), item] }));
    return true;
  };

  const queue = session ? (queues[session.id] ?? []) : [];

  // When the turn of the shown session ends, the next queued message goes to the agent.
  useEffect(() => {
    if (!session || chat.running || status !== "open" || screen !== "chat") return;
    const next = queues[session.id]?.[0];
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
    interrupt();
  };

  const removeQueued = (id: string) => {
    if (!session) return;
    setQueues((q) => ({ ...q, [session.id]: (q[session.id] ?? []).filter((i) => i.id !== id) }));
  };

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

  const interrupt = () => {
    try {
      conn.send({ type: "interrupt" });
    } catch {
      // The connection is closed. The disconnect notice already shows.
    }
  };

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

  const sendSafely = useCallback(
    (msg: Parameters<DaemonConnection["send"]>[0]) => {
      try {
        conn.send(msg);
        return true;
      } catch (e) {
        dispatch({ type: "notice", level: "error", text: errorText(e) });
        return false;
      }
    },
    [conn],
  );

  const requestCommands = useCallback(() => {
    if (conn.status === "open") conn.send({ type: "skills.list" });
  }, [conn]);

  const openMcp = () => {
    setLayout((l) => openPane(l, "mcp"));
    sendSafely({ type: "mcp.list" });
  };

  const restartMcp = (name?: string) => {
    setMcpBusy(true);
    if (!sendSafely({ type: "mcp.restart", ...(name ? { name } : {}) })) setMcpBusy(false);
  };

  const openSkills = () => {
    setSkillItems(null);
    setSkillDetail(null);
    setLayout((l) => openPane(l, "skills"));
    sendSafely({ type: "command", name: "skills", args: "" });
  };

  const openSkill = useCallback(
    (name: string) => {
      setSkillDetail("loading");
      if (!sendSafely({ type: "skills.get", name })) setSkillDetail(null);
    },
    [sendSafely],
  );

  const backToSkills = useCallback(() => setSkillDetail(null), []);

  // Save the layout for each project (SPEC.md section 8.4).
  useEffect(() => {
    if (session) savePref(layoutKey(currentRef.current?.id ?? "local", session.cwd), JSON.stringify(layout));
  }, [layout, session]);

  const editor = useEditor(conn, session?.id ?? null, session?.cwd ?? "");
  const servers = useServers(conn, session?.id ?? null);

  const showInBrowser = useCallback((url: string) => {
    setBrowserRequest((r) => ({ url, key: (r?.key ?? 0) + 1 }));
    setLayout((l) => openPane(l, "browser"));
  }, []);

  const browserError = useCallback((message: string) => dispatch({ type: "notice", level: "error", text: message }), []);

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
      if (s.state === "starting" && before && before !== "starting" && isTauri() && loadPref("browserKeepData", "true") === "false") {
        void browserView.clearData().catch(() => undefined);
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
      // HTML, PDF, images, and video open in the Browser pane (SPEC.md section 8.6). Other files open in the editor.
      const target = targetRef.current;
      if (BROWSER_FILE_RE.test(path) && target && filesToken) {
        const rel = normalizePath(path, sessionRef.current?.cwd ?? "");
        showInBrowser(`http://${target.host}:${target.port}/files/${filesToken}/${rel.split("/").map(encodeURIComponent).join("/")}`);
        return;
      }
      editor.openFile(path, line);
      setLayout((l) => openPane(l, "editor"));
    },
    [editor.openFile, filesToken, showInBrowser],
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
  const agentLines = useMemo(() => {
    const map = new Map<string, number[]>();
    const lastUser = chat.items.map((i) => i.kind).lastIndexOf("user");
    for (const item of chat.items.slice(lastUser + 1)) {
      if (item.kind !== "tool" || !item.diff) continue;
      const parsed = parseUnifiedDiff(item.diff);
      const lines = parsed.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.newNo!));
      map.set(parsed.path, [...(map.get(parsed.path) ?? []), ...lines]);
    }
    return map;
  }, [chat.items]);

  // The chat item that the diff review pane shows.
  const reviewItem = reviewId ? chat.items.find((i) => i.id === reviewId) : undefined;
  const reviewDiff = reviewItem && (reviewItem.kind === "tool" || reviewItem.kind === "permission") ? reviewItem.diff : null;
  const paneVisible = (pane: PaneId) => findGroupOf(layout, pane)?.active === pane;

  // A Rules or MCP tab from the saved layout has no data yet: load it when the tab shows.
  const rulesShown = session !== null && status === "open" && paneVisible("rules");
  const mcpShown = session !== null && status === "open" && paneVisible("mcp");
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
  useEffect(() => {
    if (!mcpShown || mcpStatus !== null) return;
    try {
      conn.send({ type: "mcp.list" });
    } catch {
      // The panel stays at "Loading" until the connection opens.
    }
  }, [mcpShown, mcpStatus === null]);

  const folder = session?.project ?? session?.cwd.split(/[\\/]/).filter(Boolean).pop();

  // The sessions of the "@" menu: not this session, and the sessions of this project first.
  const mentionSessions = useMemo(() => {
    if (!session) return [];
    const here = pathKey(session.cwd);
    const others = recent.filter((s) => s.id !== session.id);
    return [...others.filter((s) => pathKey(s.cwd) === here), ...others.filter((s) => pathKey(s.cwd) !== here)];
  }, [recent, session?.id, session?.cwd]);

  const chatPane = (
    <div className="chat">
      {status === "closed" && (
        <div className="banner" role="alert">
          <span>The connection to the daemon closed.</span>
          <button type="button" className="btn" onClick={reconnect} disabled={busy}>
            <RefreshCw size={14} aria-hidden />
            Reconnect
          </button>
        </div>
      )}
      <MessageList
        items={chat.items}
        reviewId={paneVisible("diff") ? reviewId : null}
        onDecide={decide}
        onReview={toggleReview}
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
          {chat.running && <WorkingLine turn={chat.turn} items={chat.items} model={session?.model ?? ""} />}
          <QueuedPrompts items={queue} onSendNow={sendNow} onRemove={removeQueued} />
          <PromptBox
            running={chat.running}
            disabled={status !== "open"}
            onSubmit={submitOrQueue}
            onInterrupt={interrupt}
            commands={commands}
            onRequestCommands={requestCommands}
            insert={promptInsert}
            sessions={mentionSessions}
            fileMatches={fileMatches}
            onFindFiles={(query) => sendSafely({ type: "fs.find", query })}
            onCycleMode={() => changeMode(nextMode(permissionMode))}
            suggestion={!chat.running && session && suggestion?.sessionId === session.id ? suggestion.text : null}
            onDismissSuggestion={() => setSuggestion(null)}
            below={
              session && (
                <>
                <ModeMenu mode={permissionMode} onChange={changeMode} />
                <div className="prompt-below-right">
                <ModelMenu
                  value={session.model}
                  models={models}
                  allowDefault={false}
                  up
                  alignRight
                  onOpen={requestModels}
                  onSelect={(spec) => submit({ kind: "command", name: "model", args: spec })}
                  onManage={showProviders}
                />
                {chat.context && (
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
  const panes: Record<PaneId, PaneSpec> = {
    chat: { title: "Chat", icon: MessageSquare, closable: false, render: () => chatPane },
    editor: {
      title: "Files",
      icon: Files,
      closable: true,
      badge: dirtyCount ? <span className="tab-badge" title={`${dirtyCount} unsaved`}>{dirtyCount}</span> : undefined,
      render: () => <EditorPane api={editor} sessionKey={session?.id ?? ""} agentLines={agentLines} onReference={addReference} />,
    },
    diff: {
      title: "Diff",
      icon: FileDiff,
      closable: true,
      render: () =>
        reviewItem && reviewDiff ? (
          <DiffReview
            key={reviewItem.id}
            diff={reviewDiff}
            permission={reviewItem.kind === "permission" ? (reviewItem as PermissionItem) : null}
            onDecide={decide}
            onClose={() => hidePane("diff")}
          />
        ) : (
          <p className="pane-empty">No change to review. The Diff pane shows each change that the agent asks to make.</p>
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
    mcp: {
      title: "MCP",
      icon: Plug,
      closable: true,
      badge: mcpStatus?.items.some((i) => i.state === "failed") ? (
        <span className="tab-badge" title="An MCP server failed">!</span>
      ) : undefined,
      render: () => (
        <McpPanel
          status={mcpStatus}
          busy={mcpBusy}
          onRestart={restartMcp}
          onEditConfig={() => sendSafely({ type: "mcp.init" })}
          onClose={() => hidePane("mcp")}
        />
      ),
    },
    skills: {
      title: "Skills",
      icon: SlashIcon,
      closable: true,
      render: () => (
        <SkillsPanel items={skillItems} detail={skillDetail} onOpen={openSkill} onBack={backToSkills} onClose={() => hidePane("skills")} />
      ),
    },
    terminal: {
      title: "Terminal",
      icon: SquareTerminal,
      closable: true,
      render: () => <TerminalPane conn={conn} sessionKey={session?.id ?? ""} connected={status === "open"} />,
    },
    browser: {
      title: "Browser",
      icon: GlobeIcon,
      closable: true,
      render: () => (
        <BrowserPane
          request={browserRequest}
          servers={servers.items}
          agentFrame={agentFrame}
          onOpenServer={(s) => void openServer(s)}
          onOpenAgentPage={openAgentPage}
          onError={browserError}
        />
      ),
    },
    servers: {
      title: "Servers",
      icon: Server,
      closable: true,
      badge: servers.items.some((s) => s.state === "crashed") ? (
        <span className="tab-badge" title="A server crashed">!</span>
      ) : undefined,
      render: () => (
        <ServersPane
          api={servers}
          autoVerify={autoVerify}
          onAutoVerify={changeAutoVerify}
          onOpenInBrowser={(s) => void openServer(s)}
          onEditConfig={editLaunchConfig}
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
    onResume: (id) => fromSidebar(() => resumeSession(id))(),
    onPin: (id, pinned) => void sendSafely({ type: "session.update", session_id: id, pinned }),
    onMarkUnread: (id, on) =>
      setUnreadSessions((u) => {
        const next = new Set(u);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    onRename: (id, title) => void sendSafely({ type: "session.update", session_id: id, title }),
    onDelete: (id) => void sendSafely({ type: "session.delete", session_id: id }),
  };

  const narrow = () => window.matchMedia(NARROW_QUERY).matches;
  const showSidebar = (open: boolean) => {
    setSidebarOpen(open);
    if (!narrow()) savePref("sidebar.open", open ? "1" : "0");
  };

  // Ctrl+B shows or hides the sidebar on every screen. The capture phase runs before the editor
  // and the terminal get the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSidebarShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      setSidebarOpen(!sidebarOpen);
      if (!window.matchMedia(NARROW_QUERY).matches) savePref("sidebar.open", sidebarOpen ? "0" : "1");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sidebarOpen]);
  /** On a narrow window the sidebar covers the page. Close it after a choice. */
  const fromSidebar = (action: () => void) => () => {
    action();
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
  const titleNav = (
    <div className="title-nav">
      <button
        type="button"
        className="icon-btn ghost"
        onClick={() => showSidebar(!sidebarOpen)}
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

  const statusText = status === "open" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected";

  return (
    <div className={`app${sidebarOpen ? " sidebar-open" : ""}`} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
      {sidebarOpen && (
        <>
          <Sidebar
            sessions={recent}
            running={runningSessions}
            unread={unreadSessions}
            activeId={shownId}
            screen={screen}
            status={status}
            projects={projects ?? []}
            onNewSession={fromSidebar(newSession)}
            onNewSessionIn={(group) => fromSidebar(() => void newSessionIn(group.projectId, group.name, group.path))()}
            actions={sessionActions}
            onLocalModels={fromSidebar(showCookbook)}
            onPlugins={fromSidebar(showPlugins)}
            onConnections={fromSidebar(showProviders)}
            head={titleNav}
            connection={
              <button
                type="button"
                className={`conn conn-${status}${screen === "connections" ? " active" : ""}`}
                onClick={fromSidebar(openConnections)}
                title={`${statusText}${hello ? ` to ${hello.hostname} (${hello.platform})` : ""}. Open the computers.`}
              >
                <span className="conn-dot" aria-hidden />
                <ConnectionIcon connection={current} />
                <span className="conn-text">
                  <span className="conn-name">{current?.name ?? "No connection"}</span>
                  <span className="conn-host">{hello ? `${statusText} · ${hello.hostname}` : statusText}</span>
                </span>
              </button>
            }
          />
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
      <div className="shell">
        <header className={`topbar${hasWindowControls() ? " has-window-controls" : ""}`} data-tauri-drag-region="deep">
          {!sidebarOpen && titleNav}
          <div className="topbar-title" title={session?.cwd}>
            {screen === "chat" && session && (
              <>
                <span className="topbar-name">
                  {/* The daemon gives the title after the first turn. The sidebar list has it. */}
                  {session.title ?? recent.find((r) => r.id === session.id)?.title ?? "New session"}
                </span>
                <FolderMenu
                  name={folder ?? session.cwd}
                  path={session.cwd}
                  canReveal={isTauri() && current?.kind === "local"}
                  canChange={!chat.running && status === "open"}
                  onReveal={() => void revealInExplorer(session.cwd).catch((e) => dispatch({ type: "notice", level: "error", text: errorText(e) }))}
                  onChange={() => void changeFolder()}
                  onOpenTerminal={() => showPane("terminal")}
                />
              </>
            )}
          </div>
          {screen === "chat" && (
            <div className="topbar-actions">
              <ServerMenu
                api={servers}
                onOpenInBrowser={(s) => void openServer(s)}
                onOpenPane={() => setLayout((l) => openPane(l, "servers"))}
              />
              <PaneToggle
                icon={GlobeIcon}
                label={`Browser (${shortcutLabel("browser")})`}
                active={paneVisible("browser")}
                onClick={() => toggleShortcutPane("browser")}
              />
              <PaneToggle
                icon={SquareTerminal}
                label={`Terminal (${shortcutLabel("terminal")})`}
                active={paneVisible("terminal")}
                onClick={() => toggleShortcutPane("terminal")}
              />
              <PaneToggle
                icon={Files}
                label={`Files (${shortcutLabel("editor")})`}
                active={paneVisible("editor")}
                onClick={() => toggleShortcutPane("editor")}
              />
              <PaneToggle icon={SlashIcon} label="Skills" active={paneVisible("skills")} onClick={paneVisible("skills") ? () => hidePane("skills") : openSkills} />
              <PaneToggle
                icon={Plug}
                label={
                  mcpStatus
                    ? `MCP: ${mcpStatus.items.filter((i) => i.state === "connected").length} of ${mcpStatus.items.length} servers connected`
                    : "MCP servers"
                }
                active={paneVisible("mcp")}
                alert={mcpStatus?.items.some((i) => i.state === "failed")}
                onClick={paneVisible("mcp") ? () => hidePane("mcp") : openMcp}
              />
              <PaneToggle icon={ShieldCheck} label="Permission rules" active={paneVisible("rules")} onClick={paneVisible("rules") ? () => hidePane("rules") : openRules} />
            </div>
          )}
          {hasWindowControls() && <WindowControls />}
        </header>

      <main className="main">
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
        {screen === "start" && (
          <SessionStart
            key={current?.id ?? "none"}
            projects={projects}
            sessions={sessions}
            busy={busy}
            error={startError}
            onStart={startSession}
            onResume={resumeSession}
            prefScope={current?.id ?? "local"}
            onBrowse={browseFolder}
            models={models}
            onRequestModels={requestModels}
            onManageProviders={showProviders}
            onSaveProject={saveProject}
            onDeleteProject={deleteProject}
            onListSessions={listSessions}
            selectProject={startProject}
          />
        )}
        {screen === "cookbook" && (
          <CookbookScreen
            api={cookbook}
            hasSession={session !== null}
            tokenSaved={hfTokenSaved}
            onSaveToken={(token) => void saveHfTokenValue(token)}
            onUseModel={selectProviderModel}
            onReturn={() => setScreen(session ? "chat" : "start")}
          />
        )}
        {screen === "plugins" && (
          <PluginsScreen
            status={plugins}
            error={pluginError}
            busy={pluginBusy}
            pendingBuilds={pendingBuilds}
            hasSession={session !== null}
            onInstall={(source, replace, kind, approvedBuilds) => {
              setPluginError(null);
              setPendingBuilds(null);
              const msg = { type: "plugins.install" as const, source, replace, kind, ...(approvedBuilds ? { approved_builds: approvedBuilds } : {}) };
              if (sendSafely(msg)) setPluginBusy(true);
            }}
            onRemove={(name, kind) => {
              setPluginError(null);
              if (sendSafely({ type: "plugins.remove", name, kind })) setPluginBusy(true);
            }}
            onSetBundle={(name, enabled, kind) => sendSafely({ type: "plugins.set_bundle", name, enabled, kind })}
            onSetPlugin={(id, enabled, kind) => sendSafely({ type: "plugins.set_plugin", id, enabled, kind })}
            onDismissBuilds={() => {
              setPendingBuilds(null);
              setPluginError(null);
            }}
            onReload={() => {
              setPluginError(null);
              if (sendSafely({ type: "plugins.reload" })) setPluginBusy(true);
            }}
            onBrowse={(initial) => browseFolder(initial ?? hello?.home ?? "")}
            onReturn={() => setScreen(session ? "chat" : "start")}
          />
        )}
        {screen === "providers" && (
          <ProvidersScreen
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
            onReturn={() => setScreen(session ? "chat" : "start")}
          />
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
            <Workspace layout={layout} onChange={setLayout} panes={panes} reveal={reveal} />
          </OpenPathContext.Provider>
        )}
      </main>
      </div>
    </div>
  );
}
