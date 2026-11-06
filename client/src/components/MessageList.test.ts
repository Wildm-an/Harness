import { describe, expect, it } from "vitest";
import type { ChatItem } from "../chat/state";
import { endHidden, groupTools, nextFollow, reconcileQueue, unreadMessages, type QueuedItem } from "./MessageList";

describe("groupTools", () => {
  const tool = (id: string): ChatItem => ({ kind: "tool", id, name: "bash", input: {}, status: "done" });

  it("gives the same calls array again, so a memoized group does not render again", () => {
    const items = [tool("a"), tool("b"), { kind: "assistant", id: "m", text: "Hi", streaming: true } as ChatItem];
    const first = groupTools(items);
    const previous = new Map(first.flatMap((s) => (s.kind === "tools" ? [[s.id, s.items] as const] : [])));
    const next = groupTools([...items.slice(0, 2), { ...items[2], text: "Hi there" } as ChatItem], previous);
    expect(next[0].kind === "tools" && first[0].kind === "tools" && next[0].items === first[0].items).toBe(true);
    // A new call in the group: a new array.
    const more = groupTools([...items.slice(0, 2), tool("c")], previous);
    expect(more[0].kind === "tools" && more[0].items !== previous.get("tools-a")).toBe(true);
  });
});

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

describe("endHidden", () => {
  const view = { top: 100, bottom: 600 };

  it("hides the button while the working line is in view, also after a scroll up", () => {
    expect(endHidden(view, { top: 300, bottom: 324 }, 0)).toBe(false);
    expect(endHidden(view, { top: 300, bottom: 324 }, 200)).toBe(false);
  });

  it("shows the button when the middle of the working line is out of view", () => {
    expect(endHidden(view, { top: 590, bottom: 614 }, 14)).toBe(true);
    expect(endHidden(view, { top: 70, bottom: 94 }, 600)).toBe(true);
    expect(endHidden(view, { top: 580, bottom: 604 }, 4)).toBe(false);
  });

  it("uses the bottom of the list when no working line shows", () => {
    expect(endHidden(view, null, 0)).toBe(false);
    expect(endHidden(view, null, 2)).toBe(false);
    expect(endHidden(view, null, 40)).toBe(true);
  });
});

describe("unreadMessages", () => {
  const user = (id: string): ChatItem => ({ kind: "user", id, text: "Hi" });
  const reply: ChatItem = { kind: "assistant", id: "a1", text: "Hello", streaming: false };

  it("marks the user messages at the end of a running turn as sent, and the rest as read", () => {
    expect([...unreadMessages([user("u1"), reply, user("u2"), user("u3")], true)]).toEqual(["u3", "u2"]);
    expect(unreadMessages([user("u1"), reply], true).size).toBe(0);
    // No turn runs: the agent read all messages.
    expect(unreadMessages([user("u1"), user("u2")], false).size).toBe(0);
  });
});
