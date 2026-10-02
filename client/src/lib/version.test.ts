import { describe, expect, it } from "vitest";
import { compareVersions } from "./version";

describe("compareVersions", () => {
  it("compares each part as a number", () => {
    expect(compareVersions("0.1.29", "0.1.29")).toBe(0);
    expect(compareVersions("0.1.9", "0.1.29")).toBe(-1);
    expect(compareVersions("0.2.0", "0.1.29")).toBe(1);
    expect(compareVersions("v1.0", "1.0.0")).toBe(0);
  });
});
