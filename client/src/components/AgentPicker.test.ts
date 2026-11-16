import { describe, expect, it } from "vitest";
import type { HarnessItem } from "../daemon/protocol";
import {
  agentChipLabel,
  agentChoiceMessages,
  agentGroups,
  builtinGroups,
  matchesQuery,
  railTabs,
  rowChecked,
  searchGroups,
  tabTip,
  type AgentTab,
} from "./AgentPicker";
import { BUILTIN_AGENT } from "./AgentBits";

function agent(over: Partial<HarnessItem> & { id: string; name: string }): HarnessItem {
  return {
    description: "",
    website: "",
    license: "",
    command: "",
    status: "installed",
    detail: "",
    custom: false,
    recommended: null,
    reason: "",
    local_models: false,
    download: null,
    latest: null,
    update: false,
    can_download: false,
    busy: null,
    provider_models: false,
    provider_model: null,
    provider_note: "",
    enabled: true,
    models: [],
    native_model: null,
    can_sign_in: false,
    auth: null,
    icon: null,
    probing: false,
    ...over,
  };
}

const fast = { id: "fast", name: "Fast", description: "" };
const smart = { id: "smart", name: "Smart", description: "The big one" };

describe("the rail of the agent picker", () => {
  it("has the built-in loop first, then the agents that are on, in the order of the list", () => {
    const items = [agent({ id: "codex", name: "Codex" }), agent({ id: "goose", name: "goose", enabled: false }), agent({ id: "opencode", name: "OpenCode" })];
    expect(railTabs(items, null, false).map((t) => t.id)).toEqual([BUILTIN_AGENT, "codex", "opencode"]);
    // The current agent keeps its tab when it is off.
    expect(railTabs(items, { id: "goose", name: "goose" }, false).map((t) => t.id)).toEqual([BUILTIN_AGENT, "codex", "goose", "opencode"]);
  });

  it("makes a tab for the current agent before the list comes", () => {
    const tabs = railTabs(null, { id: "opencode", name: "OpenCode", models: [fast], native_model: "fast" }, false);
    expect(tabs.map((t) => t.id)).toEqual([BUILTIN_AGENT, "opencode"]);
    expect(tabs[1].nativeModel).toBe("fast");
  });

  it("uses the models of the session in a session", () => {
    const items = [agent({ id: "opencode", name: "OpenCode", models: [fast], native_model: "fast", provider_models: true })];
    const tab = railTabs(items, { id: "opencode", name: "OpenCode", models: [fast, smart], model: "smart" }, true)[1];
    expect(tab.models).toEqual([fast, smart]);
    expect(tab.nativeModel).toBe("smart");
    expect(tab.providerModels).toBe(false);
  });

  it("tells why a tab is off in a session", () => {
    const tabs = railTabs([agent({ id: "codex", name: "Codex" })], null, true);
    expect(tabTip(tabs[1], BUILTIN_AGENT)).toBe("Codex is not available in this session. Start a new session to change the agent.");
    expect(tabTip(tabs[0], BUILTIN_AGENT)).toBe("Harness");
    expect(tabTip(tabs[1], null)).toBe("Codex\nAvailable");
  });
});

