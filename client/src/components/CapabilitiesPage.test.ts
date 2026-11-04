import { describe, expect, it } from "vitest";
import { matches, mcpSummary, skillStatus, skillsOfGroup } from "./CapabilitiesPage";
import { placeOf } from "../layout/history";
import { findGroupOf, parseLayout } from "../layout/model";
import type { CommandItem, McpServerItem } from "../daemon/protocol";

const skill = (extra: Partial<CommandItem> = {}): CommandItem => ({
  name: "greet",
  description: "Greet a person.",
  "argument-hint": "",
  source: "project",
  builtin: false,
  ...extra,
});

const server = (extra: Partial<McpServerItem> = {}): McpServerItem => ({
  name: "github",
  scope: "project",
  transport: "stdio",
  target: "npx github-mcp",
  state: "connected",
  error: null,
  server_name: null,
  tools: [{ name: "list", agent_name: "mcp__github__list", description: "" }],
  ...extra,
});

describe("the Capabilities page", () => {
  it("gives each skill a status from its frontmatter", () => {
    expect(skillStatus(skill())).toBe("enabled");
    expect(skillStatus(skill({ "model-invocable": false }))).toBe("command");
    expect(skillStatus(skill({ "user-invocable": false }))).toBe("model");
    expect(skillStatus(skill({ "user-invocable": false, "model-invocable": false }))).toBe("disabled");
  });

  it("describes a server with its tool count only when it is connected", () => {
    expect(mcpSummary(server())).toBe("1 tool · stdio · project");
    expect(mcpSummary(server({ state: "stopped", transport: "http", scope: "user" }))).toBe("http · user");
  });

  it("filters with all the words, in any field, with no case", () => {
    expect(matches("", "anything")).toBe(true);
    expect(matches("GIT list", "github", "mcp__github__list")).toBe(true);
    expect(matches("git deploy", "github", "list")).toBe(false);
  });

  it("is a place in the back and forward history", () => {
    expect(placeOf("capabilities", null)).toEqual({ screen: "capabilities" });
  });

  it("drops the Skills and MCP panes of a saved layout", () => {
    const saved = {
      type: "split",
      id: "s1",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "group", id: "g1", tabs: ["chat"], active: "chat" },
        { type: "group", id: "g2", tabs: ["skills", "mcp"], active: "mcp" },
      ],
    };
    const layout = parseLayout(saved);
    expect(layout).not.toBeNull();
    expect(findGroupOf(layout!, "chat")).not.toBeNull();
    expect(JSON.stringify(layout)).not.toMatch(/"skills"|"mcp"/);
  });
});

describe("skillsOfGroup", () => {
  it("puts the bundled skills in Built-in and all other skills in Added", () => {
    const items = [skill({ name: "docx", bundled: true }), skill({ name: "greet" }), skill({ name: "mine", bundled: false })];
    expect(skillsOfGroup(items, "builtin").map((i) => i.name)).toEqual(["docx"]);
    expect(skillsOfGroup(items, "added").map((i) => i.name)).toEqual(["greet", "mine"]);
  });
});
