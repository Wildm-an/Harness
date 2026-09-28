import { describe, expect, it } from "vitest";
import { contextSourceText, formatTokens } from "./context";

describe("the context length text", () => {
  it("formats token counts", () => {
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(32768)).toBe("33k");
  });

  it("tells where the length came from", () => {
    expect(contextSourceText(undefined)).toBe("");
    expect(contextSourceText("default")).toMatch(/uses a default/);
    expect(contextSourceText("providers.json")).toMatch(/providers.json/);
    expect(contextSourceText("llama-server")).toBe("The context length comes from the endpoint (llama-server).");
  });
});
