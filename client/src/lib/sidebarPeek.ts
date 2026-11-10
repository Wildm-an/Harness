// The gate for the sidebar peek. A click on "Hide sidebar" leaves the pointer on the toggle, and the
// toggle of the hidden sidebar shows the peek. So the click blocks the peek until the pointer leaves
// the toggle. Ctrl+B does not block it.

export type PeekGateEvent =
  /** A click on the toggle hid the sidebar. */
  | { type: "hide-click" }
  /** The pointer moved. `overToggle` is true when it is on the sidebar toggle. */
  | { type: "pointer"; overToggle: boolean }
  /** The pointer left the toggle. */
  | { type: "leave" };

/** Returns true while the peek is blocked. */
export function peekGate(blocked: boolean, event: PeekGateEvent): boolean {
  switch (event.type) {
    case "hide-click":
      return true;
    case "pointer":
      return blocked && event.overToggle;
    case "leave":
      return false;
  }
}

/** The peek starts only when it is not blocked and no mouse button is down (not during a drag). */
export function canStartPeek(blocked: boolean, buttons: number): boolean {
  return !blocked && buttons === 0;
}
