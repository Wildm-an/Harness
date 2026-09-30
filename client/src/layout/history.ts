// The back and forward history of the app, as in Claude. A place is a screen, and for the chat
// screen also the session.

export type Place =
  | { screen: "start" }
  | { screen: "chat"; id: string }
  | { screen: "cookbook" | "plugins" | "providers" | "connections" };

export interface NavHistory {
  stack: Place[];
  index: number; // The current place in the stack. -1 when the stack is empty.
}

export const emptyHistory: NavHistory = { stack: [], index: -1 };

/** The history keeps this number of places. */
const LIMIT = 50;

export function samePlace(a: Place | undefined, b: Place | undefined): boolean {
  if (!a || !b || a.screen !== b.screen) return false;
  return a.screen !== "chat" || a.id === (b as { id: string }).id;
}

/** The place of a screen, or null for a screen that is not in the history (the "starting" screen). */
export function placeOf(screen: string, sessionId: string | null | undefined): Place | null {
  switch (screen) {
    case "chat":
      return sessionId ? { screen: "chat", id: sessionId } : null;
    case "start":
    case "cookbook":
    case "plugins":
    case "providers":
    case "connections":
      return { screen } as Place;
    default:
      return null;
  }
}

/** Adds a new place after the current place. The places after the current place go away. */
export function visit(h: NavHistory, place: Place): NavHistory {
  if (samePlace(h.stack[h.index], place)) return h;
  const stack = [...h.stack.slice(0, h.index + 1), place].slice(-LIMIT);
  return { stack, index: stack.length - 1 };
}

/** Moves back (-1) or forward (1). Gives null if there is no place in that direction. */
export function step(h: NavHistory, delta: -1 | 1): { history: NavHistory; place: Place } | null {
  const index = h.index + delta;
  const place = h.stack[index];
  return place ? { history: { stack: h.stack, index }, place } : null;
}
