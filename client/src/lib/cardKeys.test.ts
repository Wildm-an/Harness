import { describe, expect, it } from "vitest";
import { cardKeyAction, cardKeySource, waitingCardHint } from "./cardKeys";
import type { ChatItem } from "../chat/state";

/** A small stand-in for a DOM element: an id, attributes, and the selectors that `closest` finds. */
function el(id: string, opts: { expanded?: boolean; inside?: string[] } = {}): EventTarget {
  return {
    id,
    getAttribute: (name: string) => (name === "aria-expanded" ? String(Boolean(opts.expanded)) : null),
    closest: (selector: string) => ((opts.inside ?? []).some((s) => selector.includes(s)) ? {} : null),
  } as unknown as EventTarget;
}

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, isComposing: false, ...mods }) as KeyboardEvent;

describe("cardKeySource", () => {
  it("finds the prompt box of the pane", () => {
    expect(cardKeySource(el("prompt-input"), "prompt-input")).toBe("prompt");
    // The prompt box of the other pane is a text field: it keeps its keys.
    expect(cardKeySource(el("split-prompt-input", { inside: ["textarea"] }), "prompt-input")).toBeNull();
  });

  it("leaves Esc to an open / or @ menu of the prompt box", () => {
    expect(cardKeySource(el("prompt-input", { expanded: true }), "prompt-input")).toBeNull();
  });

  it("leaves the keys to fields, menus, dialogs, the terminal, and the editor", () => {
    for (const inside of ["input", "textarea", '[role="menu"]', '[role="dialog"]', ".xterm", ".monaco-editor"]) {
      expect(cardKeySource(el("x", { inside: [inside] }), "prompt-input")).toBeNull();
    }
  });

  it("takes keys from the page body and from buttons", () => {
    expect(cardKeySource(el(""), "prompt-input")).toBe("free");
    expect(cardKeySource(null, "prompt-input")).toBe("free");
  });
});

describe("cardKeyAction", () => {
  it("answers with Esc from the prompt box, also with text in the box", () => {
    expect(cardKeyAction(key("Escape"), "prompt", false)).toEqual({ kind: "escape" });
    expect(cardKeyAction(key("Escape"), "free", false)).toEqual({ kind: "escape" });
  });

  it("answers with a number key only while the prompt box is empty", () => {
    expect(cardKeyAction(key("2"), "prompt", true)).toEqual({ kind: "digit", n: 2 });
    expect(cardKeyAction(key("2"), "prompt", false)).toBeNull(); // A number in a message stays text.
    expect(cardKeyAction(key("2"), "free", false)).toEqual({ kind: "digit", n: 2 });
  });

  it("does not take keys with a modifier, a repeat, or an IME composition", () => {
    expect(cardKeyAction(key("1", { ctrlKey: true }), "free", true)).toBeNull();
    expect(cardKeyAction(key("1", { shiftKey: true }), "free", true)).toBeNull();
    expect(cardKeyAction(key("Escape", { repeat: true }), "free", true)).toBeNull();
    expect(cardKeyAction(key("1", { isComposing: true }), "free", true)).toBeNull();
    expect(cardKeyAction(key("Escape", { defaultPrevented: true }), "free", true)).toBeNull();
    expect(cardKeyAction(key("0"), "free", true)).toBeNull();
    expect(cardKeyAction(key("a"), "free", true)).toBeNull();
    expect(cardKeyAction(key("Escape"), null, true)).toBeNull();
  });
});

describe("waitingCardHint", () => {
  const permission = (extra: Partial<Extract<ChatItem, { kind: "permission" }>> = {}): ChatItem =>
    ({ kind: "permission", id: "p", tool: "bash", input: {}, diff: null, rule: "bash(ls)", ...extra }) as ChatItem;

  it("names the keys of the oldest waiting card", () => {
    expect(waitingCardHint([permission()])).toBe("Press 1, 2, or 3 to answer the request, or Esc to deny it.");
    expect(waitingCardHint([permission({ rule: null })])).toBe("Press 1 or 2 to answer the request, or Esc to deny it.");
    expect(waitingCardHint([{ kind: "plan", id: "x", plan: "p" }, permission()])).toBe("Press Ctrl+Enter to accept the plan, or Esc to revise it.");
    expect(waitingCardHint([{ kind: "question", id: "q", questions: [] }])).toBe("Press a number to choose an answer, or Esc to skip the questions.");
  });

  it("gives nothing when no card waits", () => {
    expect(waitingCardHint([])).toBeNull();
    expect(waitingCardHint([permission({ decision: "deny" }), permission({ expired: true })])).toBeNull();
    expect(waitingCardHint([{ kind: "question", id: "q", questions: [], answers: null }])).toBeNull();
  });
});
