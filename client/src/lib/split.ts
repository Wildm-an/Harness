// Split view: a second session at the right of the session that the window shows (docs/UI_RULES.md, V7).
// The user drags a session row from the sidebar to the right half of the main view, or uses
// "Open in" > "Split view" in the row menu.

import { createContext, useContext } from "react";
import type { DaemonConnection } from "../daemon/connection";

/** True inside the split pane. The cards of a pane use it for their keys and for the focus. */
export const InSplitPane = createContext(false);

/** The id of the prompt box of the pane that holds the caller. */
export function usePromptInputId(): string {
  return useContext(InSplitPane) ? SPLIT_PROMPT_ID : MAIN_PROMPT_ID;
}

export const MAIN_PROMPT_ID = "prompt-input";
export const SPLIT_PROMPT_ID = "split-prompt-input";

/**
 * A window key (for example Ctrl+Enter on a card) is for the pane that has the focus. A key with the
 * focus outside both panes (the page body) is for the main pane.
 */
export function keyForPane(target: EventTarget | null, inSplit: boolean): boolean {
  const el = target !== null && typeof (target as Element).closest === "function" ? (target as Element) : null;
  return Boolean(el?.closest(".split-pane")) === inSplit;
}

/** The drag data type of a session row. The value is the session id. */
export const SESSION_DRAG = "application/x-harness-session";

/** The text of the pill that follows the pointer during the drag of a session row (rule S9). */
export const SPLIT_PILL = "Open in split view";

/** The share of the width that the split pane gets: the default and the limits. */
export const SPLIT_DEFAULT = 0.5;
export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.75;
/** The step of the arrow keys on the edge between the panes. */
export const SPLIT_KEY_STEP = 0.05;

/** A share in the limits. A value that is not a number gives the default. */
export function clampSplit(share: number): number {
  if (!Number.isFinite(share)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, share));
}

/** The share of the split pane when the edge is at `x` in a row from `left` to `right`. */
export function shareAt(x: number, left: number, right: number): number {
  const width = right - left;
  if (width <= 0) return SPLIT_DEFAULT;
  return clampSplit((right - x) / width);
}

/** True when the pointer at `x` is on the right half of the area from `left` to `right`: the drop zone. */
export function inSplitZone(x: number, left: number, right: number): boolean {
  return right > left && x >= left + (right - left) / 2 && x <= right;
}

// During a drag the page can read only the types of the data, not the value. The row keeps the
// id here, so the main view can refuse the session that it shows.
let dragged: string | null = null;

export function setDraggedSession(id: string | null): void {
  dragged = id;
}

export function draggedSession(): string | null {
  return dragged;
}

/** Starts the drag of a session row: the data, and a pill with "Open in split view" under the pointer. */
export function startSessionDrag(e: React.DragEvent, id: string): void {
  setDraggedSession(id);
  e.dataTransfer.setData(SESSION_DRAG, id);
  e.dataTransfer.effectAllowed = "move";
  const pill = document.createElement("div");
  pill.className = "drag-pill";
  pill.textContent = SPLIT_PILL;
  document.body.appendChild(pill);
  e.dataTransfer.setDragImage(pill, -12, -8);
  // The browser copies the pill at once. The element can go after this event.
  window.setTimeout(() => pill.remove(), 0);
}

/** The id of a dropped session row, or null for other data. */
export function droppedSession(data: DataTransfer): string | null {
  return data.types.includes(SESSION_DRAG) ? data.getData(SESSION_DRAG) || dragged : null;
}

const ADOPT_TIMEOUT_MS = 5_000;

/**
 * The main connection takes the session of the split pane, before the split pane closes its own
 * connection. A close of a connection stops its turns: this keeps a running turn. Resolves when the
 * daemon replies, or after a time limit, or at once when the main connection is closed.
 */
export function adoptOnMain(main: Pick<DaemonConnection, "status" | "send" | "onMessage">, id: string, timeoutMs = ADOPT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    if (main.status !== "open") {
      resolve();
      return;
    }
    let off = () => {};
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    off = main.onMessage((msg) => {
      if (msg.type === "session.adopted" && msg.id === id) done();
    });
    try {
      main.send({ type: "session.adopt", session_id: id });
    } catch {
      done();
    }
  });
}
