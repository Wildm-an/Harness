import { describe, expect, it } from "vitest";
import { chatReducer, emptyChat, type ChatItem } from "../chat/state";
import { undoTarget } from "../components/MessageList";
import { errorRoute } from "./errorRoute";
import { formIntoView } from "./formFocus";

const daemon = (msg: unknown) => ({ type: "daemon", msg }) as Parameters<typeof chatReducer>[1];

describe("Undo rewind (rule M3)", () => {
  it("adds the rewind line with the undo button", () => {
    const state = chatReducer(emptyChat, daemon({ type: "rewind.done", text: "Rewound the code. 1 file restored." }));
    const line = state.items[state.items.length - 1];
    expect(line).toMatchObject({ kind: "notice", level: "info", text: "Rewound the code. 1 file restored.", undo: true });
    expect(undoTarget(state.items)).toBe(line.id);
  });

  it("removes the button after the undo", () => {
    let state = chatReducer(emptyChat, daemon({ type: "rewind.done", text: "Rewound the conversation." }));
    state = chatReducer(state, daemon({ type: "rewind.undone", text: "The rewind is undone." }));
    expect(undoTarget(state.items)).toBeNull();
    expect(state.items[state.items.length - 1]).toMatchObject({ kind: "notice", text: "The rewind is undone." });
  });

  it("gives the button only to the last rewind with no user message after it", () => {
    const rewind = (id: string): ChatItem => ({ kind: "notice", id, level: "info", text: "Rewound.", undo: true });
    const user: ChatItem = { kind: "user", id: "u", text: "next" } as ChatItem;
    expect(undoTarget([rewind("a"), rewind("b")])).toBe("b");
    expect(undoTarget([rewind("a"), user])).toBeNull();
    expect(undoTarget([])).toBeNull();
  });

  it("shows an undo error in the chat", () => {
    expect(errorRoute("session.rewind_undo")).toBe("chat");
  });
});

describe("formIntoView", () => {
  it("scrolls the form into view and focuses its first enabled field", () => {
    const calls: string[] = [];
    const field = { focus: () => calls.push("focus") };
    const form = {
      scrollIntoView: () => calls.push("scroll"),
      querySelector: (selector: string) => (selector.includes("input") ? field : null),
    } as unknown as HTMLElement;
    formIntoView(form);
    expect(calls).toEqual(["scroll", "focus"]);
  });
});
