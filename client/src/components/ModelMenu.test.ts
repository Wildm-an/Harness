import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS, effortLabel, groupModels, splitModels } from "./ModelMenu";

describe("the model menu", () => {
  it("groups the models by connection, in the order of the list", () => {
    expect(groupModels(["demo/scripted", "ollama/qwen2.5:7b", "demo/other", "ollama/hf.co/org/model:Q4"])).toEqual([
      { provider: "demo", models: ["demo/scripted", "demo/other"] },
      // Only the first "/" separates the connection from the model.
      { provider: "ollama", models: ["ollama/qwen2.5:7b", "ollama/hf.co/org/model:Q4"] },
    ]);
    expect(groupModels([])).toEqual([]);
  });
});

describe("the model menu lists", () => {
  it("puts the models of the local providers in the Local models submenu", () => {
    const local = new Set(["ollama"]);
    expect(splitModels(["cloud/big", "ollama/qwen3", "cloud/small", "ollama/hf.co/a:Q4"], local)).toEqual({
      online: ["cloud/big", "cloud/small"],
      local: ["ollama/qwen3", "ollama/hf.co/a:Q4"],
    });
    expect(splitModels(["cloud/big"], new Set())).toEqual({ online: ["cloud/big"], local: [] });
  });

  it("names the effort levels as the Claude app does", () => {
    expect(EFFORT_LEVELS.map((l) => l.label)).toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel(null)).toBe("Default");
  });
});
