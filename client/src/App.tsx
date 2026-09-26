import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Cpu, Globe, KeyRound, LoaderCircle, Monitor, Plus, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { chatReducer, emptyChat, type PermissionItem } from "./chat/state";
import { DaemonConnection, type ConnectionStatus } from "./daemon/connection";
import type { CommandItem, Decision, DirListing, HostInfo, SessionSummary, SkillDetail } from "./daemon/protocol";
import { ConnectionsScreen } from "./components/ConnectionsScreen";
import { FolderPicker } from "./components/FolderPicker";
import { DiffReview } from "./components/DiffReview";
import { RulesPanel, type Rules } from "./components/RulesPanel";
import { SplitLayout } from "./components/SplitLayout";
import { MessageList } from "./components/MessageList";
import { PromptBox, type Submission } from "./components/PromptBox";
import { SessionStart } from "./components/SessionStart";
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
import { isTauri, pickFolder } from "./lib/tauri";

type Screen = "starting" | "connections" | "start" | "chat";

// The remote folder picker. ``resolve`` returns the selected folder to the session start screen.
interface Picker {
  resolve: (path: string | null) => void;
  initial: string;
  listing: DirListing | null;
  error: string | null;
}

const CONNECTION_ICONS = { local: Monitor, direct: Globe, ssh: KeyRound };

function ConnectionIcon({ connection }: { connection: Connection | null }) {
  const Icon = CONNECTION_ICONS[connection?.kind ?? "local"];
  return <Icon size={13} aria-hidden />;
}

// The content of the side pane: a diff of one chat item, or the permission rules.
type Side = { kind: "diff"; id: string } | { kind: "rules" } | { kind: "skills" } | null;

interface ActiveSession {
  id: string;
  cwd: string;
  model: string;
  title: string | null;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

// The daemon summarizes the old turns at 80% of the context.
const COMPACT_AT = 0.8;

function ContextMeter({ tokens, length }: { tokens: number; length: number }) {
  const share = length > 0 ? Math.min(tokens / length, 1) : 0;
  const level = share >= COMPACT_AT ? "high" : share >= 0.6 ? "mid" : "low";
  return (
    <span
      className={`context-meter context-${level}`}
      title={`About ${tokens} of ${length} tokens. The agent summarizes old turns at ${COMPACT_AT * 100}%. Type /compact to summarize now.`}
    >
      <span className="meter" role="meter" aria-label="Context use" aria-valuemin={0} aria-valuemax={length} aria-valuenow={tokens}>
        <span className="meter-fill" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      Context {formatTokens(tokens)} / {formatTokens(length)}
    </span>
  );
}

export default function App() {
  const conn = useMemo(() => new DaemonConnection(), []);
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
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, emptyChat);
  const [side, setSide] = useState<Side>(null);
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

