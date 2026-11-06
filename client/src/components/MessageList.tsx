import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, ArrowDown, BellRing, Check, CircleAlert, Copy, Info, RotateCcw, Split, TriangleAlert } from "lucide-react";
import type { ChatItem } from "../chat/state";
import type { Decision, PermissionMode, PlanDecision } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { splitAttachmentLines, type Submission } from "./PromptBox";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { QuestionCard } from "./QuestionCard";
import { PlanCard } from "./PlanCard";
import { ToolGroup } from "./ToolGroup";
import { PlanBlock, WrapUpBox } from "./ProgressBlocks";
import { ShareCard } from "./ShareCards";
import { isProgressTool, latestPlan, latestWrapUp } from "../lib/progress";
import { WorkingLine } from "./WorkingLine";
import { VisualBlock } from "./VisualBlock";
import { FileCard } from "./FileCard";
import { isVisualItem, visualOf } from "../lib/visual";
import type { TurnInfo } from "../chat/state";

type NoticeItem = Extract<ChatItem, { kind: "notice" }>;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

type Shown = ChatItem | { kind: "tools"; id: string; items: ToolItem[] };

/**
 * The items to show: the tool calls in a row become one group, as in Claude. A visual is its own item.
 * `previous`: the groups of the last render. A group with the same calls is the same object, so its
 * memoized row does not render again for each new text of the model.
 */
export function groupTools(items: ChatItem[], previous?: Map<string, ToolItem[]>): Shown[] {
  const out: Shown[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (item.kind !== "tool" || isVisualItem(item)) out.push(item);
    else if (last?.kind === "tools") last.items.push(item);
    else out.push({ kind: "tools", id: `tools-${item.id}`, items: [item] });
  }
  if (previous) {
    for (const group of out) {
      if (group.kind !== "tools") continue;
      const old = previous.get(group.id);
      if (old && old.length === group.items.length && old.every((x, i) => x === group.items[i])) group.items = old;
    }
  }
  return out;
}

// One formatter for the hover time of all user messages: a new Intl formatter for each render is slow.
const fullTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

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

/**
 * The queue of a session after "session.ready". The daemon sends "steer.taken" and "steer.returned" only
 * to a window that shows the session, so a window that showed another session can miss them. A steer
 * message that is in the history now goes away. A steer message that the agent does not hold goes back
 * to the queue as a prompt: it goes to the agent when the turn ends. ``steering`` undefined: an old daemon.
 */
