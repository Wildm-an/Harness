// A file change inside an opened tool row: the lines of the unified diff, with the added lines in
// green and the removed lines in red. The Diff pane shows the full review.

import { memo, useMemo } from "react";
import { parseUnifiedDiff } from "../lib/diff";

const MAX_LINES = 400;

export const InlineDiff = memo(function InlineDiff({ diff }: { diff: string }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const lines = parsed.hunks.flatMap((h, i) => [
    { key: `h${i}`, kind: "hunk" as const, text: `@@ line ${h.newStart}${h.header ? ` ${h.header.trim()}` : ""}`, no: undefined },
    ...h.lines.map((l, j) => ({ key: `h${i}-${j}`, kind: l.kind, text: l.text, no: l.kind === "del" ? l.oldNo : l.newNo })),
  ]);
  const shown = lines.slice(0, MAX_LINES);
  return (
    <div className="inline-diff" role="region" aria-label={`The change to ${parsed.path || "the file"}`}>
      {shown.map((l) => (
        <div key={l.key} className={`inline-diff-line ${l.kind}`}>
          <span className="inline-diff-no" aria-hidden>{l.no ?? ""}</span>
          <span className="inline-diff-sign" aria-hidden>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
          <span className="inline-diff-text">{l.text || " "}</span>
        </div>
      ))}
      {lines.length > MAX_LINES && (
        <div className="inline-diff-line hunk">{lines.length - MAX_LINES} more lines. The Diff pane shows the full change.</div>
      )}
    </div>
  );
});
