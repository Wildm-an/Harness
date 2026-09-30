import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastMode, saveLastMode } from "./ModeMenu";

describe("the last permission mode", () => {
  beforeEach(() => {
    // The tests run with no browser: a storage in memory.
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is remembered for each connection, and a bad value is the default mode", () => {
    expect(lastMode("test-a")).toBe("default");
    saveLastMode("test-a", "auto");
    expect(lastMode("test-a")).toBe("auto");
    expect(lastMode("test-b")).toBe("default");
    saveLastMode("test-b", "nonsense" as never);
    expect(lastMode("test-b")).toBe("default");
  });
});