describe("the model lists of the agent picker", () => {
  const models = { items: ["cloud/big", "ollama/qwen3", "other/small"], errors: [], default: "cloud/big" };

  it("lists the online models of the built-in loop, with a heading for two or more providers", () => {
    const groups = builtinGroups(models, true, new Set(["ollama"]));
    expect(groups.map((g) => [g.heading, g.rows.map((r) => r.label)])).toEqual([
      [null, ["Default model (big)"]],
      ["cloud", ["big"]],
      ["other", ["small"]],
    ]);
    expect(builtinGroups({ ...models, items: ["cloud/big"] }, false, new Set())[0].heading).toBeNull();
  });

  it("lists the default, the models of the agent, then the provider models", () => {
    const tab: AgentTab = { id: "opencode", name: "OpenCode", item: null, models: [fast], nativeModel: null, providerModel: null, providerModels: true };
    const groups = agentGroups(tab, ["BugsAI/qwen3"], true);
    expect(groups.map((g) => [g.heading, g.rows.map((r) => `${r.kind}:${r.value}`)])).toEqual([
      [null, ["default:"]],
      ["OpenCode", ["native:fast"]],
      ["BugsAI", ["provider:BugsAI/qwen3"]],
    ]);
    expect(groups[0].rows[0].label).toBe("Default of OpenCode");
    expect(agentGroups({ ...tab, providerModels: false }, ["BugsAI/qwen3"], false)).toHaveLength(1);
  });

  it("searches the rows by each word, with a heading for each group", () => {
    expect(matchesQuery("Claude Sonnet", "son cla")).toBe(true);
    expect(matchesQuery("Claude Sonnet", "opus")).toBe(false);
    const tab: AgentTab = { id: "opencode", name: "OpenCode", item: null, models: [fast, smart], nativeModel: null, providerModel: null, providerModels: true };
    const found = [...searchGroups(builtinGroups(models, true, new Set(["ollama"]), true), "qwen"), ...searchGroups(agentGroups(tab, ["BugsAI/qwen3"], true), "qwen")];
    expect(found.map((g) => [g.heading, g.rows.map((r) => r.label)])).toEqual([
      ["ollama", ["qwen3"]],
      ["OpenCode · BugsAI", ["qwen3"]],
    ]);
    expect(searchGroups(agentGroups(tab, [], true), "default")).toEqual([]); // "Default of" is not a search result.
  });

  it("checks the current choice of each tab", () => {
    const tab: AgentTab = { id: "opencode", name: "OpenCode", item: null, models: [fast], nativeModel: null, providerModel: "BugsAI/qwen3", providerModels: true };
    const [def, own, prov] = agentGroups(tab, ["BugsAI/qwen3"], true).map((g) => g.rows[0]);
    expect([def, own, prov].map((r) => rowChecked(r, tab, ""))).toEqual([false, false, true]);
    expect(rowChecked(def, { ...tab, providerModel: null }, "")).toBe(true);
  });
});

describe("the chip of the agent picker", () => {
  const models = [fast, smart];

  it("shows the model of an ACP session, else the agent name", () => {
    expect(agentChipLabel({ id: "opencode", name: "OpenCode" }, true)).toBe("OpenCode");
    expect(agentChipLabel({ id: "opencode", name: "OpenCode", models, model: "smart" }, true)).toBe("Smart");
    expect(agentChipLabel({ id: "opencode", name: "OpenCode", models, model: "gone" }, true)).toBe("OpenCode");
  });

  it("shows the model of new sessions on the start screen", () => {
    expect(agentChipLabel({ id: "opencode", name: "OpenCode", models, native_model: "fast" }, false)).toBe("Fast");
    expect(agentChipLabel({ id: "opencode", name: "OpenCode", model: "BugsAI/qwen3" }, false)).toBe("qwen3");
    expect(agentChipLabel({ id: "opencode", name: "OpenCode" }, false)).toBe("OpenCode");
  });
});

describe("a choice in an ACP tab on the start screen", () => {
  const tab: AgentTab = { id: "opencode", name: "OpenCode", item: null, models: [fast], nativeModel: null, providerModel: "BugsAI/qwen3", providerModels: true };
  const [def, own, prov] = agentGroups(tab, ["BugsAI/qwen3"], true).map((g) => g.rows[0]);

  it("sets the model and makes the agent the agent of new sessions", () => {
    expect(agentChoiceMessages(tab, own, null)).toEqual([
      { type: "harnesses.native_model", id: "opencode", model: "fast" },
      { type: "user_settings.set", values: { operating_harness: "opencode" } },
    ]);
    // The same model of the current agent: nothing to send.
    expect(agentChoiceMessages(tab, prov, "opencode")).toEqual([]);
  });

  it("clears both models for the default of the agent", () => {
    expect(agentChoiceMessages({ ...tab, nativeModel: "fast" }, def, "opencode")).toEqual([
      { type: "harnesses.native_model", id: "opencode", model: null },
      { type: "harnesses.model", id: "opencode", model: null },
    ]);
  });
});
