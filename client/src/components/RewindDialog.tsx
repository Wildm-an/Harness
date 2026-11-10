// The Rewind dialog, as in Claude: Esc two times opens it. It lists the messages of the user in the
// session. Up and Down select a message, and Enter or a click goes to the second step: what to restore.

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { ChatItem } from "../chat/state";
import { useOverlay } from "../lib/overlay";
import { REWIND_CHOICES, type RewindOptions } from "./MessageList";

/** The time between the two Esc presses that open the dialog, in milliseconds. */
export const DOUBLE_ESC_MS = 500;

export type RewindTarget = { messageId: string; text: string };

/** The messages that the user can rewind to: the messages of the user with an id. Not the notes of
 *  background tasks. The oldest first, as in the chat. */
export function rewindTargets(items: ChatItem[]): RewindTarget[] {
  const targets: RewindTarget[] = [];
  for (const item of items) {
    if (item.kind !== "user" || !item.messageId || item.origin === "task") continue;
    const text = item.text.replace(/\s+/g, " ").trim();
    targets.push({ messageId: item.messageId, text: text || "(An image)" });
  }
  return targets;
}

export function RewindDialog({ targets, onRewind, onClose }: {
  targets: RewindTarget[];
  onRewind: (messageId: string, options: RewindOptions) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(Math.max(0, targets.length - 1)); // The newest message.
  const [chosen, setChosen] = useState<RewindTarget | null>(null);
  const [choice, setChoice] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useOverlay(true);

  useEffect(() => dialog.current?.focus(), [chosen]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, chosen]);

  const count = chosen ? REWIND_CHOICES.length : targets.length;
  const finish = (options: RewindOptions) => {
    if (!chosen) return;
    onClose();
    onRewind(chosen.messageId, options);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (chosen) setChosen(null);
      else onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!count) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      if (chosen) setChoice((i) => (i + step + count) % count);
      else setIndex((i) => (i + step + count) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (chosen) finish(REWIND_CHOICES[choice].options);
      else if (targets[index]) {
        setChoice(0);
        setChosen(targets[index]);
      }
    }
  };

  return (
    <div className="modal-backdrop rewind-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="modal rewind-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewind-dialog-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="rewind-head">
          {chosen && (
            <button type="button" className="icon-btn ghost" onClick={() => setChosen(null)} aria-label="Back" title="Back (Esc)">
              <ArrowLeft size={16} aria-hidden />
            </button>
          )}
          <h2 id="rewind-dialog-title">Rewind</h2>
          <button type="button" className="icon-btn ghost rewind-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} aria-hidden />
          </button>
        </header>
        {chosen ? (
          <>
            <p className="rewind-help">
              Go back to the time before “<span className="rewind-quote">{chosen.text}</span>”. Changes of commands are
              not restored.
            </p>
            <ul ref={list} className="rewind-list" role="listbox" aria-label="What to restore">
              {REWIND_CHOICES.map((c, i) => (
                <li
                  key={c.label}
                  data-index={i}
                  role="option"
                  aria-selected={i === choice}
                  className={`rewind-item${i === choice ? " selected" : ""}`}
                  onMouseMove={() => setChoice(i)}
                  onClick={() => finish(c.options)}
                >
                  {c.label}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="rewind-help">Restore the session to an earlier message.</p>
            {targets.length === 0 ? (
              <p className="rewind-empty">This session has no messages to rewind to.</p>
            ) : (
              <ul ref={list} className="rewind-list" role="listbox" aria-label="Messages">
                {targets.map((t, i) => (
                  <li
                    key={t.messageId}
                    data-index={i}
                    role="option"
                    aria-selected={i === index}
                    className={`rewind-item${i === index ? " selected" : ""}`}
                    onMouseMove={() => setIndex(i)}
                    onClick={() => {
                      setChoice(0);
                      setChosen(t);
                    }}
                  >
                    {t.text}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
