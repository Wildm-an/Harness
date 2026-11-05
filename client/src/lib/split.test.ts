import { describe, expect, it } from "vitest";
import type { ClientMessage, DaemonMessage } from "../daemon/protocol";
import type { ConnectionStatus } from "../daemon/connection";
import { splitItem } from "../components/SessionRow";
import {
  adoptOnMain,
  clampSplit,
  droppedSession,
  inSplitZone,
  keyForPane,
  SESSION_DRAG,
  setDraggedSession,
  shareAt,
  SPLIT_DEFAULT,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_PILL,
} from "./split";

/** A main connection that records the messages and replies with `reply`. */
function fakeMain(status: ConnectionStatus, reply: ((msg: ClientMessage) => DaemonMessage | null) | null) {
  const listeners = new Set<(msg: DaemonMessage) => void>();
  const sent: ClientMessage[] = [];
  return {
    sent,
    listeners,
    main: {
      status,
      send(msg: ClientMessage) {
        sent.push(msg);
        const answer = reply?.(msg);
        if (answer) queueMicrotask(() => listeners.forEach((fn) => fn(answer)));
      },
      onMessage(fn: (msg: DaemonMessage) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
  };
}

/** A DataTransfer with only the parts that droppedSession reads. */
function data(values: Record<string, string>): DataTransfer {
  return { types: Object.keys(values), getData: (type: string) => values[type] ?? "" } as unknown as DataTransfer;
}

describe("the split view", () => {
  it("keeps the width of the split pane in its limits", () => {
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(0.1)).toBe(SPLIT_MIN);
    expect(clampSplit(0.95)).toBe(SPLIT_MAX);
    expect(clampSplit(Number("x"))).toBe(SPLIT_DEFAULT); // A bad saved value.
  });

  it("gives the split pane the room at the right of the edge", () => {
    expect(shareAt(600, 0, 1000)).toBeCloseTo(0.4);
    expect(shareAt(100, 0, 1000)).toBe(SPLIT_MAX);
    expect(shareAt(950, 0, 1000)).toBe(SPLIT_MIN);
    expect(shareAt(10, 10, 10)).toBe(SPLIT_DEFAULT); // A row with no width.
  });

  it("shows the drop zone only on the right half of the main view", () => {
    expect(inSplitZone(700, 200, 1000)).toBe(true);
    expect(inSplitZone(600, 200, 1000)).toBe(true); // The center line is in the zone.
    expect(inSplitZone(599, 200, 1000)).toBe(false);
    expect(inSplitZone(1001, 200, 1000)).toBe(false);
  });

  it("reads the session id of a dropped row, and ignores other data", () => {
    expect(droppedSession(data({ [SESSION_DRAG]: "s1" }))).toBe("s1");
    expect(droppedSession(data({ "text/plain": "hello" }))).toBeNull();
    // Some drops give the type with no value: the id of the drag start is used.
    setDraggedSession("s2");
    expect(droppedSession(data({ [SESSION_DRAG]: "" }))).toBe("s2");
    setDraggedSession(null);
  });

  it("gives a card key to the pane that has the focus", () => {
    const inPane = (yes: boolean) => ({ closest: (sel: string) => (sel === ".split-pane" && yes ? {} : null) }) as unknown as EventTarget;
    expect(keyForPane(inPane(true), true)).toBe(true);
    expect(keyForPane(inPane(true), false)).toBe(false);
    expect(keyForPane(inPane(false), false)).toBe(true);
    expect(keyForPane(inPane(false), true)).toBe(false);
    expect(keyForPane(null, false)).toBe(true); // No focus: the main pane takes the key.
    expect(keyForPane(null, true)).toBe(false);
  });

  it("uses the drag pill text of the Claude app", () => {
    expect(SPLIT_PILL).toBe("Open in split view");
  });

  it("shows Open in > Split view in the row menu, off for the session of the main view", () => {
    const onOpenSplit = () => undefined;
    expect(splitItem({ onOpenSplit }, false)).toBe("on");
    expect(splitItem({ onOpenSplit }, true)).toBe("off");
    expect(splitItem({}, false)).toBeNull();
  });
});

describe("the hand-over of the split session", () => {
  it("asks the main connection to take the session, and waits for the reply", async () => {
    const { main, sent, listeners } = fakeMain("open", (msg) =>
      msg.type === "session.adopt" ? { type: "session.adopted", id: msg.session_id, moved: true } : null,
    );
    await adoptOnMain(main, "s1");
    expect(sent).toEqual([{ type: "session.adopt", session_id: "s1" }]);
    expect(listeners.size).toBe(0); // The listener goes after the reply.
  });

  it("waits only for the reply about its own session", async () => {
    const { main } = fakeMain("open", () => ({ type: "session.adopted", id: "other", moved: false }));
    const start = Date.now();
    await adoptOnMain(main, "s1", 50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40); // The time limit ended the wait.
  });

  it("does not wait when the main connection is closed", async () => {
    const { main, sent } = fakeMain("closed", null);
    await adoptOnMain(main, "s1");
    expect(sent).toEqual([]);
  });

  it("does not wait when the send fails", async () => {
    const { main, listeners } = fakeMain("open", null);
    main.send = () => {
      throw new Error("closed");
    };
    await adoptOnMain(main, "s1");
    expect(listeners.size).toBe(0);
  });
});
