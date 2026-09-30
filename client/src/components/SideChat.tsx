// The side chat (Ctrl+;), as in the Claude Code desktop app: quick questions about the session. The
// agent sees the full context of the session, and nothing of the side chat is added to the session.
// The side chat floats over the chat, or it opens in its own window in the workspace.

import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft, PanelTopOpen, PictureInPicture2, Square, Trash2, X } from "lucide-react";
import type { DaemonConnection } from "../daemon/connection";
import { PaneActions } from "../layout/Workspace";
import { Markdown } from "./Markdown";

export interface SideItem {
  id: string;
  question: string;
  answer: string;
  status: "running" | "done" | "error" | "stopped";
}

export const SIDE_CHAT_HINT =
  "Chat about this session without touching the main thread. The agent sees the full context, and nothing here is added to the session.";

let counter = 0;

/** The side chats of the sessions: the questions and answers, by session id. They stay while the app runs. */
export function useSideChat(conn: DaemonConnection, sessionId: string | null) {
  const [chats, setChats] = useState<Record<string, SideItem[]>>({});
  const items = sessionId ? (chats[sessionId] ?? []) : [];

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type !== "side.token" && msg.type !== "side.done" && msg.type !== "side.error") return;
        const sid = msg.session_id;
        if (!sid) return;
        setChats((all) => {
          const list = all[sid];
          if (!list?.some((i) => i.id === msg.id)) return all;
          const next = list.map((i) => {
            if (i.id !== msg.id || i.status !== "running") return i;
            if (msg.type === "side.token") return { ...i, answer: i.answer + msg.text };
            if (msg.type === "side.done") return { ...i, answer: msg.text || i.answer, status: "done" as const };
            return { ...i, answer: msg.message, status: "error" as const };
          });
          return { ...all, [sid]: next };
        });
      }),
    [conn],
  );

  const ask = useCallback(
    (question: string): boolean => {
      if (!sessionId || !question.trim()) return false;
      const id = `s${Date.now().toString(36)}${(counter++).toString(36)}`;
      // The earlier questions and the answers that ended well go with the question.
      const history = items
        .filter((i) => i.status === "done")
        .flatMap((i) => [
          { role: "user" as const, content: i.question },
          { role: "assistant" as const, content: i.answer },
        ]);
      try {
        conn.send({ type: "side.ask", id, question: question.trim(), history });
      } catch {
        return false;
      }
      setChats((all) => ({ ...all, [sessionId]: [...(all[sessionId] ?? []), { id, question: question.trim(), answer: "", status: "running" }] }));
      return true;
    },
    [conn, sessionId, items],
  );

  const stop = useCallback(() => {
    if (!sessionId) return;
    for (const i of items) {
      if (i.status !== "running") continue;
      try {
        conn.send({ type: "side.cancel", id: i.id });
      } catch {
        // Not connected: the daemon stopped the answer.
      }
    }
    setChats((all) => ({ ...all, [sessionId]: (all[sessionId] ?? []).map((i) => (i.status === "running" ? { ...i, status: "stopped" } : i)) }));
  }, [conn, sessionId, items]);

  const clear = useCallback(() => {
    stop();
    if (sessionId) setChats((all) => ({ ...all, [sessionId]: [] }));
  }, [sessionId, stop]);

  return { items, ask, stop, clear, running: items.some((i) => i.status === "running") };
}

export function SideChat({
  items,
  running,
  onAsk,
  onStop,
  onClear,
  onClose,
  onPopOut,
  onDock,
  focusKey,
}: {
  items: SideItem[];
  running: boolean;
  onAsk: (question: string) => boolean;
  onStop: () => void;
  onClear: () => void;
  onClose?: () => void; // The floating side chat: the × button.
  onPopOut?: () => void; // The floating side chat: open it in its own window.
  onDock?: () => void; // The side chat in its own window: float it over the chat again.
  focusKey?: unknown; // A change puts the focus in the text box.
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const floating = onClose !== undefined;

  useEffect(() => {
    input.current?.focus();
  }, [focusKey]);

  // Keep the newest answer in view while it streams.
  const last = items[items.length - 1];
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, last?.answer.length]);

  const send = () => {
    if (running || !text.trim()) return;
    if (onAsk(text)) setText("");
  };

  const buttons = (
    <>
      {items.length > 0 && (
        <button type="button" className="icon-btn ghost win-btn" onClick={onClear} aria-label="Clear the side chat" title="Clear">
          <Trash2 size={13} aria-hidden />
        </button>
      )}
      {onDock && (
        <button type="button" className="icon-btn ghost win-btn" onClick={onDock} aria-label="Float over the chat" title="Float over the chat">
          <PictureInPicture2 size={13} aria-hidden />
        </button>
      )}
    </>
  );

  return (
    <section
      className={`side-chat${floating ? " floating" : ""}`}
      aria-label="Side chat"
      onKeyDown={(e) => {
        if (e.key === "Escape" && floating) {
          e.stopPropagation();
          if (running) onStop();
          else onClose?.();
        }
      }}
    >
      {floating ? (
        <header className="side-chat-head">
          <span className="side-chat-title">Side chat</span>
          <span className="spacer" />
          {buttons}
          <button type="button" className="icon-btn ghost win-btn" onClick={onPopOut} aria-label="Open in a window" title="Open in a window">
            <PanelTopOpen size={13} aria-hidden />
          </button>
          <button type="button" className="icon-btn ghost win-btn" onClick={onClose} aria-label="Close the side chat" title="Close (Ctrl+;)">
            <X size={14} aria-hidden />
          </button>
        </header>
      ) : (
        <PaneActions>{buttons}</PaneActions>
      )}
      <div className="side-chat-list" ref={list} aria-live="polite">
        <p className="side-chat-hint">{SIDE_CHAT_HINT}</p>
        {items.map((i) => (
          <div key={i.id} className="side-chat-item">
            <p className="side-chat-question">{i.question}</p>
            <div className={`side-chat-answer${i.status === "error" ? " error" : ""}`}>
              {i.answer ? <Markdown text={i.answer} /> : i.status === "running" ? <span className="side-chat-wait">Thinking…</span> : null}
              {i.status === "stopped" && <p className="side-chat-note">Stopped.</p>}
            </div>
          </div>
        ))}
      </div>
      <div className="side-chat-box">
        <label htmlFor={floating ? "side-chat-input" : "side-chat-pane-input"} className="sr-only">
          A quick question about this session
        </label>
        <textarea
          id={floating ? "side-chat-input" : "side-chat-pane-input"}
          ref={input}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask a quick question…"
          spellCheck={false}
        />
        {running ? (
          <button type="button" className="icon-btn stop" onClick={onStop} aria-label="Stop the answer" title="Stop">
            <Square size={11} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button type="button" className="icon-btn send" onClick={send} disabled={!text.trim()} aria-label="Ask (Enter)" title="Ask (Enter)">
            <CornerDownLeft size={15} aria-hidden />
          </button>
        )}
      </div>
    </section>
  );
}
