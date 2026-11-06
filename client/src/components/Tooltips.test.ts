import { describe, expect, it } from "vitest";
import { placeTip, limitTip, shortTip, splitTip } from "./Tooltips";

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

describe("placeTip", () => {
  const view = { width: 1000, height: 800 };
  const size = { width: 100, height: 24 };

  it("puts the tip below the element", () => {
    expect(placeTip({ left: 100, top: 100, right: 130, bottom: 130 }, size, view)).toEqual({ left: 65, top: 136 });
  });

  it("puts the tip above the element when the page of the Browser pane is below it", () => {
    const page = { left: 0, top: 140, right: 1000, bottom: 760 };
    expect(placeTip({ left: 100, top: 100, right: 130, bottom: 130 }, size, view, [page]).top).toBe(70);
  });

  it("puts the tip next to a button of the annotation bar under the page", () => {
    const page = { left: 0, top: 40, right: 1000, bottom: 756 };
    const place = placeTip({ left: 400, top: 762, right: 430, bottom: 792 }, size, view, [page]);
    expect(place.left).toBe(436);
    expect(place.top + size.height).toBeGreaterThan(756);
  });
});
