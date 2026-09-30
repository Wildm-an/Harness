// The tool calls in a row, as in Claude: one line that tells what the agent did ("Ran 3 commands,
// edited app.py +6 −0"), and an accordion with one row for each call. A row opens its details.

import { memo, useId, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import type { ToolItem } from "../chat/state";
import { diffTotals, groupSummary, toolAction } from "../chat/toolText";
import { DiffCounts } from "./DiffStats";
import { ToolCard } from "./ToolCard";

export const ToolGroup = memo(function ToolGroup({
  items,
  reviewId,
  onReview,
}: {
  items: ToolItem[];
  reviewId: string | null;
  onReview: (toolId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();

  // One call needs no group: its row is the line.
  if (items.length === 1) {
    return <ToolCard item={items[0]} reviewing={reviewId === items[0].id} onReview={onReview} />;
  }

  const running = items.find((i) => i.status === "running");
  const done = items.filter((i) => i.status !== "running");
  const now = running ? toolAction(running) : null;
  const line = [done.length ? groupSummary(done) : "", now ? `${now.verb} ${now.object}`.trim() + "…" : ""]
    .filter(Boolean)
    .join(" · ");
  const totals = diffTotals(items);

  return (
    <div className={`tool-group${open ? " open" : ""}`}>
      <button type="button" className="tool-group-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        {running && <LoaderCircle size={13} className="tool-state spin" aria-hidden />}
        <span className="tool-group-text">{line}</span>
        {totals && <DiffCounts added={totals.added} removed={totals.removed} />}
        <ChevronRight className="tool-chevron" size={14} aria-hidden />
      </button>
      {open && (
        <div className="tool-group-list" id={listId}>
          {items.map((item) => (
            <ToolCard key={item.id} item={item} reviewing={reviewId === item.id} onReview={onReview} />
          ))}
        </div>
      )}
    </div>
  );
});
