// The Rewind dialog, as in Claude: Esc two times opens it. It lists the messages of the user in the
// session. Up and Down select a message. Enter or a click rewinds to it: a rewind always restores the
// code and the conversation (the user asked for this).

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ChatItem } from "../chat/state";
import { useOverlay } from "../lib/overlay";

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
  onRewind: (messageId: string) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(Math.max(0, targets.length - 1)); // The newest message.
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useOverlay(true);

  useEffect(() => dialog.current?.focus(), []);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const finish = (target: RewindTarget | undefined) => {
    if (!target) return;
    onClose();
    onRewind(target.messageId);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const count = targets.length;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!count) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (i + step + count) % count);
    } else if (e.key === "Enter") {
      e.preventDefault();
      finish(targets[index]);
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
          <h2 id="rewind-dialog-title">Rewind</h2>
          <button type="button" className="icon-btn ghost rewind-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} aria-hidden />
          </button>
        </header>
        <p className="rewind-help">
          Restore the code and the conversation to the time before a message. Changes of commands are not restored.
        </p>
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
                onClick={() => finish(t)}
              >
                {t.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
