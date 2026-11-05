import { describe, expect, it } from "vitest";
import { nextFollow, reconcileQueue, type QueuedItem } from "./MessageList";

describe("the list follows the agent", () => {
  it("only when the user is fully at the bottom", () => {
    expect(nextFollow(false, 0, 500, 400)).toBe(true);
    expect(nextFollow(false, 2, 500, 400)).toBe(true);
    // Near the bottom, but not at it: a stopped follow stays stopped.
    expect(nextFollow(false, 40, 460, 400)).toBe(false);
  });

  it("stops at a scroll up, also near the bottom", () => {
    expect(nextFollow(true, 30, 470, 500)).toBe(false);
  });

  it("does not stop when the output grows under a list that follows", () => {
    // The scroll position stays, and the gap grows until the next follow scroll.
    expect(nextFollow(true, 120, 500, 500)).toBe(true);
  });
});

describe("the queue after a return to a session", () => {
  const item = (id: string, steering?: boolean): QueuedItem => ({ id, label: id, steering, submission: { kind: "prompt", text: id } as QueuedItem["submission"] });

  it("drops a taken steer message and sends a returned one as a prompt", () => {
    const list = [item("taken", true), item("returned", true), item("held", true), item("queued")];
    const next = reconcileQueue(list, new Set(["taken"]), ["held"]);
    expect(next.map((i) => [i.id, !!i.steering])).toEqual([["returned", false], ["held", true], ["queued", false]]);
  });

  it("keeps the queue when nothing changed, or with an old daemon", () => {
    const list = [item("held", true)];
    expect(reconcileQueue(list, new Set(), ["held"])).toBe(list);
    expect(reconcileQueue(list, new Set(), undefined)).toBe(list);
  });
});
