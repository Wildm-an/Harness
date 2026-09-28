import { describe, expect, it } from "vitest";
import { keyLabel, keyModeFor, modelTitle } from "./ProvidersScreen";

describe("the API key of a provider form", () => {
  it("sends a typed key to the keychain", () => {
    expect(keyModeFor("keychain", "sk-1", "", null)).toEqual({ key: "client" });
    expect(keyModeFor("keychain", "sk-1", "", { source: "file", set: true })).toEqual({ key: "client" });
  });

  it("keeps a saved key when the field is empty", () => {
    expect(keyModeFor("keychain", " ", "", { source: "client", set: true })).toEqual({ key: "keep" });
    expect(keyModeFor("keychain", "", "", { source: "file", set: true })).toEqual({ key: "keep" });
  });

  it("asks for a key when there is no saved key", () => {
    expect(keyModeFor("keychain", "", "", null).error).toMatch(/Enter the API key/);
    expect(keyModeFor("keychain", "", "", { source: "none", set: false }).error).toBeDefined();
  });

  it("checks the environment variable name", () => {
    expect(keyModeFor("env", "", "OPENAI_API_KEY", null)).toEqual({ key: "env" });
    expect(keyModeFor("env", "", "OPENAI_API_KEY", { source: "env", env: "OPENAI_API_KEY", set: true })).toEqual({ key: "keep" });
    expect(keyModeFor("env", "", "1BAD", null).error).toBeDefined();
  });

  it("removes the key setting for no key", () => {
    expect(keyModeFor("none", "", "", { source: "client", set: true })).toEqual({ key: "none" });
    expect(keyModeFor("none", "", "", { source: "none", set: false })).toEqual({ key: "keep" });
  });

  it("describes the key source and warns about problems", () => {
    expect(keyLabel({ source: "client", set: true })).toEqual({ text: "Key in the keychain", warn: false });
    expect(keyLabel({ source: "client", set: false }).warn).toBe(true);
    expect(keyLabel({ source: "file", set: true }).warn).toBe(true);
    expect(keyLabel({ source: "env", env: "K", set: false }).text).toBe("$K is not set on the daemon");
  });
});

describe("the models of a connection test", () => {
  it("shows the context length and its source", () => {
    expect(modelTitle("p/m", { length: 32768, source: "llama-server" }, true)).toBe(
      "Use p/m.\nContext: 32768 tokens. The context length comes from the endpoint (llama-server).",
    );
    expect(modelTitle("p/m", { length: 4096, source: "Ollama default", warning: "Set OLLAMA_CONTEXT_LENGTH." }, true)).toMatch(
      /\nSet OLLAMA_CONTEXT_LENGTH\.$/,
    );
  });

  it("tells when the endpoint gave no context length", () => {
    expect(modelTitle("p/m", undefined, true)).toMatch(/did not give the context length/);
    expect(modelTitle("p/m", undefined, false)).toBe("Use p/m.");
  });
});
