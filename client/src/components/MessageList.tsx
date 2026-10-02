import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, Check, CircleAlert, Copy, Info, RotateCcw, Split, TriangleAlert } from "lucide-react";
import type { ChatItem } from "../chat/state";
import type { Decision } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import type { Submission } from "./PromptBox";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { ToolGroup } from "./ToolGroup";

type NoticeItem = Extract<ChatItem, { kind: "notice" }>;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** The items to show: the tool calls in a row become one group, as in Claude. */
export function groupTools(items: ChatItem[]): (ChatItem | { kind: "tools"; id: string; items: ToolItem[] })[] {
  const out: (ChatItem | { kind: "tools"; id: string; items: ToolItem[] })[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind !== "tool") out.push(item);
    else if (last?.kind === "tools") last.items.push(item);
    else out.push({ kind: "tools", id: `tools-${item.id}`, items: [item] });
  }
  return out;
}

const NOTICE_ICONS = { error: CircleAlert, warning: TriangleAlert, info: Info };

const Notice = memo(function Notice({ item }: { item: NoticeItem }) {
  const Icon = NOTICE_ICONS[item.level];
  return (
    <div className={`notice notice-${item.level}`} role={item.level === "error" ? "alert" : "status"}>
      <Icon size={15} aria-hidden />
      <span>{item.text}</span>
    </div>
  );
});

type SummaryItem = Extract<ChatItem, { kind: "summary" }>;

const SummaryCard = memo(function SummaryCard({ item }: { item: SummaryItem }) {
  const parts: string[] = [];
  if (item.reason === "earlier") parts.push("A summary replaces the earlier messages.");
  else if (item.removed) parts.push(`${item.removed} earlier messages were replaced by a summary.`);
  if (item.trimmed) parts.push(`${item.trimmed} old tool outputs were removed.`);
  const title = item.reason === "auto" ? "The context was compacted" : item.reason === "manual" ? "Context compacted" : "Earlier context";
  return (
    <section className="summary-card" aria-label={title}>
      <header>
        <Archive size={15} aria-hidden />
        <span className="summary-title">{title}</span>
        <span className="summary-meta">{parts.join(" ")}</span>
      </header>
      {item.text && (
        <details>
          <summary>Show the summary</summary>
          <Markdown text={item.text} />
        </details>
      )}
    </section>
  );
});

/** A message that waits for the running turn. The chat shows it after the other messages. */
export interface QueuedItem {
  id: string;
  submission: Submission;
  label: string; // The text that the user typed.
  steering?: boolean; // The daemon has it. The agent reads it at its next step.
}

export type RewindOptions = { conversation: boolean; code: boolean };

type UserItem = Extract<ChatItem, { kind: "user" }>;

