import { describe, expect, it } from "vitest";
import type { HarnessItem, UserSettings } from "../daemon/protocol";
import { BUILTIN_AGENT } from "./AgentBits";
import {
  agentHasUpdate,
  agentUpdateCount,
  checkedText,
  downloadUpdates,
  programStateText,
  currentHarness,
  filterHarnesses,
  harnessAction,
  listedAgents,
  modelChange,
  modelChoices,
  modelGroups,
  progressText,
  sortHarnesses,
  splitHarnesses,
} from "./AgentsSettings";

const harness = (id: string, name: string, extra: Partial<HarnessItem> = {}): HarnessItem => ({
  id,
  name,
  description: "",
  website: "",
  license: "MIT",
  command: `${id} acp`,
  status: "missing",
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
  enabled: false,
  models: [],
  native_model: null,
  can_sign_in: false,
  auth: null,
  icon: null,
  efforts: [],
  native_effort: null,
  probing: false,
  ...extra,
});

describe("the Agents page", () => {
  it("uses the built-in loop when the setting has no value", () => {
    expect(currentHarness(null)).toBe(BUILTIN_AGENT);
    expect(currentHarness({ operating_harness: null } as UserSettings)).toBe(BUILTIN_AGENT);
    expect(currentHarness({ operating_harness: "opencode" } as UserSettings)).toBe("opencode");
  });

  it("sorts by name, with the custom harnesses last", () => {
    const items = [harness("zed", "zeta"), harness("custom-a", "Alpha", { custom: true }), harness("goose", "goose"), harness("amp", "Amp")];
    expect(sortHarnesses(items).map((h) => h.id)).toEqual(["amp", "goose", "zed", "custom-a"]);
  });

  it("lists the enabled agents, and keeps the selected agent in the list", () => {
    const items = [harness("zed", "zeta", { enabled: true }), harness("goose", "goose"), harness("amp", "Amp", { enabled: true })];
    expect(listedAgents(items).map((h) => h.id)).toEqual(["amp", "zed"]);
    expect(listedAgents(items, "goose").map((h) => h.id)).toEqual(["amp", "goose", "zed"]);
    expect(listedAgents(items, BUILTIN_AGENT).map((h) => h.id)).toEqual(["amp", "zed"]);
  });

  it("puts the recommended harnesses first, in the order of the daemon", () => {
    const items = [
      harness("amp", "Amp"),
      harness("omp", "Oh My Pi", { recommended: 1 }),
      harness("custom-a", "Alpha", { custom: true }),
      harness("opencode", "OpenCode", { recommended: 0 }),
      harness("bob", "Bob"),
    ];
    const { recommended, others } = splitHarnesses(items);
    expect(recommended.map((h) => h.id)).toEqual(["opencode", "omp"]);
    expect(others.map((h) => h.id)).toEqual(["amp", "bob", "custom-a"]);
  });

  it("finds each word in the name, the description, or the command", () => {
    const items = [
      harness("opencode", "OpenCode", { description: "It can use local models." }),
      harness("omp", "Oh My Pi", { command: "omp --mode acp" }),
    ];
    expect(filterHarnesses(items, "").length).toBe(2);
    expect(filterHarnesses(items, "local").map((h) => h.id)).toEqual(["opencode"]);
    expect(filterHarnesses(items, "PI mode").map((h) => h.id)).toEqual(["omp"]);
    expect(filterHarnesses(items, "nothing")).toEqual([]);
  });

  it("shows Download, Update, or the progress of a download", () => {
    expect(harnessAction(harness("goose", "goose", { can_download: true }))).toBe("download");
    expect(harnessAction(harness("gemini", "Gemini CLI", { status: "npx", can_download: true }))).toBe("download");
    // The user installed it on the PATH: no Download.
    expect(harnessAction(harness("goose", "goose", { status: "installed", can_download: true }))).toBeNull();
    expect(harnessAction(harness("omp", "Oh My Pi"))).toBeNull();
    const downloaded = { status: "downloaded" as const, can_download: true, download: { version: "1.0.0", kind: "binary" as const }, latest: "1.0.0" };
    expect(harnessAction(harness("goose", "goose", downloaded))).toBeNull();
    expect(harnessAction(harness("goose", "goose", { ...downloaded, latest: "1.1.0", update: true }))).toBe("update");
    const running = { stage: "Downloading", received: 50, total: 200 };
    expect(harnessAction(harness("goose", "goose", { ...downloaded, update: true }), running)).toBe("busy");
    expect(harnessAction(harness("goose", "goose", { can_download: true, busy: running }))).toBe("busy");
  });

  it("gives the percent of a download when the size is known", () => {
    expect(progressText({ stage: "Downloading", received: 50, total: 200 })).toBe("Downloading 25%");
    expect(progressText({ stage: "Downloading", received: 50, total: 0 })).toBe("Downloading…");
    expect(progressText({ stage: "Installing with npm", received: 0, total: 0 })).toBe("Installing with npm…");
  });

  it("groups the models of the providers for the Model menu", () => {
    const models = [
      { provider: "local-ollama", model: "qwen3-coder:30b" },
      { provider: "openrouter", model: "openai/gpt-5" },
      { provider: "local-ollama", model: "llama3" },
    ];
    expect(modelGroups(models, null)).toEqual([
      { provider: "local-ollama", values: ["local-ollama/qwen3-coder:30b", "local-ollama/llama3"] },
      { provider: "openrouter", values: ["openrouter/openai/gpt-5"] },
    ]);
    // A saved model of a provider that does not answer stays as a choice.
    expect(modelGroups(models, "BugsAI/big")).toContainEqual({ provider: "BugsAI", values: ["BugsAI/big"] });
    expect(modelGroups(models, "local-ollama/llama3")).toHaveLength(2);
  });
});

