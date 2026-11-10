import { describe, expect, it } from "vitest";
import { inTabOrder } from "./tauri";

/** A call that ends when the test says so, and records when it starts and ends. */
function gate(log: string[], name: string) {
  let open = () => {};
  let fail = () => {};
  const call = () => {
    log.push(`start ${name}`);
    return new Promise<void>((resolve, reject) => {
      open = () => {
        log.push(`end ${name}`);
        resolve();
      };
      fail = () => {
        log.push(`fail ${name}`);
        reject(new Error(name));
      };
    });
  };
  return { call, end: () => open(), fail: () => fail() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the webview calls of a browser tab", () => {
  it("move the webview only after it is made", async () => {
    // The bug: the pane moved while the webview of a new tab was being made. The move did nothing,
    // and the webview stayed over the chat.
    const log: string[] = [];
    const open = gate(log, "open");
    const move = gate(log, "move");
    const opened = inTabOrder("t1", open.call);
    const moved = inTabOrder("t1", move.call);
    await tick();
    expect(log).toEqual(["start open"]);
    open.end();
    await opened;
    await tick();
    expect(log).toEqual(["start open", "end open", "start move"]);
    move.end();
    await moved;
  });

  it("go on after a call that fails, and give each caller its own result", async () => {
    const log: string[] = [];
    const open = gate(log, "open");
    const show = gate(log, "show");
    const opened = inTabOrder("t2", open.call);
    const shown = inTabOrder("t2", show.call);
    await tick();
    open.fail();
    await expect(opened).rejects.toThrow("open");
    await tick();
    show.end();
    await expect(shown).resolves.toBeUndefined();
    expect(log).toEqual(["start open", "fail open", "start show", "end show"]);
  });

  it("do not wait for the calls of other tabs", async () => {
    const log: string[] = [];
    const slow = gate(log, "slow");
    void inTabOrder("a", slow.call);
    await inTabOrder("b", async () => void log.push("b"));
    expect(log).toEqual(["start slow", "b"]);
    slow.end();
  });
});
