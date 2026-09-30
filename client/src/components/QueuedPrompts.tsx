// The prompts that wait for the running turn, above the prompt box. The next one goes to the agent
// when the turn ends. "Send now" interrupts the turn and sends the prompt at once.

import { CornerDownRight, SendHorizontal, X } from "lucide-react";

export interface QueuedItem {
  id: string;
  label: string; // The text that the user typed.
}

export function QueuedPrompts({ items, onSendNow, onRemove }: {
  items: QueuedItem[];
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="queued" aria-label={`${items.length} queued ${items.length === 1 ? "message" : "messages"}`}>
      {items.map((item, i) => (
        <li key={item.id} className="queued-item">
          <CornerDownRight size={13} className="queued-icon" aria-hidden />
          <span className="queued-text" title={item.label}>
            {item.label}
          </span>
          {i === 0 && <span className="queued-next">Next</span>}
          <button type="button" className="btn btn-small queued-send" onClick={() => onSendNow(item.id)} title="Interrupt the turn and send this message now">
            <SendHorizontal size={13} aria-hidden /> Send now
          </button>
          <button type="button" className="icon-btn ghost queued-remove" onClick={() => onRemove(item.id)} aria-label={`Remove the queued message: ${item.label}`} title="Remove">
            <X size={13} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
