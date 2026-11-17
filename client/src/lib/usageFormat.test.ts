import { describe, expect, it } from "vitest";
import { formatCount, formatPercent, formatTokens, formatUsd, share } from "./usageFormat";

describe("formatUsd", () => {
  it("gives en-US currency with 2 decimals", () => {
    expect(formatUsd(6784.981)).toBe("$6,784.98");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

describe("formatTokens", () => {
  it("gives an integer under 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(999.4)).toBe("999");
  });
  it("uses K, M, B, T with 2, 1, or 0 decimals", () => {
    expect(formatTokens(1250)).toBe("1.25K");
    expect(formatTokens(152_000)).toBe("152K");
    expect(formatTokens(1_250_000)).toBe("1.25M");
    expect(formatTokens(16_500_000_000)).toBe("16.5B");
    expect(formatTokens(45_670_000)).toBe("45.7M");
    expect(formatTokens(2_000_000_000_000)).toBe("2T");
  });
  it("removes the zeros at the end", () => {
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(2000)).toBe("2K");
    expect(formatTokens(20_000)).toBe("20K");
  });
  it("chooses the unit after the rounding", () => {
    expect(formatTokens(999_950)).toBe("1M");
    expect(formatTokens(999.6)).toBe("1K");
    expect(formatTokens(9_999)).toBe("10K");
  });
});

describe("formatPercent", () => {
  it("gives 1 decimal, and <0.1% for a small share", () => {
    expect(formatPercent(12.345)).toBe("12.3%");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.04)).toBe("<0.1%");
    expect(formatPercent(100)).toBe("100.0%");
  });
});

describe("formatCount and share", () => {
  it("formats counts and shares", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(share(1, 4)).toBe(25);
    expect(share(1, 0)).toBe(0);
  });
});
