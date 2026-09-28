import { describe, expect, it } from "vitest";
import { groupModels } from "./ModelMenu";

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
