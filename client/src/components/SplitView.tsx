// Split view (docs/UI_RULES.md, V7): a second session at the right of the session that the window shows.
// The split pane is a full chat with its own prompt box. It has its own connection to the daemon:
// the daemon sends the events of one session to each connection.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { DaemonConnection, type ConnectionStatus } from "../daemon/connection";
import type { CommandItem, Decision, PermissionMode, PlanDecision, RunningSession } from "../daemon/protocol";
import { chatReducer, emptyChat } from "../chat/state";
import type { ContextUsage } from "../lib/context";
import { modelName } from "../lib/modelName";
import { noImageNote } from "../lib/images";
import {
  adoptOnMain,
  clampSplit,
  InSplitPane,
  draggedSession,
  droppedSession,
  inSplitZone,
  SESSION_DRAG,
  setDraggedSession,
  shareAt,
  SPLIT_DEFAULT,
  SPLIT_KEY_STEP,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_PROMPT_ID,
} from "../lib/split";
import { MessageList, type QueuedItem } from "./MessageList";
import { PromptBox, type Submission } from "./PromptBox";
import { ModeMenu, nextMode } from "./ModeMenu";
import { ContextRing } from "./ContextRing";

export interface DaemonTarget {
  host: string;
  port: number;
  token: string;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The daemon message of a prompt or a command, and the text that the chat shows. */
function toMessage(s: Submission) {
  if (s.kind === "prompt") {
    const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const images = s.images?.length ? s.images : undefined;
    return {
      message: { type: "prompt" as const, text: s.text, id, ...(s.display ? { display: s.display } : {}), ...(images ? { images } : {}) },
      shown: s.display ?? s.text,
      startsTurn: true,
      messageId: id,
      images,
    };
  }
  return {
    message: { type: "command" as const, name: s.name, args: s.args },
    shown: `/${s.name}${s.args ? ` ${s.args}` : ""}`,
    startsTurn: s.name === "compact",
  };
}

interface Shown {
  id: string;
  title: string | null;
  model: string;
  cwd: string;
  folder: string;
}

/** The chat of the split pane. */
export function SplitPane({ sessionId, target, main, focusKey, onClose, onState, onFocus }: {
  sessionId: string;
  target: DaemonTarget | null; // The daemon of the main connection. null: not connected.
  main: DaemonConnection; // The main connection takes the session when the pane closes.
  focusKey?: unknown; // A change puts the focus in the prompt box.
  onClose: () => void;
  onState: (state: RunningSession | null) => void; // The session runs or waits: the sidebar shows it.
  onFocus?: () => void;
}) {
  // A ref, not useMemo: React Fast Refresh runs useMemo again.
  const connRef = useRef<DaemonConnection | null>(null);
  connRef.current ??= new DaemonConnection();
  const conn = connRef.current;
  const [chat, dispatch] = useReducer(chatReducer, emptyChat);
  const [status, setStatus] = useState<ConnectionStatus>(conn.status);
  const [shown, setShown] = useState<Shown | null>(null);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [commands, setCommands] = useState<CommandItem[] | null>(null);
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const shownId = useRef<string | null>(null);
  const stateRef = useRef(onState);
  stateRef.current = onState;

  useEffect(() => {
    const offMessage = conn.onMessage((msg) => {
      switch (msg.type) {
        case "session.ready": {
          shownId.current = msg.session_id;
          setShown({
            id: msg.session_id,
            title: msg.title,
            model: msg.model,
            cwd: msg.cwd,
            folder: msg.project?.name ?? msg.cwd.split(/[\\/]/).filter(Boolean).pop() ?? msg.cwd,
          });
          setMode(msg.permission_mode ?? "default");
          setError(null);
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
          return;
        }
        case "session.title":
        case "session.updated":
          setShown((s) => (s && s.id === msg.id ? { ...s, title: msg.title } : s));
          return;
        case "settings":
          if (msg.permission_mode) setMode(msg.permission_mode);
          return;
        case "skills":
          setCommands(msg.items);
          return;
        case "context.usage": {
          const { type: _type, ...rest } = msg;
          setUsage(rest);
          return;
        }
        case "sessions.running": {
          const id = shownId.current;
          stateRef.current(msg.items.find((r) => r.session_id === id) ?? null);
          return;
        }
      }
      dispatch({ type: "daemon", msg });
    });
    const offStatus = conn.onStatus((s) => {
      setStatus(s);
      if (s === "closed") {
        dispatch({ type: "disconnected" });
        stateRef.current(null);
      }
    });
    return () => {
      offMessage();
      offStatus();
    };
  }, [conn]);

  // Connect, then show the session. Another session (a new drop) replaces the shown session: the
  // main connection takes the old session, so its running turn continues in the background.
  useEffect(() => {
    if (!target) return;
    let gone = false;
    const previous = shownId.current;
    if (previous && previous !== sessionId) {
      void adoptOnMain(main, previous);
      shownId.current = null;
      setShown(null);
      setQueue([]);
      dispatch({ type: "clear" });
    }
    void (async () => {
      try {
        if (conn.status !== "open") await conn.connect(target.host, target.port, target.token);
        if (gone) return;
        conn.send({ type: "session.resume", session_id: sessionId });
      } catch (e) {
        if (!gone) setError(errorText(e));
      }
    })();
    return () => {
      gone = true;
    };
  }, [sessionId, target?.host, target?.port, target?.token, attempt]);

  // The pane closes: the main connection takes the session, then this connection closes. The
  // timer lets a quick mount again (React strict mode) keep the connection.
  const closeTimer = useRef<number | null>(null);
  useEffect(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    return () => {
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        const id = shownId.current;
        // The main connection tells its running sessions before its reply: the sidebar keeps the mark.
        void (id ? adoptOnMain(main, id) : Promise.resolve()).then(() => {
          stateRef.current(null);
          conn.close();
        });
      }, 0);
    };
  }, []);

  const send = useCallback(
    (msg: Parameters<DaemonConnection["send"]>[0]): boolean => {
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

  const submit = (s: Submission): boolean => {
    const { message, shown: text, startsTurn, messageId, images } = toMessage(s);
    if (!send(message)) return false;
    dispatch({ type: "user", text, startsTurn, messageId, images });
    return true;
  };

  /** A message during a turn waits in the queue. Else it goes to the agent now. */
  const submitOrQueue = (s: Submission): boolean => {
    if (!chat.running) return submit(s);
    const label = s.kind === "prompt" ? (s.display ?? s.text) : `/${s.name}${s.args ? ` ${s.args}` : ""}`;
    setQueue((q) => [...q, { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, submission: s, label }]);
    return true;
  };

  // When the turn ends, the next queued message goes to the agent.
  useEffect(() => {
    if (chat.running || status !== "open" || !shown || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    submit(next.submission);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit uses only the connection and dispatch.
  }, [chat.running, queue, status, shown?.id]);

  const interrupt = () => void send({ type: "interrupt" });

  const decide = (requestId: string, decision: Decision) => {
    if (send({ type: "permission.reply", request_id: requestId, decision })) dispatch({ type: "decide", requestId, decision });
  };
  const answer = (requestId: string, answers: Record<string, string> | null, notes?: Record<string, string>) => {
    if (send({ type: "question.reply", request_id: requestId, answers, notes })) dispatch({ type: "answer", requestId, answers, notes });
  };
  const decidePlan = (requestId: string, decision: PlanDecision, planMode?: PermissionMode, feedback?: string) => {
    if (send({ type: "plan.reply", request_id: requestId, decision, mode: planMode, feedback })) dispatch({ type: "plan", requestId, decision, mode: planMode });
  };
  const changeMode = (next: PermissionMode) => {
    if (send({ type: "settings.set", permission_mode: next })) setMode(next);
  };

  const title = shown?.title ?? "Untitled session";
  const open = status === "open" && shown !== null;

  return (
    <InSplitPane.Provider value={true}>
    <section className="split-pane" aria-label={`Split view: ${title}`} onFocusCapture={onFocus} onMouseDown={onFocus}>
      <header className="split-head">
        <span className="split-title" title={title}>
          {title}
        </span>
        {shown && <span className="split-folder">{shown.folder}</span>}
        <button type="button" className="icon-btn ghost split-close" onClick={onClose} aria-label="Close split view" title="Close split view">
          <X size={15} aria-hidden />
        </button>
      </header>
      <div className="chat">
        {(status === "closed" || error) && (
          <div className="banner" role="alert">
            <span>{error ?? "The connection to the daemon closed."}</span>
            <button type="button" className="btn" onClick={() => setAttempt((a) => a + 1)} disabled={!target}>
              <RefreshCw size={14} aria-hidden />
              Reconnect
            </button>
          </div>
        )}
        <MessageList
          items={chat.items}
          queued={queue}
          running={chat.running}
          reviewId={null}
          onDecide={decide}
          onAnswer={answer}
          onPlan={decidePlan}
          onReview={() => undefined}
          onSendNow={(id) => {
            setQueue((q) => {
              const item = q.find((i) => i.id === id);
              return item ? [item, ...q.filter((i) => i.id !== id)] : q;
            });
            interrupt();
          }}
          onRemoveQueued={(id) => setQueue((q) => q.filter((i) => i.id !== id))}
          onRewind={(messageId, options) => void send({ type: "session.rewind", id: messageId, ...options })}
          onAction={(message) => submitOrQueue({ kind: "prompt", text: message })}
          turn={chat.turn}
          model={shown?.model ?? ""}
          emptyHint={
            shown ? (
              <p>
                Ask the agent about <span className="mono">{shown.folder}</span>.
              </p>
            ) : (
              <p className="help">Opening the session…</p>
            )
          }
        />
        <div className="composer">
          <div className="column">
            <PromptBox
              inputId={SPLIT_PROMPT_ID}
              draftKey={shown?.id ?? null}
              running={chat.running}
              disabled={!open}
              onSubmit={submitOrQueue}
              onInterrupt={interrupt}
              commands={commands}
              onRequestCommands={() => void send({ type: "skills.list" })}
              onCycleMode={() => changeMode(nextMode(mode))}
              focusKey={focusKey}
              imageNote={shown && chat.imageInput === false ? noImageNote(modelName(shown.model)) : null}
              below={
                shown && (
                  <>
                    <ModeMenu mode={mode} onChange={changeMode} />
                    <div className="prompt-below-right">
                      <span className="split-model" title={shown.model}>
                        {modelName(shown.model)}
                      </span>
                      {chat.context && (
                        <ContextRing
                          tokens={chat.context.tokens}
                          length={chat.context.length}
                          source={chat.context.source}
                          usage={usage}
                          running={chat.running}
                          onOpen={() => void send({ type: "context.get" })}
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
    </section>
    </InSplitPane.Provider>
  );
}

/** The edge between the panes. Drag it to change the widths. A double-click sets equal widths. */
export function SplitEdge({ share, row, onChange, onDone }: {
  share: number; // The share of the split pane.
  row: React.RefObject<HTMLElement | null>; // The row of the two panes.
  onChange: (share: number) => void; // While the user drags.
  onDone: (share: number) => void; // After the drag, to save the share.
}) {
  const last = useRef<number | null>(null);
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (last.current === null) return;
    const value = last.current;
    last.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing-split");
    onDone(value);
  };
  return (
    <div
      className="split-edge"
      role="separator"
      aria-orientation="vertical"
      aria-label="Split view width"
      aria-valuenow={Math.round(share * 100)}
      aria-valuemin={SPLIT_MIN * 100}
      aria-valuemax={SPLIT_MAX * 100}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        last.current = share;
        document.body.classList.add("resizing-split");
      }}
      onPointerMove={(e) => {
        const r = row.current?.getBoundingClientRect();
        if (last.current === null || !r) return;
        last.current = shareAt(e.clientX, r.left, r.right);
        onChange(last.current);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onDone(SPLIT_DEFAULT)}
      onKeyDown={(e) => {
        // The split pane is on the right: ArrowLeft makes it wider.
        const delta = e.key === "ArrowLeft" ? SPLIT_KEY_STEP : e.key === "ArrowRight" ? -SPLIT_KEY_STEP : 0;
        if (!delta) return;
        e.preventDefault();
        onDone(clampSplit(share + delta));
      }}
    />
  );
}

/** The drop zone over the right half of the main view while the user drags a session row. */
export function SplitDropZone() {
  return (
    <div className="split-drop" aria-hidden>
      <span className="split-drop-label">Split view</span>
    </div>
  );
}

/**
 * The drop of a session row on the main view. The zone shows while the pointer is on the right half.
 * `blockedId`: the session of the main view. It cannot open in the split pane too.
 */
export function useSplitDrop(enabled: boolean, blockedId: string | null, onDrop: (id: string) => void) {
  const [over, setOver] = useState(false);

  // A drag that ends anywhere (Esc, a drop in another place) hides the zone.
  useEffect(() => {
    const end = () => {
      setOver(false);
      setDraggedSession(null);
    };
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
    };
  }, []);

  const accepts = (e: React.DragEvent<HTMLElement>): boolean => {
    if (!enabled || !e.dataTransfer.types.includes(SESSION_DRAG)) return false;
    const id = draggedSession();
    if (id !== null && id === blockedId) return false;
    const r = e.currentTarget.getBoundingClientRect();
    return inSplitZone(e.clientX, r.left, r.right);
  };

  return {
    over,
    handlers: {
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        const ok = accepts(e);
        setOver(ok);
        if (!ok) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      },
      onDragLeave: (e: React.DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: React.DragEvent<HTMLElement>) => {
        if (!accepts(e)) return;
        e.preventDefault();
        setOver(false);
        const id = droppedSession(e.dataTransfer);
        if (id && id !== blockedId) onDrop(id);
      },
    },
  };
}
