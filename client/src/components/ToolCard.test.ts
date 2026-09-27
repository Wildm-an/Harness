import { describe, expect, it } from "vitest";
import { toolSummary } from "./ToolCard";
import { chatReducer, emptyChat, historyToItems } from "../chat/state";

describe("the preview tools in the chat", () => {
  it("summarizes the input of each preview tool", () => {
    expect(toolSummary("preview_navigate", { url: "/about" })).toBe("/about");
    expect(toolSummary("preview_navigate", { url: "/", server: "web" })).toBe("/  on web");
    expect(toolSummary("preview_click", { ref: "e5" })).toBe("e5");
    expect(toolSummary("preview_fill", { ref: "e2", text: "Ada" })).toBe('e2  "Ada"');
    expect(toolSummary("preview_start", { name: "web" })).toBe("web");
    expect(toolSummary("preview_snapshot", {})).toBe("preview_snapshot");
  });

  it("keeps the screenshot of a tool result, live and from the history", () => {
    const image = "data:image/jpeg;base64,AAAA";
    const live = [
      { type: "tool.start", id: "c1", name: "preview_screenshot", input: {} },
      { type: "tool.result", id: "c1", output: "A screenshot.", is_error: false, image },
    ] as const;
    const state = live.reduce((s, msg) => chatReducer(s, { type: "daemon", msg }), emptyChat);
    expect(state.items[0]).toMatchObject({ kind: "tool", status: "done", image });

    const items = historyToItems([
      { role: "user", content: "look" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "preview_screenshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "A screenshot.", image },
    ]);
    expect(items[1]).toMatchObject({ kind: "tool", name: "preview_screenshot", image });
  });
});