describe("the Model select of an agent", () => {
  const providers = [{ provider: "openrouter", model: "openai/gpt-5" }];
  const own = [
    { id: "opus", name: "Opus", description: "" },
    { id: "sonnet", name: "Sonnet", description: "" },
  ];

  it("has no select when the agent has no model choice", () => {
    expect(modelChoices(harness("goose", "goose"), providers)).toBeNull();
  });

  it("shows the provider models with the settings of the agent first", () => {
    const c = modelChoices(harness("codex", "Codex", { provider_models: true, provider_model: "openrouter/openai/gpt-5" }), providers);
    expect(c?.defaultLabel).toBe("Codex settings");
    expect(c?.value).toBe("provider:openrouter/openai/gpt-5");
    expect(c?.groups).toEqual([{ label: "openrouter", options: [{ value: "provider:openrouter/openai/gpt-5", label: "openai/gpt-5" }] }]);
  });

  it("shows the provider models first, then the own models of the agent, with no Default", () => {
    const c = modelChoices(harness("claude", "Claude Agent", { models: own, native_model: "haiku", provider_models: true }), providers);
    expect(c?.defaultLabel).toBeNull();
    expect(c?.value).toBe("native:haiku");
    expect(c?.groups[0].label).toBe("openrouter");
    // A saved own model that the agent did not give stays as a choice.
    expect(c?.groups[c.groups.length - 1]).toEqual({
      label: "Claude Agent",
      options: [
        { value: "native:haiku", label: "haiku" },
        { value: "native:opus", label: "Opus" },
        { value: "native:sonnet", label: "Sonnet" },
      ],
    });
  });

  it("selects the model of new sessions when nothing is chosen, and hides a default alias", () => {
    const models = [{ id: "default", name: "Default (recommended)", description: "", current: true }, ...own];
    const c = modelChoices(harness("claude", "Claude Agent", { models }), providers);
    expect(c?.value).toBe(`native:${own[0].id}`);
    expect(c?.groups.flatMap((g) => g.options.map((o) => o.value))).not.toContain("native:default");
    // No models yet: the agent uses its own settings.
    expect(modelChoices(harness("x", "X", { models: [], provider_models: true }), providers)?.defaultLabel).toBe("X settings");
  });

  it("sends one model: a provider model clears the own model, and the other way", () => {
    const both = harness("claude", "Claude Agent", { models: own, native_model: "opus", provider_models: true });
    expect(modelChange(both, "provider:openrouter/openai/gpt-5")).toEqual([
      { type: "harnesses.model", id: "claude", model: "openrouter/openai/gpt-5" },
      { type: "harnesses.native_model", id: "claude", model: null },
    ]);
    expect(modelChange({ ...both, native_model: null, provider_model: "openrouter/openai/gpt-5" }, "native:sonnet")).toEqual([
      { type: "harnesses.native_model", id: "claude", model: "sonnet" },
      { type: "harnesses.model", id: "claude", model: null },
    ]);
    expect(modelChange(both, "")).toEqual([
      { type: "harnesses.model", id: "claude", model: null },
      { type: "harnesses.native_model", id: "claude", model: null },
    ]);
    expect(modelChange(harness("codex", "Codex", { provider_models: true }), "")).toEqual([{ type: "harnesses.model", id: "codex", model: null }]);
  });

  it("says when Harness read the usage", () => {
    const now = new Date(2026, 10, 16, 15, 0);
    expect(checkedText(0, now)).toBe("");
    expect(checkedText(new Date(2026, 10, 16, 14, 20).getTime() / 1000, now)).toMatch(/^Checked \S/);
  });
});

