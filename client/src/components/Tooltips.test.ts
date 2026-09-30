import { describe, expect, it } from "vitest";
import { splitTip } from "./Tooltips";

describe("splitTip", () => {
  it("takes the key out of the text", () => {
    expect(splitTip("Close the sidebar (Ctrl+B)")).toEqual({ text: "Close the sidebar", keys: "Ctrl+B" });
    expect(splitTip("Terminal (Ctrl+`)")).toEqual({ text: "Terminal", keys: "Ctrl+`" });
    expect(splitTip("Files (Ctrl+Shift+F)")).toEqual({ text: "Files", keys: "Ctrl+Shift+F" });
  });

  it("keeps parentheses that are not a key", () => {
    expect(splitTip("Context: 4k / 32k tokens (12%)")).toEqual({ text: "Context: 4k / 32k tokens (12%)", keys: null });
    expect(splitTip("Connected to host (windows)")).toEqual({ text: "Connected to host (windows)", keys: null });
  });
});