  // Route daemon messages.
  useEffect(() => {
    const offMessage = conn.onMessage((msg) => {
      switch (msg.type) {
        case "session.ready":
          if (sessionRef.current?.id !== msg.session_id) {
            setSide(null);
            setRules(null);
          }
          setSession({ id: msg.session_id, cwd: msg.cwd, model: msg.model, title: msg.title });
          dispatch({
            type: "load",
            history: msg.history,
            warnings: msg.warnings,
            summary: msg.summary,
            context: { tokens: msg.context_tokens, length: msg.context_length },
          });
          setInstructions(msg.instructions);
          setScreen("chat");
          setBusy(false);
          setStartError(null);
          return;
        case "sessions":
          setSessions(msg.items);
          return;
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
        case "permission.request":
          // Show each change for approval in the diff review pane.
          if (msg.diff) setSide({ kind: "diff", id: msg.request_id });
          break;
        case "error":
          if ((msg.ref === "session.new" || msg.ref === "session.resume") && !sessionRef.current) {
            setStartError(msg.message);
            setBusy(false);
            return;
          }
          if (msg.ref === "permissions.set" || msg.ref === "permissions.get") {
            setRulesBusy(false);
            rulesSaving.current = false;
          }
          if (msg.ref === "skills.get") setSkillDetail(null);
          if (msg.ref === "fs.dirs") {
            setPicker((p) => (p ? { ...p, error: msg.message } : p));
            return;
          }
          break;
        case "command.result":
          if (msg.name === "model" && msg.model) {
            setSession((s) => (s ? { ...s, model: msg.model! } : s));
          }
          if (msg.action === "open_panel" && msg.panel === "skills") {
            setSkillItems(msg.items ?? []);
            setSkillDetail(null);
            setSide({ kind: "skills" });
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
  }, [conn]);

  const afterConnect = useCallback(() => {
    const current = sessionRef.current;
    if (current) {
      conn.send({ type: "session.resume", session_id: current.id });
    } else {
      setScreen("start");
      conn.send({ type: "session.list" });
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
    setSide(null);
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

  const startSession = (cwd: string, model: string) => {
    setBusy(true);
    setStartError(null);
    conn.send({ type: "session.new", cwd, model });
  };

  const resumeSession = (id: string) => {
    setBusy(true);
    setStartError(null);
    conn.send({ type: "session.resume", session_id: id });
  };

  const newSession = () => {
    setSession(null);
    dispatch({ type: "clear" });
    setScreen("start");
    if (conn.status === "open") conn.send({ type: "session.list" });
  };

  const submit = (s: Submission): boolean => {
    try {
      if (s.kind === "prompt") {
        conn.send({ type: "prompt", text: s.text });
        dispatch({ type: "user", text: s.text, startsTurn: true });
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
    setSide({ kind: "rules" });
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
    setSide((current) => (current?.kind === "diff" && current.id === id ? null : { kind: "diff", id }));
  }, []);

  const closeSide = useCallback(() => setSide(null), []);

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

  const openSkills = () => {
    setSkillItems(null);
    setSkillDetail(null);
    setSide({ kind: "skills" });
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

  // The chat item that the diff review pane shows.
  const reviewItem = side?.kind === "diff" ? chat.items.find((i) => i.id === side.id) : undefined;
  const reviewDiff = reviewItem && (reviewItem.kind === "tool" || reviewItem.kind === "permission") ? reviewItem.diff : null;

  let sidePane: React.ReactNode = null;
  if (side?.kind === "rules") {
    sidePane = <RulesPanel rules={rules} busy={rulesBusy} savedAt={rulesSavedAt} onSave={saveRules} onClose={closeSide} />;
  } else if (side?.kind === "skills") {
    sidePane = (
      <SkillsPanel items={skillItems} detail={skillDetail} onOpen={openSkill} onBack={backToSkills} onClose={closeSide} />
    );
  } else if (reviewItem && reviewDiff) {
    sidePane = (
      <DiffReview
        key={reviewItem.id}
        diff={reviewDiff}
        permission={reviewItem.kind === "permission" ? (reviewItem as PermissionItem) : null}
        onDecide={decide}
        onClose={closeSide}
      />
    );
  }

  const folder = session?.cwd.split(/[\\/]/).filter(Boolean).pop();

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <img src="/app-icon.svg" alt="" width={18} height={18} />
          <span>Harness</span>
        </div>
        <div className="titlebar-center" title={session?.cwd}>
          {session && (
            <>
              <span className="mono project">{folder}</span>
              {session.title && <span className="session-title">{session.title}</span>}
            </>
          )}
        </div>
        <div className="titlebar-right">
          {session && (
            <span className="chip mono" title="Model. Change it with /model provider/model.">
              <Cpu size={13} aria-hidden />
              {session.model}
            </span>
          )}
          <button
            type="button"
            className={`conn conn-${status}`}
            onClick={openConnections}
            title={`${status === "open" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected"}${
              hello ? ` to ${hello.hostname} (${hello.platform})` : ""
            }. Open the connections.`}
          >
            <span className="conn-dot" aria-hidden />
            <ConnectionIcon connection={current} />
            <span className="conn-name">{current?.name ?? "No connection"}</span>
            {hello && current?.kind !== "local" && <span className="conn-host mono">{hello.hostname}</span>}
            <span className="sr-only">
              {status === "open" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected"}
            </span>
          </button>
          {screen === "chat" && (
            <button
              type="button"
              className={`btn btn-ghost${side?.kind === "skills" ? " active" : ""}`}
              onClick={side?.kind === "skills" ? closeSide : openSkills}
              aria-pressed={side?.kind === "skills"}
            >
              <Sparkles size={15} aria-hidden />
              Skills
            </button>
          )}
          {screen === "chat" && (
            <button
              type="button"
              className={`btn btn-ghost${side?.kind === "rules" ? " active" : ""}`}
              onClick={side?.kind === "rules" ? closeSide : openRules}
              aria-pressed={side?.kind === "rules"}
            >
              <ShieldCheck size={15} aria-hidden />
              Rules
            </button>
          )}
          {screen === "chat" && (
            <button type="button" className="btn btn-ghost" onClick={newSession}>
              <Plus size={15} aria-hidden />
              New session
            </button>
          )}
        </div>
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
            sessions={sessions}
            busy={busy}
            error={startError}
            onStart={startSession}
            onResume={resumeSession}
            prefScope={current?.id ?? "local"}
            onBrowse={browseFolder}
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
          <SplitLayout
            side={sidePane}
            main={
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
                  reviewId={side?.kind === "diff" ? side.id : null}
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
                    <PromptBox
                      running={chat.running}
                      disabled={status !== "open"}
                      onSubmit={submit}
                      onInterrupt={interrupt}
                      commands={commands}
                      onRequestCommands={requestCommands}
                    />
                    <div className="statusline">
                      {chat.running ? (
                        <span className="working">
                          <LoaderCircle size={13} className="spin" aria-hidden />
                          Working. Press <kbd>Esc</kbd> to interrupt.
                        </span>
                      ) : (
                        <span />
                      )}
                      {chat.context && <ContextMeter tokens={chat.context.tokens} length={chat.context.length} />}
                    </div>
                  </div>
                </div>
              </div>
            }
          />
        )}
      </main>
    </div>
  );
}
