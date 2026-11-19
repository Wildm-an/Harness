import { describe, expect, it } from "vitest";
import type { AgentUpdateItem } from "../daemon/protocol";
import { agentUpdatePercent, agentUpdateStage, agentUpdatesTitle } from "./AgentUpdatesToast";

function item(over: Partial<AgentUpdateItem>): AgentUpdateItem {
  return {
    id: "claude-acp", name: "Claude Agent", icon: null, from: "0.108.1", to: "0.109.0",
    state: "waiting", stage: "Waiting", received: 0, total: 0, error: null, ...over,
  };
}

describe("the popup of the automatic agent updates", () => {
  it("names one agent, or counts the agents", () => {
    expect(agentUpdatesTitle([item({ state: "running" })])).toBe("Updating Claude Agent");
    const two = [item({ state: "running" }), item({ id: "codex-acp", name: "Codex" })];
    expect(agentUpdatesTitle(two)).toBe("Updating 2 agents");
    expect(agentUpdatesTitle([item({ state: "done" })])).toBe("Claude Agent updated");
    expect(agentUpdatesTitle([item({ state: "done" }), item({ id: "omp", state: "done" })])).toBe("Agents updated");
  });

  it("keeps the title on the updates that run, and then names the failures", () => {
    const mixed = [item({ state: "failed", error: "No network." }), item({ id: "omp", state: "running" })];
    expect(agentUpdatesTitle(mixed)).toBe("Updating 2 agents");
    expect(agentUpdatesTitle([item({ state: "failed" }), item({ id: "omp", state: "done" })])).toBe("1 agent update failed");
    expect(agentUpdatesTitle([item({ state: "failed" })])).toBe("Claude Agent did not update");
  });

  it("shows the percent of a download with a known size", () => {
    const download = item({ state: "running", stage: "Downloading", received: 45, total: 100 });
    expect(agentUpdatePercent(download)).toBe(45);
    expect(agentUpdateStage(download)).toBe("Downloading 45%");
    const npm = item({ state: "running", stage: "Installing with npm" });
    expect(agentUpdatePercent(npm)).toBeNull();
    expect(agentUpdateStage(npm)).toBe("Installing with npm");
  });

  it("shows the result of each agent", () => {
    expect(agentUpdateStage(item({}))).toBe("Waiting");
    expect(agentUpdateStage(item({ state: "done" }))).toBe("Updated to 0.109.0");
    expect(agentUpdateStage(item({ state: "failed", error: "No network." }))).toBe("No network.");
  });
});