function relativeTime(ms: number): string {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

const REWIND_CHOICES: { label: string; options: RewindOptions }[] = [
  { label: "Restore the code and the conversation", options: { conversation: true, code: true } },
  { label: "Restore the conversation", options: { conversation: true, code: false } },
  { label: "Restore the code", options: { conversation: false, code: true } },
];

/** The rewind button and its menu, as in Claude. */
function RewindMenu({ disabled, onRewind, onOpen }: { disabled: boolean; onRewind: (o: RewindOptions) => void; onOpen: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  useEffect(() => onOpen(open), [open]);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div
      className="rewind-menu"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="icon-btn ghost msg-action"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Rewind"
        title={disabled ? "Rewind: wait for the turn to end" : "Rewind"}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <RotateCcw size={14} aria-hidden />
      </button>
      {open && (
        <div className="menu rewind-dropdown" role="menu" aria-label="Rewind">
          <p className="menu-note">Go back to the time before this message. Changes of commands are not restored.</p>
          {REWIND_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onRewind(c.options);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A user message. On hover: the time, Copy, Rewind, and Fork. */
const UserMessage = memo(function UserMessage({ item, running, onRewind, onFork }: {
  item: UserItem;
  running: boolean;
  onRewind: (messageId: string, options: RewindOptions) => void;
  onFork: (messageId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(item.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  const messageId = item.messageId;
  return (
    <div className={`msg-user-wrap${menuOpen ? " menu-open" : ""}`}>
      <div className="msg-user">{item.text}</div>
      <div className="msg-actions">
        {item.ts !== undefined && (
          <span className="msg-time" title={new Date(item.ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}>
            {relativeTime(item.ts)}
          </span>
        )}
        <button type="button" className="icon-btn ghost msg-action" aria-label="Copy" title={copied ? "Copied" : "Copy"} onClick={copy}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
        {messageId && <RewindMenu disabled={running} onRewind={(o) => onRewind(messageId, o)} onOpen={setMenuOpen} />}
        {messageId && (
          <button
            type="button"
            className="icon-btn ghost msg-action"
            aria-label="Fork from here"
            title="Fork: a new session with the conversation before this message"
            onClick={() => onFork(messageId)}
          >
            <Split size={14} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
});

/** A queued message. On hover: Remove, and Send now (it interrupts the turn). */
function QueuedMessage({ item, onSendNow, onRemove }: { item: QueuedItem; onSendNow: (id: string) => void; onRemove: (id: string) => void }) {
  return (
    <div className="msg-user-wrap queued">
      <div className="msg-user">{item.label}</div>
      <div className="msg-actions">
        {item.steering && <span className="msg-time" title="The agent reads this message at its next step.">Steering</span>}
        {!item.steering && (
          <button type="button" className="msg-text-btn" onClick={() => onRemove(item.id)}>
            Remove
          </button>
        )}
        <button type="button" className="msg-text-btn" title="Interrupt the turn and send this message now" onClick={() => onSendNow(item.id)}>
          Send now
        </button>
      </div>
    </div>
  );
}

// Distance from the bottom, in pixels, inside which the list follows new output.
const FOLLOW_THRESHOLD = 80;

export function MessageList({
  items,
  queued = [],
  running = false,
  reviewId,
  onDecide,
  onReview,
  onSendNow = () => {},
  onRemoveQueued = () => {},
  onRewind = () => {},
  onFork = () => {},
  emptyHint,
}: {
  items: ChatItem[];
  queued?: QueuedItem[]; // The messages that wait for the running turn.
  running?: boolean; // A turn runs: rewind waits for its end.
  reviewId: string | null; // The item that the diff review pane shows.
  onDecide: (requestId: string, decision: Decision) => void;
  onReview: (itemId: string) => void;
  onSendNow?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  onRewind?: (messageId: string, options: RewindOptions) => void;
  onFork?: (messageId: string) => void;
  emptyHint: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastTop = useRef(0);

  // Follow the stream only if the user did not scroll up to read.
  // A layout effect scrolls before paint, so a late scroll event never sees a gap.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow.current) {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    }
  }, [items, queued]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
    // Only an upward scroll stops the follow. Scrolls to the bottom start it again.
    if (atBottom) follow.current = true;
    else if (el.scrollTop < lastTop.current) follow.current = false;
    lastTop.current = el.scrollTop;
  };

  return (
    <div className="messages" ref={scroller} onScroll={onScroll} aria-live="polite">
      <div className="column">
        {items.length === 0 && queued.length === 0 && <div className="empty-hint">{emptyHint}</div>}
        {groupTools(items).map((item) => {
          switch (item.kind) {
            case "user":
              return <UserMessage key={item.id} item={item} running={running} onRewind={onRewind} onFork={onFork} />;
            case "assistant":
              return (
                <div key={item.id} className={`msg-assistant${item.streaming ? " streaming" : ""}`}>
                  <Markdown text={item.text} />
                </div>
              );
            case "tools":
              return <ToolGroup key={item.id} items={item.items} reviewId={reviewId} onReview={onReview} />;
            case "tool":
              return null; // In a group.
            case "permission":
              return (
                <PermissionCard
                  key={item.id}
                  item={item}
                  reviewing={reviewId === item.id}
                  onDecide={onDecide}
                  onReview={onReview}
                />
              );
            case "notice":
              return <Notice key={item.id} item={item} />;
            case "summary":
              return <SummaryCard key={item.id} item={item} />;
          }
        })}
        {queued.map((item) => (
          <QueuedMessage key={item.id} item={item} onSendNow={onSendNow} onRemove={onRemoveQueued} />
        ))}
      </div>
    </div>
  );
}
