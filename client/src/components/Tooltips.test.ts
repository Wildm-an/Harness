import { describe, expect, it } from "vitest";
import { limitTip, shortTip, splitTip } from "./Tooltips";

describe("splitTip", () => {
  it("takes the key out of the text", () => {
    expect(splitTip("Close the sidebar (Ctrl+B)")).toEqual({ text: "Close the sidebar", keys: "Ctrl+B" });
    expect(splitTip("Terminal (Ctrl+`)")).toEqual({ text: "Terminal", keys: "Ctrl+`" });
    expect(splitTip("Files (Ctrl+Shift+F)")).toEqual({ text: "Files", keys: "Ctrl+Shift+F" });
    expect(splitTip("Deny (Esc or 1)")).toEqual({ text: "Deny", keys: "Esc or 1" });
  });

  it("keeps parentheses that are not a key", () => {
    expect(splitTip("Context: 4k / 32k tokens (12%)")).toEqual({ text: "Context: 4k / 32k tokens (12%)", keys: null });
    expect(splitTip("Connected to host (windows)")).toEqual({ text: "Connected to host (windows)", keys: null });
  });
});

describe("the length of a hover tip", () => {
  it("shows at most 6 lines and 300 characters", () => {
    const file = Array.from({ length: 40 }, (_, i) => `print(${i})`).join("\n");
    expect(limitTip(file).split("\n")).toHaveLength(6);
    expect(limitTip(file).endsWith(" …")).toBe(true);
    expect(limitTip("y".repeat(1000)).length).toBeLessThanOrEqual(161);
    expect(limitTip("Title\nmodel\nWorktree: main")).toBe("Title\nmodel\nWorktree: main"); // A short tip stays.
  });

  it("gives the first line of a long text", () => {
    expect(shortTip("import os\nimport sys\n")).toBe("import os …");
    expect(shortTip("one line")).toBe("one line");
  });
});
