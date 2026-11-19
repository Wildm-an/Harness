// The back and forward history of the app, as in Claude. A place is a screen, and for the chat
// screen also the session. A place can also have an inner place of the page (for example the open
// routine) and the open page of the Settings dialog. The mouse Back button then goes back through
// each step that the user made, as the back button of a browser.

/** The inner place and the Settings page. These fields are the same for each screen. */
export interface PlaceExtra {
  sub?: string; // The inner place of the page, for example "routine-id" on the Routines page.
  settings?: string; // The open page of the Settings dialog, over the screen.
}

export type Place = (
  | { screen: "start" }
  | { screen: "chat"; id: string }
  | { screen: "cookbook" | "plugins" | "providers" | "connections" | "capabilities" | "routines" | "usage" }
) &
  PlaceExtra;

export interface NavHistory {
  stack: Place[];
  index: number; // The current place in the stack. -1 when the stack is empty.
}

export const emptyHistory: NavHistory = { stack: [], index: -1 };

/** The history keeps this number of places. */
const LIMIT = 50;

/** The two places show the same screen (and the same session). The inner place and Settings can be different. */
export function sameScreen(a: Place | undefined, b: Place | undefined): boolean {
  if (!a || !b || a.screen !== b.screen) return false;
  return a.screen !== "chat" || a.id === (b as { id: string }).id;
}

export function samePlace(a: Place | undefined, b: Place | undefined): boolean {
  return sameScreen(a, b) && (a!.sub ?? null) === (b!.sub ?? null) && (a!.settings ?? null) === (b!.settings ?? null);
}

/** The place of a screen, or null for a screen that is not in the history (the "starting" screen). */
export function placeOf(screen: string, sessionId: string | null | undefined, extra: PlaceExtra = {}): Place | null {
  const base = baseOf(screen, sessionId);
  if (!base) return null;
  const place: Place = { ...base };
  if (extra.sub) place.sub = extra.sub;
  if (extra.settings) place.settings = extra.settings;
  return place;
}

function baseOf(screen: string, sessionId: string | null | undefined): Place | null {
  switch (screen) {
    case "chat":
      return sessionId ? { screen: "chat", id: sessionId } : null;
    case "start":
    case "cookbook":
    case "plugins":
    case "providers":
    case "connections":
    case "capabilities":
    case "routines":
    case "usage":
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

/**
 * Replaces the current place, for a place that became another place (a new routine got its id, or the open
 * routine was deleted). When the new place is the same as the place before it, the current place goes away.
 */
export function replace(h: NavHistory, place: Place): NavHistory {
  if (h.index < 0) return visit(h, place);
  if (samePlace(h.stack[h.index - 1], place)) {
    return { stack: [...h.stack.slice(0, h.index), ...h.stack.slice(h.index + 1)], index: h.index - 1 };
  }
  const stack = [...h.stack];
  stack[h.index] = place;
  return { stack, index: h.index };
}

/** Moves back (-1) or forward (1). Gives null if there is no place in that direction. */
export function step(h: NavHistory, delta: -1 | 1): { history: NavHistory; place: Place } | null {
  const index = h.index + delta;
  const place = h.stack[index];
  return place ? { history: { stack: h.stack, index }, place } : null;
}

/**
 * Removes the places of a deleted session. Two same places that become neighbors become one. The
 * current place is the last place that stays at or before the old current place.
 */
export function forget(h: NavHistory, sessionId: string): NavHistory {
  const stack: Place[] = [];
  let index = -1;
  h.stack.forEach((place, i) => {
    const gone = place.screen === "chat" && place.id === sessionId;
    if (!gone && !samePlace(stack[stack.length - 1], place)) stack.push(place);
    if (i <= h.index) index = stack.length - 1;
  });
  return { stack, index };
}
