import { describe, expect, it } from "vitest";
import { HARNESS_AUTO, agentModes, gateModeOf, nextAgentMode } from "./AgentModeMenu";

const hermes = {
  id: "hermes", name: "Hermes Agent", mode: "default", harness_auto: true,
  modes: [
    { id: "default", name: "Default", description: "Ask before edits." },
    { id: "accept_edits", name: "Accept Edits", description: "Auto-allow workspace edits." },
    { id: "dont_ask", name: "Don't Ask", description: "Auto-allow file edits for this session." },
  ],
};

describe("the mode menu of an agent", () => {
  it("lists the modes of the agent, then Auto of Harness", () => {
    expect(agentModes(hermes, false).map((m) => [m.id, m.label, m.gate])).toEqual([
      ["default", "Default", "default"],
      ["accept_edits", "Accept Edits", "acceptEdits"],
      ["dont_ask", "Don't Ask", "acceptEdits"],
      [HARNESS_AUTO, "Auto", "auto"],
    ]);
  });

  it("shows a bypass mode only when bypass is allowed", () => {
    const claude = { id: "claude-acp", name: "Claude Agent", mode: "default", modes: [
      { id: "default", name: "Manual", description: "" }, { id: "bypassPermissions", name: "Bypass permissions", description: "" },
    ] };
    expect(agentModes(claude, false).map((m) => m.id)).toEqual(["default"]);
    expect(agentModes(claude, true).map((m) => m.id)).toEqual(["default", "bypassPermissions"]);
    expect(gateModeOf("yolo")).toBe("bypassPermissions");
    expect(gateModeOf("strange")).toBe("default");
  });

  it("goes to the next mode with Shift+Tab", () => {
    const modes = agentModes(hermes, false);
    expect(nextAgentMode(modes, "default")).toBe("accept_edits");
    expect(nextAgentMode(modes, HARNESS_AUTO)).toBe("default");
    expect(nextAgentMode([], "default")).toBeNull();
  });
});
