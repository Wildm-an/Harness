// The icons of the CI checks, as GitHub shows them: a green check, a red X, a yellow circle for a
// running check, a gray skip circle, and a gray stop sign for a cancelled check.
//
// "check-16", "x-16", "dot-fill-16", "skip-16", and "stop-16" are from Primer Octicons 19.42.0
// (https://github.com/primer/octicons), MIT License, Copyright (c) 2026 GitHub Inc. The running icon
// is the ring, the dot, and the turning arc of the checks of GitHub (the dot is "dot-fill-16").

import type { CheckState } from "../daemon/protocol";
import type { CiSummary } from "../lib/pr";

const PATHS: Record<Exclude<CheckState, "pending">, string> = {
  pass: "M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z",
  fail: "M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z",
  skip: "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z",
  cancel: "M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z",
};

const DOT = "M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z";

/** The icon of a CI state in its color (Clear Sight): green passed, vermilion failed, yellow running, gray skipped. */
export function CiIcon({ state, size = 13, className = "" }: { state: CheckState | CiSummary["state"]; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden className={`ci-icon ci-${state}${className ? ` ${className}` : ""}`}>
      {state === "pending" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.4" />
          <path d={DOT} />
          <path className="ci-icon-arc" d="M8 0a8 8 0 0 1 8 8h-2a6 6 0 0 0-6-6Z" />
        </>
      ) : (
        <path d={PATHS[state]} />
      )}
    </svg>
  );
}
