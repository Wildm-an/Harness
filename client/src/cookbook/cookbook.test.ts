import { describe, expect, it } from "vitest";
import { groupInstalled } from "./CookbookScreen";
import { formatBytes, formatCount, formatParams, formatTokens } from "./useCookbook";

describe("the Cookbook", () => {
  it("groups the parts of a split GGUF file and the safetensors files", () => {
    const groups = groupInstalled([
      { name: "m-q4_k_m-00002-of-00002.gguf", size: 1, path: "" },
      { name: "m-q4_k_m-00001-of-00002.gguf", size: 3, path: "" },
      { name: "m-q8_0.gguf", size: 8, path: "" },
      { name: "model-00001-of-00002.safetensors", size: 5, path: "" },
      { name: "model-00002-of-00002.safetensors", size: 5, path: "" },
    ]);
    expect(groups.map((g) => [g.name, g.label, g.size, g.files.length])).toEqual([
      ["m-q4_k_m-00001-of-00002.gguf", "m-q4_k_m.gguf (2 parts)", 4, 2],
      ["m-q8_0.gguf", "m-q8_0.gguf", 8, 1],
      ["model-00001-of-00002.safetensors", "safetensors (all files)", 10, 2],
    ]);
  });

  it("formats sizes, counts, parameters, and tokens", () => {
    expect(formatBytes(4683073536)).toBe("4.4 GB");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatCount(294985)).toBe("295.0K");
    expect(formatParams(7615616512)).toBe("7.6B");
    expect(formatParams(32_000_000_000)).toBe("32B");
    expect(formatParams(350_000_000)).toBe("350M");
    expect(formatTokens(16384)).toBe("16K");
  });
});
