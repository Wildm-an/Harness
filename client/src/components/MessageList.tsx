import { memo, useLayoutEffect, useRef } from "react";
import { Archive, CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ChatItem } from "../chat/state";
import type { Decision } from "../daemon/protocol";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { ToolCard } from "./ToolCard";

type NoticeItem = Extract<ChatItem, { kind: "notice" }>;

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

// Distance from the bottom, in pixels, inside which the list follows new output.
const FOLLOW_THRESHOLD = 80;

export function MessageList({
  items,
  reviewId,
  onDecide,
  onReview,
  emptyHint,
}: {
  items: ChatItem[];
  reviewId: string | null; // The item that the diff review pane shows.
  onDecide: (requestId: string, decision: Decision) => void;
  onReview: (itemId: string) => void;
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
  }, [items]);

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
        {items.length === 0 && <div className="empty-hint">{emptyHint}</div>}
        {items.map((item) => {
          switch (item.kind) {
            case "user":
              return (
                <div key={item.id} className="msg-user">
                  {item.text}
                </div>
              );
            case "assistant":
              return (
                <div key={item.id} className={`msg-assistant${item.streaming ? " streaming" : ""}`}>
                  <Markdown text={item.text} />
                </div>
              );
            case "tool":
              return <ToolCard key={item.id} item={item} reviewing={reviewId === item.id} onReview={onReview} />;
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
      </div>
    </div>
  );
}
