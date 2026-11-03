import { describe, expect, it, vi } from "vitest";
import { findGroupOf, groups, ideLayout, normalize, parseLayout } from "../layout/model";
import { inlineEditPrompt, layoutKey, setViewMode, viewMode } from "./viewMode";

describe("the view mode", () => {
  it("is the Code view when no preference is saved", () => {
    expect(viewMode()).toBe("code");
  });

  it("is the view that the user used last", () => {
    // The tests run with no browser: a storage in memory.
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
      },
    });
    try {
      setViewMode("ide");
      expect(viewMode()).toBe("ide");
      setViewMode("code");
      expect(viewMode()).toBe("code");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the old layout key for the Code view, and a separate key for the IDE view", () => {
    expect(layoutKey("local", "C:/repo", "code")).toBe("layout.local:C:/repo");
    expect(layoutKey("local", "C:/repo", "ide")).toBe("layout.local:C:/repo:ide");
  });

  it("asks the agent to change only the selected code", () => {
    const prompt = inlineEditPrompt("@src/app.py:3-8", "  add type hints ");
    expect(prompt.startsWith("add type hints\n\n")).toBe(true);
    expect(prompt).toContain("@src/app.py:3-8");
  });
});

describe("the IDE layout", () => {
  it("has the files, the editor, the terminal, and the chat, each in its own window", () => {
    const layout = ideLayout();
    expect(groups(layout).map((g) => g.tabs)).toEqual([["files"], ["editor"], ["terminal"], ["chat"]]);
    expect(findGroupOf(layout, "chat")).not.toBeNull();
  });

  it("puts the chat at the right, and the terminal under the editor", () => {
    const layout = ideLayout();
    if (layout.type !== "split") throw new Error("not a split");
    expect(layout.direction).toBe("row");
    const [, middle, right] = layout.children;
    expect(right.type === "group" && right.tabs).toEqual(["chat"]);
    expect(middle.type === "split" && middle.direction).toBe("column");
  });

  it("survives a save and a load", () => {
    const layout = ideLayout();
    const loaded = parseLayout(JSON.parse(JSON.stringify(layout)));
    expect(loaded && groups(normalize(loaded)).map((g) => g.tabs)).toEqual([["files"], ["editor"], ["terminal"], ["chat"]]);
  });
});
