import { describe, expect, it } from "vitest";
import { isModelUnavailable, listedModel, networkModel, proposedModel, providerOf, rememberModel, startModel } from "./modelAvailability";

const models = {
  items: ["demo/scripted", "demo/other", "ollama/qwen2.5:latest"],
  errors: [{ provider: "lmstudio", message: "Cannot connect" }],
};

describe("modelAvailability", () => {
  it("finds the provider of a model", () => {
    expect(providerOf("ollama/hf.co/org/model:Q4")).toBe("ollama");
    expect(providerOf("bare")).toBe("");
  });

  it("finds a listed model, also without :latest", () => {
    expect(listedModel("demo/other", models)).toBe("demo/other");
    expect(listedModel("ollama/qwen2.5", models)).toBe("ollama/qwen2.5:latest");
    expect(listedModel("demo/gone", models)).toBeNull();
    expect(listedModel("demo/other", null)).toBeNull();
  });

  it("says unavailable when the daemon found the provider gone or off", () => {
    expect(isModelUnavailable("old/model", null, "Unknown provider: old")).toBe(true);
    expect(isModelUnavailable("old/model", models, "Unknown provider: old")).toBe(true);
  });

  it("trusts the list over an old daemon reason", () => {
    // The user added the provider again: the list gives the model.
    expect(isModelUnavailable("demo/other", models, "Unknown provider: demo")).toBe(false);
  });

  it("says unavailable when the provider lists models but not this one", () => {
    expect(isModelUnavailable("demo/gone", models)).toBe(true);
  });

  it("does not ask for a provider that did not answer or gives no list", () => {
    expect(isModelUnavailable("lmstudio/qwen", models)).toBe(false); // Not reachable now.
    expect(isModelUnavailable("plugin/model", models)).toBe(false); // No list.
    expect(isModelUnavailable("demo/gone", null)).toBe(false); // The list is not loaded.
    expect(isModelUnavailable("", models)).toBe(false);
  });

  it("finds the model by network: online, else local, else none", () => {
    const auto = { auto_model: true, online_model: "demo/other", offline_model: "ollama/qwen2.5" };
    expect(networkModel(auto, models)).toBe("demo/other");
    expect(networkModel({ ...auto, online_model: "lmstudio/qwen" }, models)).toBe("ollama/qwen2.5:latest"); // No answer.
    expect(networkModel({ ...auto, online_model: null, offline_model: "demo/gone" }, models)).toBeNull();
    expect(networkModel({ ...auto, auto_model: false }, models)).toBeNull(); // The switch is off.
    expect(networkModel(auto, null)).toBeNull();
    expect(networkModel(null, models)).toBeNull();
  });

  it("proposes the first preferred model that the list gives", () => {
    expect(proposedModel(models, ["demo/gone", "ollama/qwen2.5", "demo/other"])).toBe("ollama/qwen2.5:latest");
    expect(proposedModel(models, ["", "demo/gone"])).toBe("demo/scripted");
    expect(proposedModel({ items: [], errors: [] }, ["demo/other"])).toBe("");
    expect(proposedModel(null, ["demo/other"])).toBe("");
  });

  describe("startModel", () => {
    const withProviders = { ...models, providers: ["demo", "ollama", "lmstudio", "plugin"] };

    it("keeps the saved model while the list loads", () => {
      expect(startModel("local-llama-8081/sharp", null)).toBe("local-llama-8081/sharp");
      expect(startModel("", null)).toBe("");
    });

    it("gives the listed form of a saved model", () => {
      expect(startModel("ollama/qwen2.5", withProviders)).toBe("ollama/qwen2.5:latest");
    });

    it("gives Default model for a model of a provider that is gone", () => {
      // A served local model (Local models > Use): its provider goes away when the server stops.
      expect(startModel("local-llama-8081/sharp", withProviders)).toBe("");
    });

    it("keeps a model of a provider that did not answer or gives no list", () => {
      expect(startModel("lmstudio/some", withProviders)).toBe("lmstudio/some");
      expect(startModel("plugin/model", withProviders)).toBe("plugin/model");
    });

    it("gives Default model for a model that its provider does not list now", () => {
      expect(startModel("demo/deleted", withProviders)).toBe("");
    });

    it("keeps an unknown provider when an older daemon sends no provider names", () => {
      expect(startModel("local-llama-8081/sharp", models)).toBe("local-llama-8081/sharp");
    });
  });

  it("saves a chosen model for the connection and for the project", () => {
    const saved: Record<string, string> = {};
    const save = (key: string, value: string) => void (saved[key] = value);
    rememberModel("local", "p1", "BugsAI/glm-5.3-flash", save);
    rememberModel("local", null, "demo/other", save);
    expect(saved).toEqual({ "model.local": "demo/other", "model.local.p1": "BugsAI/glm-5.3-flash" });
  });
});
