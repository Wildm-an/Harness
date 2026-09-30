import { useMemo } from "react";
import { parseUnifiedDiff } from "../lib/diff";

/** "+3 −1": the added and removed line counts of a unified diff. */
export function DiffStats({ diff }: { diff: string }) {
  const { added, removed } = useMemo(() => parseUnifiedDiff(diff), [diff]);
  return <DiffCounts added={added} removed={removed} />;
}

/** "+3 −1" for known counts, for example the sum of the changes in a group of tool calls. */
export function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diff-stats" aria-label={`${added} lines added, ${removed} lines removed`}>
      <span className="stat-add">+{added}</span>
      <span className="stat-del">−{removed}</span>
    </span>
  );
}
