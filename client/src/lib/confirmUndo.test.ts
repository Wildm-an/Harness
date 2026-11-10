import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addErrorToast, addUndoToast, errorRoute, type ErrorToastItem } from "./errorRoute";
import { runningIn } from "../components/TerminalPane";
import type { DaemonConnection } from "../daemon/connection";

describe("addUndoToast (rule R7a)", () => {
  it("keeps only the last undo popup, and the error popups", () => {
    const first = () => {};
    const second = () => {};
    let list: ErrorToastItem[] = addErrorToast([], "A request failed.", 1);
    list = addUndoToast(list, "Archived 3 sessions.", first, 2);
    list = addUndoToast(list, "Cleared the side chat.", second, 3);
    expect(list.map((t) => t.text)).toEqual(["A request failed.", "Cleared the side chat."]);
    expect(list[1].undo).toBe(second);
  });
});

/** A connection that answers term.running with the given reply, or not at all. */
function fakeConn(reply: ((id: string) => unknown) | null, opts: { throws?: boolean } = {}) {
  let listener: ((msg: unknown) => void) | null = null;
  const sent: unknown[] = [];
  const conn = {
    onMessage: (l: (msg: unknown) => void) => {
      listener = l;
      return () => (listener = null);
    },
    send: (msg: { type: string; id: string }) => {
      if (opts.throws) throw new Error("The connection to the daemon is closed.");
      sent.push(msg);
      if (reply) queueMicrotask(() => listener?.(reply(msg.id)));
    },
  } as unknown as DaemonConnection;
  return { conn, sent, listening: () => listener !== null };
}

describe("runningIn", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives the programs of the shell", async () => {
    const f = fakeConn((id) => ({ type: "term.running", id, names: ["node.exe"] }));
    await expect(runningIn(f.conn, "t1")).resolves.toEqual(["node.exe"]);
    expect(f.sent).toEqual([{ type: "term.running", id: "t1" }]);
    expect(f.listening()).toBe(false);
  });

  it("gives nothing for an older daemon, a closed connection, or no answer", async () => {
    const old = fakeConn(() => ({ type: "error", ref: "term.running", message: "Unknown message type" }));
    await expect(runningIn(old.conn, "t1")).resolves.toEqual([]);
    await expect(runningIn(fakeConn(null, { throws: true }).conn, "t1")).resolves.toEqual([]);
    const silent = fakeConn(null);
    const wait = runningIn(silent.conn, "t1", 1500);
    vi.advanceTimersByTime(1500);
    await expect(wait).resolves.toEqual([]);
    expect(silent.listening()).toBe(false);
  });

  it("keeps the error of the check out of the popups", () => {
    expect(errorRoute("term.running")).toBe("quiet");
  });
});
