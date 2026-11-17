import { describe, expect, it } from "vitest";
import type { HarnessItem } from "../daemon/protocol";
import {
  agentChipLabel,
  agentChoiceMessages,
  agentGroups,
  builtinGroups,
  ctrlDigit,
  effortChipName,
  effortValue,
  favoriteKey,
  favoriteRows,
  firstRows,
  matchesQuery,
  parseFavorites,
  railTabs,
  resolveEfforts,
  rowChecked,
  rowKeyLabel,
  searchGroups,
  splitFavorite,
  tabTip,
  toggleFavorite,
  type AgentTab,
  type PickGroup,
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
    efforts: [],
    native_effort: null,
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
    expect(tabTip(tabs[1], BUILTIN_AGENT)).toBe("Codex: the agent changes only between turns.");
    expect(tabTip(tabs[0], BUILTIN_AGENT)).toBe("Harness");
    expect(tabTip(tabs[1], null)).toBe("Codex\nAvailable");
  });
});

describe("the model lists of the agent picker", () => {
  const models = { items: ["cloud/big", "ollama/qwen3", "other/small"], errors: [], default: "cloud/big" };

  it("lists the online models of the built-in loop, with a heading for two or more providers, then the local models", () => {
    const groups = builtinGroups(models, true, new Set(["ollama"]));
    expect(groups.map((g) => [g.heading, g.rows.map((r) => r.label)])).toEqual([
      [null, ["Default model (big)"]],
      ["cloud", ["big"]],
      ["other", ["small"]],
      ["Local models", ["qwen3"]],
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

describe("the favorites of the agent picker", () => {
  it("encodes and decodes a favorite as agent|value", () => {
    expect(favoriteKey("harness", "cloud/big")).toBe("harness|cloud/big");
    expect(splitFavorite("opencode|BugsAI/qwen3")).toEqual({ agent: "opencode", value: "BugsAI/qwen3" });
    expect(splitFavorite("codex|a|b")).toEqual({ agent: "codex", value: "a|b" });
    expect(splitFavorite("nobar")).toBeNull();
    expect(splitFavorite("|x")).toBeNull();
    expect(splitFavorite("x|")).toBeNull();
  });

  it("reads the preference, and drops a bad value", () => {
    expect(parseFavorites('["harness|cloud/big","harness|cloud/big",3,"bad","codex|gpt"]')).toEqual(["harness|cloud/big", "codex|gpt"]);
    expect(parseFavorites("not json")).toEqual([]);
    expect(parseFavorites('{"a":1}')).toEqual([]);
  });

  it("adds and removes a favorite", () => {
    expect(toggleFavorite(["a|1"], "b|2")).toEqual(["a|1", "b|2"]);
    expect(toggleFavorite(["a|1", "b|2"], "a|1")).toEqual(["b|2"]);
  });

  it("lists the favorites that a group gives, in their order, with the group as the detail", () => {
    const models = { items: ["cloud/big", "ollama/qwen3"], errors: [], default: null };
    const tab: AgentTab = { id: "opencode", name: "OpenCode", item: null, models: [fast, smart], nativeModel: null, providerModel: null, providerModels: false };
    const groups = [...builtinGroups(models, true, new Set(["ollama"]), true), ...agentGroups(tab, [], true)];
    const rows = favoriteRows(["opencode|smart", "harness|gone/model", "harness|ollama/qwen3", "opencode|"], groups);
    expect(rows.map((r) => [r.agent, r.value, r.label, r.detail])).toEqual([
      ["opencode", "smart", "Smart", "OpenCode"],
      ["harness", "ollama/qwen3", "qwen3", "ollama"],
    ]);
  });
});

describe("Show more in the agent picker", () => {
  const row = (value: string, kind: "default" | "builtin" = "builtin") => ({ key: value, agent: "harness", kind, value, label: value });
  const groups: PickGroup[] = [
    { key: "d", heading: null, searchHeading: "d", rows: [row("", "default")] },
    { key: "a", heading: "a", searchHeading: "a", rows: [row("a/1"), row("a/2"), row("a/3")] },
    { key: "b", heading: "b", searchHeading: "b", rows: [row("b/1"), row("b/2"), row("b/3")] },
  ];

  it("shows the default row and the first 4 models, and counts the others", () => {
    const first = firstRows(groups, 4);
    expect(first.groups.map((g) => [g.key, g.rows.map((r) => r.value)])).toEqual([
      ["d", [""]],
      ["a", ["a/1", "a/2", "a/3"]],
      ["b", ["b/1"]],
    ]);
    expect(first.hidden).toBe(2);
  });

  it("always shows the current model, and drops an empty group", () => {
    const first = firstRows(groups, 2, (r) => r.value === "b/3");
    expect(first.groups.map((g) => [g.key, g.rows.map((r) => r.value)])).toEqual([
      ["d", [""]],
      ["a", ["a/1", "a/2"]],
      ["b", ["b/3"]],
    ]);
    expect(first.hidden).toBe(3);
    expect(firstRows(groups, 10).hidden).toBe(0);
  });
});

describe("the keys of the agent picker", () => {
  const key = (over: Partial<KeyboardEvent>) => ({ key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over });

  it("maps Ctrl+1 to Ctrl+9 to a row", () => {
    expect(ctrlDigit(key({ key: "3", code: "Digit3", ctrlKey: true }))).toBe(3);
    expect(ctrlDigit(key({ key: "End", code: "Numpad1", ctrlKey: true }))).toBe(1);
    expect(ctrlDigit(key({ key: "9", ctrlKey: true }))).toBe(9); // No code.
    expect(ctrlDigit(key({ key: "&", code: "Digit1", ctrlKey: true }))).toBe(1); // Another keyboard layout.
    expect(ctrlDigit(key({ key: "3", code: "Digit3" }))).toBeNull(); // A plain digit goes to the search field.
    expect(ctrlDigit(key({ key: "0", code: "Digit0", ctrlKey: true }))).toBeNull();
    expect(ctrlDigit(key({ key: "3", code: "Digit3", ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("labels the first 9 rows", () => {
    expect([0, 8, 9, -1].map(rowKeyLabel)).toEqual(["Ctrl+1", "Ctrl+9", null, null]);
  });
});

describe("the reasoning levels of an ACP agent", () => {
  const level = (id: string, name: string, description = "") => ({ id, name, description });
  const levels = [level("low", "Low"), level("medium", "Medium"), level("high", "High"), level("xhigh", "Extra high")];

  it("gives the Default label to the level that the default entry names", () => {
    const efforts = [level("default", "Default", "Uses medium effort"), ...levels];
    const r = resolveEfforts(efforts, null);
    expect(r.levels.map((l) => l.id)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(r.defaultId).toBe("medium");
    expect(r.currentId).toBe("medium");
    expect(resolveEfforts(efforts, "default").currentId).toBe("medium");
    expect(resolveEfforts(efforts, "high").currentId).toBe("high");
  });

  it("matches the longest level name, and a whole word only", () => {
    expect(resolveEfforts([level("default", "Default (Extra high)"), ...levels], null).defaultId).toBe("xhigh");
    expect(resolveEfforts([level("default", "Default", "xhigh"), ...levels], null).defaultId).toBe("xhigh");
    expect(resolveEfforts([level("default", "Default (HIGH)"), ...levels], null).defaultId).toBe("high");
  });

  it("shows a Default row when the default entry names no level", () => {
    const r = resolveEfforts([level("default", "Default", "The agent chooses"), ...levels], null);
    expect(r.levels.map((l) => [l.id, l.name])).toEqual([
      ["default", "Default"],
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra high"],
    ]);
    expect(r.defaultId).toBe("default");
    expect(r.currentId).toBe("default");
  });

  it("has no default level with no default entry", () => {
    expect(resolveEfforts(levels, null)).toEqual({ levels, defaultId: null, currentId: null });
    expect(resolveEfforts(levels, "low").currentId).toBe("low");
  });

  it("sends null for the default level on the start screen, and the id in a session", () => {
    const named = resolveEfforts([level("default", "Default (medium)"), ...levels], null);
    expect(effortValue("medium", named, false)).toBeNull();
    expect(effortValue("high", named, false)).toBe("high");
    expect(effortValue("medium", named, true)).toBe("medium");
    const plain = resolveEfforts([level("default", "Default"), ...levels], null);
    expect(effortValue("default", plain, false)).toBeNull();
    expect(effortValue("default", plain, true)).toBe("default");
  });

  it("shows the level in the chip, but not the default of the agent", () => {
    const efforts = [level("default", "Default"), ...levels];
    expect(effortChipName(efforts, "xhigh")).toBe("Extra high");
    expect(effortChipName(efforts, "default")).toBeNull();
    expect(effortChipName([level("default", "Default (high)"), ...levels], null)).toBe("High");
    expect(effortChipName([], "high")).toBeNull();
    expect(effortChipName(undefined, "high")).toBeNull();
  });

  it("takes the levels of the session, else of the agent list, else of user_settings", () => {
    const efforts = [level("low", "Low")];
    const inSession = railTabs([agent({ id: "claude", name: "Claude Agent" })], { id: "claude", name: "Claude Agent", efforts, effort: "low" }, true)[1];
    expect([inSession.efforts, inSession.effort]).toEqual([efforts, "low"]);
    const listed = railTabs([agent({ id: "claude", name: "Claude Agent", efforts, native_effort: "low" })], null, false)[1];
    expect([listed.efforts, listed.effort]).toEqual([efforts, "low"]);
    const early = railTabs(null, { id: "claude", name: "Claude Agent", efforts, native_effort: "low" }, false)[1];
    expect([early.efforts, early.effort]).toEqual([efforts, "low"]);
  });
});
