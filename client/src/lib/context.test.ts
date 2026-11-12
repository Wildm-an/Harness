import { describe, expect, it } from "vitest";
import { contextRows, contextSourceText, formatTokens } from "./context";

describe("the context length text", () => {
  it("formats token counts", () => {
    expect(formatTokens(512)).toBe("512");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(32768)).toBe("32.8k");
    expect(formatTokens(130_800)).toBe("130.8k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_048_576)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  it("tells where the length came from", () => {
    expect(contextSourceText(undefined)).toBe("");
    expect(contextSourceText("default")).toMatch(/uses a default/);
    expect(contextSourceText("providers.json")).toMatch(/providers.json/);
    expect(contextSourceText("llama-server")).toBe("The context length comes from the endpoint (llama-server).");
  });
});

describe("the context rows", () => {
  const usage = {
    tokens: 3000,
    length: 10000,
    compact_at: 0.8,
    parts: [
      { kind: "system", tokens: 1000 },
      { kind: "summary", tokens: 0 },
      { kind: "tools", tokens: 1500 },
      { kind: "messages", tokens: 500 },
    ],
  };

  it("lists the parts, the free space, and the buffer", () => {
    expect(contextRows(usage).map((r) => [r.kind, r.label, r.tokens, r.share])).toEqual([
      ["system", "System prompt", 1000, 0.1],
      ["tools", "Built-in tools", 1500, 0.15],
      ["messages", "Messages", 500, 0.05],
      ["free", "Free space", 5000, 0.5],
      ["buffer", "Compaction buffer", 2000, 0.2],
    ]);
  });

  it("has no free space after the compaction point", () => {
    const full = contextRows({ ...usage, tokens: 9000 });
    expect(full.find((r) => r.kind === "free")?.tokens).toBe(0);
    expect(full.find((r) => r.kind === "buffer")?.tokens).toBe(1000);
  });

  it("puts the parts in the order of Claude Code /context", () => {
    const mixed = {
      ...usage,
      parts: [
        { kind: "instructions", tokens: 100 },
        { kind: "tool_results", tokens: 100 },
        { kind: "messages", tokens: 100 },
        { kind: "skills", tokens: 100 },
        { kind: "summary", tokens: 100 },
        { kind: "mcp_tools", tokens: 100 },
        { kind: "plugins", tokens: 100 },
        { kind: "tools", tokens: 100 },
        { kind: "system", tokens: 100 },
      ],
    };
    expect(contextRows(mixed).map((r) => r.kind)).toEqual([
      "system", "tools", "mcp_tools", "instructions", "skills", "plugins", "summary", "messages", "tool_results", "free", "buffer",
    ]);
  });

  it("names the tool results, and hides them when they are empty", () => {
    const withResults = { ...usage, parts: [...usage.parts, { kind: "tool_results", tokens: 800 }] };
    expect(contextRows(withResults).find((r) => r.kind === "tool_results")?.label).toBe("Tool results");
    const empty = { ...usage, parts: [...usage.parts, { kind: "tool_results", tokens: 0 }] };
    expect(contextRows(empty).some((r) => r.kind === "tool_results")).toBe(false);
  });
});
