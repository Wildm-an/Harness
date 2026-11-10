// Skeleton rows while data loads (docs/UI_RULES.md R8, audit M16): gray bars with the height of the
// real rows and a slow pulse. A list that loads again keeps its old rows until the new rows arrive.

import { createContext, useContext } from "react";

// Widths that look like text of different lengths.
const WIDTHS = ["72%", "56%", "84%", "64%", "48%", "76%"];

/** `count` gray bars in a column. `className` gives the height and the space of the real rows. */
export function SkeletonRows({ count = 4, className = "", label = "Loading" }: { count?: number; className?: string; label?: string }) {
  return (
    <div className={`skeleton-list ${className}`} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="skeleton skeleton-row" style={{ width: WIDTHS[i % WIDTHS.length] }} />
      ))}
    </div>
  );
}

/**
 * True while the values of a group of setting rows load. A Row in the group shows a gray bar in place
 * of its control, so a switch does not show "on" first and then change to "off".
 */
export const RowsPending = createContext(false);

export function useRowsPending(): boolean {
  return useContext(RowsPending);
}