describe("the updates of the agents", () => {
  const program = (extra: Partial<NonNullable<HarnessItem["program"]>> = {}): NonNullable<HarnessItem["program"]> => ({
    label: "Hermes Agent",
    path: "/bin/hermes",
    version: "0.22.5",
    latest: "0.23.2",
    update: true,
    command: "hermes update",
    checked: 1,
    error: null,
    ...extra,
  });
  const dl = { version: "1.0.0", kind: "binary" as const };

  it("finds the agents with an update: a download, or a program that the user installed", () => {
    expect(agentHasUpdate(harness("a", "A", { download: dl, update: true }))).toBe(true);
    expect(agentHasUpdate(harness("b", "B", { download: dl, update: false }))).toBe(false);
    expect(agentHasUpdate(harness("c", "C", { program: program() }))).toBe(true);
    expect(agentHasUpdate(harness("d", "D", { program: program({ update: false }) }))).toBe(false);
    expect(agentHasUpdate(harness("e", "E", { update: true }))).toBe(false); // No download: "Download", not "Update".
  });

  it("lists the downloads for Update all, and counts the enabled agents for the nav dot", () => {
    const items = [
      harness("a", "A", { download: dl, update: true, enabled: true }),
      harness("b", "B", { download: dl, update: true, busy: { stage: "Downloading", received: 1, total: 2 } }),
      harness("c", "C", { download: dl, update: true }),
      harness("d", "D", { program: program(), enabled: true }),
    ];
    expect(downloadUpdates(items).map((h) => h.id)).toEqual(["a", "c"]);
    expect(downloadUpdates(items, { c: { stage: "Waiting", received: 0, total: 0 } }).map((h) => h.id)).toEqual(["a"]);
    expect(agentUpdateCount(items)).toBe(2);
    expect(agentUpdateCount(null)).toBe(0);
  });

  it("says the version state of a program", () => {
    expect(programStateText(program())).toBe("Version 0.23.2 is available.");
    expect(programStateText(program({ update: false, latest: "0.22.5" }))).toBe("Up to date.");
    expect(programStateText(program({ update: false, latest: null, error: "Could not check the version: TimeoutError" }))).toBe(
      "Could not check the version: TimeoutError",
    );
    expect(programStateText(program({ update: false, latest: null, version: null }))).toBeNull();
  });
});