export function reconcileQueue(list: QueuedItem[], historyIds: ReadonlySet<string>, steering: readonly string[] | undefined): QueuedItem[] {
  if (!steering) return list;
  const held = new Set(steering);
  let changed = false;
  const next: QueuedItem[] = [];
  for (const item of list) {
    if (item.steering && historyIds.has(item.id)) {
      changed = true; // The agent took it.
    } else if (item.steering && !held.has(item.id)) {
      changed = true; // The turn ended first.
      next.push({ ...item, steering: false });
    } else {
      next.push(item);
    }
  }
  return changed ? next : list;
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

/** The notes of background tasks that the agent got: a line, not a message of the user. */
const TaskNote = memo(function TaskNote({ item }: { item: UserItem }) {
  return (
    <div className="msg-task-note" role="note">
      <BellRing size={13} aria-hidden />
      <span>{item.text}</span>
      {item.ts !== undefined && <span className="msg-time">{relativeTime(item.ts)}</span>}
    </div>
  );
});

/** The pasted images and the attachment chips of a user message, above its text, as in the prompt box. */
function MessageAttachments({ images, chips }: { images?: string[]; chips: { label: string; detail: string }[] }) {
  return (
    <>
      {images && images.length > 0 && (
        <div className="msg-user-images">
          {images.map((src, i) => (
            <a key={i} href={src} target="_blank" rel="noreferrer" title="Open the image">
              <img src={src} alt={`Image ${i + 1}`} />
            </a>
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <ul className="prompt-attachments msg-user-chips" aria-label="Attached context">
          {chips.map((c, i) => (
            <li key={i} className="prompt-attachment" title={`${c.label}: ${c.detail}`}>
              <code>
                <span className="prompt-attachment-label">{c.label}</span> {c.detail}
              </code>
            </li>
          ))}
        </ul>
      )}
    </>
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
  const { text, chips } = splitAttachmentLines(item.text);
  return (
    <div className={`msg-user-wrap${menuOpen ? " menu-open" : ""}`}>
      <MessageAttachments images={item.images} chips={chips} />
      {text && <div className="msg-user">{text}</div>}
      <div className="msg-actions">
        {item.ts !== undefined && (
          <span className="msg-time" title={fullTime.format(new Date(item.ts))}>
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
  const { text, chips } = splitAttachmentLines(item.label);
  return (
    <div className="msg-user-wrap queued">
      <MessageAttachments images={item.submission.kind === "prompt" ? item.submission.images : undefined} chips={chips} />
      {text && <div className="msg-user">{text}</div>}
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

// Distance from the bottom, in pixels, that still counts as "at the bottom" (rounding of the scroll position).
const BOTTOM_SLACK = 2;

/**
 * Follow the agent or not, after a scroll. The list follows new output only when the user is fully
 * at the bottom. A scroll up stops the follow. The programmatic scrolls of the follow only go down.
 */
export function nextFollow(follow: boolean, gap: number, top: number, lastTop: number): boolean {
  if (gap <= BOTTOM_SLACK) return true;
  if (top < lastTop - 1) return false;
  return follow;
}

/**
 * The scroll-to-bottom button shows only when the end of the chat is out of view. While the agent
 * works, the end is its working line: the line counts as seen when its middle is in the list
 * (the user asked for this). With no working line, the end is the bottom of the list.
 * ``view`` and ``line`` are screen rectangles. ``gap`` is the distance from the bottom of the list.
 */
export function endHidden(view: { top: number; bottom: number }, line: { top: number; bottom: number } | null, gap: number): boolean {
  if (line) {
    const middle = (line.top + line.bottom) / 2;
    return middle < view.top || middle > view.bottom;
  }
  return gap > BOTTOM_SLACK;
}

/** The empty queue: one array, so the scroll effect does not run for each render. */
export const NO_QUEUE: QueuedItem[] = [];

export function MessageList({
  items,
  queued = NO_QUEUE,
  running = false,
  reviewId,
  onDecide,
  onReview,
  onAnswer = () => {},
  onPlan = () => {},
  onSendNow = () => {},
  onRemoveQueued = () => {},
  onRewind = () => {},
  onFork = () => {},
  onAction,
  emptyHint,
  turn = null,
  model = "",
  footer,
}: {
  items: ChatItem[];
  queued?: QueuedItem[]; // The messages that wait for the running turn.
  running?: boolean; // A turn runs: rewind waits for its end.
  reviewId: string | null; // The item that the diff review pane shows.
  onDecide: (requestId: string, decision: Decision) => void;
  onReview: (itemId: string) => void;
  onAnswer?: (requestId: string, answers: Record<string, string> | null, notes?: Record<string, string>) => void; // A question card.
  onPlan?: (requestId: string, decision: PlanDecision, mode?: PermissionMode, feedback?: string) => void; // A plan card.
  onSendNow?: (id: string) => void;
  onRemoveQueued?: (id: string) => void;
  onRewind?: (messageId: string, options: RewindOptions) => void;
  onFork?: (messageId: string) => void;
  onAction?: (message: string) => void; // A button of the end-of-turn box: the message is the next prompt.
  emptyHint: React.ReactNode;
  turn?: TurnInfo | null; // The running turn: the working line at the bottom shows its time.
  model?: string;
  footer?: React.ReactNode; // A prompt at the end of the chat, for example "The model is not available".
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const lastTop = useRef(0);
  const groups = useRef<Map<string, ToolItem[]>>(new Map()); // The tool groups of the last render.
  // The "scroll to bottom" button shows when the end of the chat is out of view (endHidden).
  // A scroll up stops the follow, but it does not show the button while the working line is in view.
  const [away, setAway] = useState(false);
  const setFollow = (on: boolean) => {
    follow.current = on;
    if (on) setAway(false);
  };
  const checkAway = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const line = el.querySelector(".working")?.getBoundingClientRect() ?? null;
    // While the list follows the agent (also during the smooth scroll of the button), the end is in view.
    setAway(!follow.current && endHidden(el.getBoundingClientRect(), line, el.scrollHeight - el.scrollTop - el.clientHeight));
  }, []);

  // Another conversation (for example another session): start at the bottom, and follow it.
  const firstId = items[0]?.id;
  useLayoutEffect(() => {
    setFollow(true);
  }, [firstId]);

  // Follow the stream only while the user is at the bottom.
  // A layout effect scrolls before paint, so a late scroll event never sees a gap.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && follow.current) {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    }
    checkAway();
  }, [items, queued, running, checkAway]);

  // A change of size (the window, a pane, or an open tool list) can move the end in or out of view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(checkAway);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [checkAway]);

  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    setFollow(true);
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  // The task list and the end-of-turn box of the agent (update_plan and wrap_up).
  const plan = latestPlan(items);
  const wrap = latestWrapUp(items);

  // During a turn, the tool calls at the end of the chat go into the working line, as in Claude Code:
  // its caret shows them. When the turn ends, they are a group line again.
  // An answered permission card after the tools stays in the chat.
  const shown = groupTools(items.filter((i) => !(i.kind === "tool" && isProgressTool(i.name))), groups.current);
  groups.current = new Map(shown.flatMap((s) => (s.kind === "tools" ? [[s.id, s.items] as const] : [])));
  let at = shown.length - 1;
  while (at >= 0 && shown[at].kind === "permission") {
    const card = shown[at] as Extract<ChatItem, { kind: "permission" }>;
    if (!card.decision && !card.expired) break;
    at--;
  }
  const tail = shown[at];
  const liveTools = running && tail?.kind === "tools" ? tail.items : [];
  if (liveTools.length > 0) shown.splice(at, 1);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const next = nextFollow(follow.current, el.scrollHeight - el.scrollTop - el.clientHeight, el.scrollTop, lastTop.current);
    if (next !== follow.current) setFollow(next);
    lastTop.current = el.scrollTop;
    checkAway();
  };

  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={onScroll}
      // The wheel event comes before the scroll event: the follow stops before the next output can pull the list down.
      onWheel={(e) => {
        if (e.deltaY < 0 && follow.current) setFollow(false);
      }}
      aria-live="polite"
    >
      <div className="column">
        {items.length === 0 && queued.length === 0 && <div className="empty-hint">{emptyHint}</div>}
        {shown.map((item) => {
          switch (item.kind) {
            case "user":
              if (item.origin === "task") return <TaskNote key={item.id} item={item} />;
              return <UserMessage key={item.id} item={item} running={running} onRewind={onRewind} onFork={onFork} />;
            case "assistant":
              return (
                <div key={item.id} className={`msg-assistant${item.streaming ? " streaming" : ""}`}>
                  {item.streaming ? <StreamingMarkdown text={item.text} /> : <Markdown text={item.text} />}
                </div>
              );
            case "tools":
              return <ToolGroup key={item.id} items={item.items} reviewId={reviewId} onReview={onReview} />;
            case "tool": {
              // A visual of the agent (show_visual). Other tool calls are in a group.
              const visual = visualOf(item);
              return visual ? <VisualBlock key={item.id} visual={visual} onPrompt={onAction} /> : null;
            }
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
            case "question":
              return <QuestionCard key={item.id} item={item} onAnswer={onAnswer} />;
            case "plan":
              return <PlanCard key={item.id} item={item} onDecide={onPlan} />;
            case "notice":
              return <Notice key={item.id} item={item} />;
            case "summary":
              return <SummaryCard key={item.id} item={item} />;
            case "file":
              return <FileCard key={item.id} path={item.path} />;
            case "card":
              return <ShareCard key={item.id} card={item.card} />;
          }
        })}
        {/* A sent message that waits shows above the task list, as in the Claude app (the user asked for this). */}
        {queued.map((item) => (
          <QueuedMessage key={item.id} item={item} onSendNow={onSendNow} onRemove={onRemoveQueued} />
        ))}
        {plan && (
          <PlanBlock
            steps={plan.steps}
            running={running && plan.current}
            finished={plan.finished}
            times={plan.times}
            total={plan.total}
            // A plan of an older turn, or a message that the user wrote during the turn: the plan can change.
            stale={!plan.current || (running && queued.length > 0)}
          />
        )}
        {wrap && !running && onAction && <WrapUpBox wrap={wrap} disabled={running} onAction={onAction} />}
        {running && <WorkingLine turn={turn} items={items} model={model} tools={liveTools} reviewId={reviewId} onReview={onReview} />}
        {footer}
        {away && items.length > 0 && (
          <div className="scroll-bottom-wrap">
            <button
              type="button"
              className={`scroll-bottom${running ? " active" : ""}`}
              onClick={toBottom}
              // No hover tip (the user asked for this). The label is for screen readers.
              aria-label={running ? "Scroll to the agent" : "Scroll to bottom"}
            >
              {running ? (
                <>
                  {/* The dots show that the agent works. On hover, an arrow shows the jump to it. */}
                  <span className="scroll-bottom-dots" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                  <ArrowDown size={16} aria-hidden className="scroll-bottom-jump" />
                </>
              ) : (
                <ArrowDown size={16} aria-hidden />
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
