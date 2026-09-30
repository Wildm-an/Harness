import { describe, expect, it } from "vitest";
import type { ToolItem } from "./state";
import { diffTotals, groupSummary, toolAction } from "./toolText";
import { groupTools } from "../components/MessageList";

const tool = (name: string, input: Record<string, unknown>, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id: `${name}-${JSON.stringify(input)}`,
  name,
  input,
  status: "done",
  ...extra,
});

const NEW_FILE = "--- /dev/null\n+++ b/src/toolText.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n";
const CHANGE = "--- a/bash.py\n+++ b/bash.py\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n";

describe("the text of tool calls", () => {
  it("has a verb and an object for each call", () => {
    expect(toolAction(tool("read", { path: "docs/test.png" }))).toEqual({ verb: "Read", object: "test.png", mono: false });
    expect(toolAction(tool("bash", { command: "ls -la" }))).toEqual({ verb: "Ran", object: "ls -la", mono: true });
    expect(toolAction(tool("bash", { command: "ls", description: "Listed the skill files." })))
      .toEqual({ verb: "Listed the skill files", object: "", mono: false });
    expect(toolAction(tool("skill", { name: "excalidraw-diagram" })).object).toBe("/excalidraw-diagram");
    expect(toolAction(tool("mcp__github__create_issue", {})).object).toBe("github: create_issue");
    expect(toolAction(tool("bash", { command: "npm test" }, { status: "running" })).verb).toBe("Running");
    expect(toolAction(tool("write", { path: "src/toolText.ts" }, { diff: NEW_FILE })).verb).toBe("Created");
  });

  it("sums a group as Claude does", () => {
    const items = [
      tool("bash", { command: "a" }), tool("bash", { command: "b" }), tool("read", { path: "test.png" }),
      tool("bash", { command: "c" }), tool("mcp__x__y", {}),
    ];
    expect(groupSummary(items)).toBe("Ran 3 commands, read test.png, used a tool");
    expect(groupSummary([tool("bash", { command: "a" }), tool("edit", { path: "bash.py" }, { diff: CHANGE })]))
      .toBe("Ran a command, edited bash.py");
    expect(groupSummary([tool("write", { path: "src/toolText.ts" }, { diff: NEW_FILE }), tool("bash", { command: "x" })]))
      .toBe("Created toolText.ts, ran a command");
    expect(groupSummary([tool("read", { path: "a" }), tool("read", { path: "b" }, { status: "error" })]))
      .toBe("Read 2 files, 1 failed");
  });

  it("adds the changed lines of a group", () => {
    expect(diffTotals([tool("edit", { path: "bash.py" }, { diff: CHANGE }), tool("write", { path: "n" }, { diff: NEW_FILE })]))
      .toEqual({ added: 4, removed: 1 });
    expect(diffTotals([tool("read", { path: "a" })])).toBeNull();
  });

  it("puts the tool calls in a row into one group", () => {
    const grouped = groupTools([
      { kind: "user", id: "u", text: "hi" },
      tool("read", { path: "a" }),
      tool("read", { path: "b" }),
      { kind: "assistant", id: "a", text: "ok", streaming: false },
      tool("bash", { command: "x" }),
    ]);
    expect(grouped.map((g) => (g.kind === "tools" ? `tools:${g.items.length}` : g.kind))).toEqual(["user", "tools:2", "assistant", "tools:1"]);
  });
});
