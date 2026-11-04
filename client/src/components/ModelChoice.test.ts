import { describe, expect, it } from "vitest";
import type { ProviderItem } from "../daemon/protocol";
import { isLocalProvider, localModels } from "./ModelChoice";

const provider = (name: string, base_url: string, ssh: string | null = null) => ({ name, base_url, ssh }) as ProviderItem;

describe("the local model of the model by network", () => {
  it("is a model of a provider on this computer", () => {
    expect(isLocalProvider(provider("ollama", "http://localhost:11434/v1"))).toBe(true);
    expect(isLocalProvider(provider("llama", "http://127.0.0.1:8080/v1"))).toBe(true);
    expect(isLocalProvider(provider("cloud", "https://api.example.com/v1"))).toBe(false);
    expect(isLocalProvider(provider("tunnel", "http://localhost:11434/v1", "devbox"))).toBe(false); // Through SSH: on another computer.
    const list = localModels(["ollama/qwen3", "cloud/big", "llama/gemma"], [provider("ollama", "http://localhost:11434/v1"), provider("cloud", "https://x.io/v1"), provider("llama", "http://127.0.0.1:8080/v1")]);
    expect(list).toEqual(["ollama/qwen3", "llama/gemma"]);
  });
});
