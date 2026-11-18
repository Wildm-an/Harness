import { describe, expect, it } from "vitest";
import type { UsageModel, UsagePoint, UsageProvider, UsageSummary, UsageTotals } from "../daemon/protocol";
import { placeOf } from "../layout/history";
import { monotonePath, nearestIndex, niceScale, niceStep, tickLabel, valueY, VIEW_H } from "./UsageChart";
import {
  chartTitle,
  dayLabel,
  dayRows,
  estimateTip,
  filterSummary,
  groupByDay,
  menuProviders,
  modelRates,
  parseRange,
  parseTab,
  providerLabel,
  reportedText,
  sortModels,
  speedParts,
  sumTotals,
  typeParts,
} from "./UsagePage";
import { priceRows, rowsToModels, emptyRow } from "./UsagePricesDialog";

const totals = (extra: Partial<UsageTotals> = {}): UsageTotals => ({
  tokens: 0,
  input: 0,
  cache_read: 0,
  cache_write: 0,
  output: 0,
  reasoning: 0,
  cost: 0,
  premium: 0,
  fast_cost: 0,
  ultrafast_cost: 0,
  cache_savings: 0,
  sessions: 0,
  records: 0,
  unpriced_records: 0,
  ...extra,
});

const provider = (id: string, extra: Partial<UsageProvider> = {}): UsageProvider => ({
  ...totals(),
  id,
  name: id.toUpperCase(),
  agent: `${id}-acp`,
  icon: null,
  color: "#f00",
  ...extra,
});

const model = (name: string, prov: string, cost: number, tokens: number): UsageModel => ({
  model: name,
  provider: prov,
  cost,
  tokens,
  input: 0,
  cache_read: 0,
  cache_write: 0,
  output: tokens,
  premium: 0,
  reported: 0,
  custom_price: false,
  mapped_from: [],
  rate: null,
  unpriced: false,
});

const summary = (): UsageSummary => {
  const a = provider("claude", { cost: 10, tokens: 1000, input: 100, cache_read: 800, output: 100, sessions: 3, records: 10 });
  const b = provider("codex", { cost: 5, tokens: 4000, input: 1000, cache_read: 2000, output: 1000, sessions: 2, records: 6, unpriced_records: 2 });
  return {
    range: "7d",
    resolution: "day",
    generated_at: 0,
    scan_ms: 0,
    pricing: { status: "fresh", updated_at: null },
    totals: { ...sumTotals([a, b]) },
    category_cost: { input: 2, cache_read: 1, cache_write: 0.5, output: 11.5, other: 0.001 },
    providers: [a, b],
    series: [
      { key: "2026-11-14", label: "Nov 14", by_provider: { claude: { cost: 4, tokens: 400 } } },
      { key: "2026-11-15", label: "Nov 15", by_provider: {} },
      { key: "2026-11-16", label: "Nov 16", by_provider: { claude: { cost: 6, tokens: 600 }, codex: { cost: 5, tokens: 4000 } } },
    ],
    models: [model("opus", "claude", 10, 1000), model("gpt", "codex", 5, 4000)],
    limits: [{ provider: "gemini", name: "Gemini", agent: "gemini", icon: null, windows: [] }],
    errors: [],
    prices: {},
  };
};

describe("niceScale", () => {
  it("uses steps of 1, 2, 2.5, or 5 times a power of 10", () => {
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(1.3)).toBe(2);
    expect(niceStep(2.2)).toBe(2.5);
    expect(niceStep(31)).toBe(50);
    expect(niceStep(0.0031)).toBe(0.005);
    expect(niceStep(0)).toBe(1);
  });
  it("gives 4 ticks from 0, with the top tick at the max or over it", () => {
    const s = niceScale(6784.98);
    expect(s.ticks).toEqual([0, 2500, 5000, 7500]);
    expect(s.max).toBe(7500);
    expect(niceScale(0.3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
    expect(niceScale(0).ticks).toEqual([0, 1, 2, 3]);
  });
  it("keeps a step of 1 or more for token counts", () => {
    expect(niceScale(2, 4, 1).ticks).toEqual([0, 1, 2, 3]);
  });
  it("labels the ticks", () => {
    expect(tickLabel(0, 2500, "cost")).toBe("$0");
    expect(tickLabel(7500, 2500, "cost")).toBe("$7.5K");
    expect(tickLabel(250, 50, "cost")).toBe("$250");
    expect(tickLabel(0.2, 0.1, "cost")).toBe("$0.20");
    expect(tickLabel(0.005, 0.005, "cost")).toBe("$0.005");
    expect(tickLabel(1_500_000, 500_000, "tokens")).toBe("1.5M");
  });
});

describe("the chart geometry", () => {
  it("puts 0 at the bottom and the max at the top", () => {
    expect(valueY(0, 10)).toBeGreaterThan(valueY(10, 10));
    expect(valueY(0, 10)).toBeLessThanOrEqual(VIEW_H);
    expect(valueY(20, 10)).toBe(valueY(10, 10));
  });
  it("finds the nearest point", () => {
    expect(nearestIndex(0, 7)).toBe(0);
    expect(nearestIndex(0.49, 3)).toBe(1);
    expect(nearestIndex(2, 3)).toBe(2);
    expect(nearestIndex(0.5, 1)).toBe(0);
  });
  it("draws a smooth line that stays between the points", () => {
    expect(monotonePath([])).toBe("");
    expect(monotonePath([[0, 5]])).toBe("M0,5");
    const path = monotonePath([
      [0, 100],
      [10, 0],
      [20, 100],
      [30, 100],
    ]);
    expect(path.startsWith("M0,100C")).toBe(true);
    const ys = [...path.matchAll(/C([^C]+)/g)].flatMap((m) => m[1].split(",").filter((_, i) => i % 2 === 1).map(Number));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });
});

describe("filterSummary", () => {
  it("keeps the summary when no provider is hidden", () => {
    const s = summary();
    const v = filterSummary(s, new Set(["other"]));
    expect(v.filtered).toBe(false);
    expect(v.totals).toBe(s.totals);
  });
  it("sums the shown providers when a provider is hidden", () => {
    const v = filterSummary(summary(), new Set(["codex"]));
    expect(v.filtered).toBe(true);
    expect(v.providers.map((p) => p.id)).toEqual(["claude"]);
    expect(v.models.map((m) => m.model)).toEqual(["opus"]);
    expect(v.totals.cost).toBe(10);
    expect(v.totals.tokens).toBe(1000);
    expect(v.totals.sessions).toBe(3);
  });
});

describe("sortModels", () => {
  it("sorts by the metric of the tab", () => {
    const models = summary().models;
    expect(sortModels(models, "cost").map((m) => m.model)).toEqual(["opus", "gpt"]);
    expect(sortModels(models, "tokens").map((m) => m.model)).toEqual(["gpt", "opus"]);
  });
  it("sorts a tie by the other metric, then by name", () => {
    const models = [model("b", "x", 1, 5), model("a", "x", 1, 5), model("c", "x", 1, 9)];
    expect(sortModels(models, "cost").map((m) => m.model)).toEqual(["c", "a", "b"]);
  });
});

describe("the page helpers", () => {
  it("gives the parts of the type bar", () => {
    const s = summary();
    expect(typeParts(s, s.totals, "cost").map((p) => p.key)).toEqual(["input", "cache_read", "cache_write", "output"]);
    s.category_cost.other = 0.01;
    expect(typeParts(s, s.totals, "cost").map((p) => p.key)).toContain("other");
    expect(typeParts(s, s.totals, "tokens").find((p) => p.key === "cache_read")?.value).toBe(2800);
  });
  it("gives the day rows with use, the newest first", () => {
    const s = summary();
    const rows = dayRows(s.series, s.providers, "cost");
    expect(rows.map((r) => r.key)).toEqual(["2026-11-16", "2026-11-14"]);
    expect(rows[0].total).toBe(11);
    expect(rows[0].tokens).toBe(4600);
    expect(dayRows(s.series, [{ id: "codex" }], "tokens").map((r) => r.total)).toEqual([4000]);
  });
  it("groups an hourly series by day, the newest day first in the table", () => {
    const hourly: UsagePoint[] = [
      { key: "2026-11-15T23", label: "11 PM", by_provider: { claude: { cost: 1, tokens: 10 } } },
      { key: "2026-11-16T00", label: "12 AM", by_provider: { claude: { cost: 2, tokens: 20 }, codex: { cost: 0.5, tokens: 5 } } },
      { key: "2026-11-16T14", label: "2 PM", by_provider: { claude: { cost: 3, tokens: 30 } } },
    ];
    const days = groupByDay(hourly);
    expect(days.map((d) => [d.key, d.label])).toEqual([
      ["2026-11-15", "Nov 15"],
      ["2026-11-16", "Nov 16"],
    ]);
    expect(days[1].by_provider).toEqual({ claude: { cost: 5, tokens: 50 }, codex: { cost: 0.5, tokens: 5 } });
    expect(hourly[1].by_provider.claude).toEqual({ cost: 2, tokens: 20 }); // The input does not change.
    const rows = dayRows(days, [{ id: "claude" }, { id: "codex" }], "cost");
    expect(rows.map((r) => [r.label, r.total, r.tokens])).toEqual([
      ["Nov 16", 5.5, 55],
      ["Nov 15", 1, 10],
    ]);
    const daily = summary().series;
    expect(groupByDay(daily)).toBe(daily);
    expect(dayLabel("2026-01-05")).toBe("Jan 5");
  });
  it("names the shown providers", () => {
    const items = menuProviders(summary());
    expect(items.map((p) => p.id)).toEqual(["claude", "codex", "gemini"]);
    expect(providerLabel(items, new Set())).toBe("All providers");
    expect(providerLabel(items, new Set(["claude"]))).toBe("2 providers");
    expect(providerLabel(items, new Set(["claude", "gemini"]))).toBe("CODEX");
  });
  it("tells the part of the requests with no price", () => {
    expect(estimateTip(totals())).not.toContain("leaves out");
    expect(estimateTip(summary().totals)).toContain("leaves out 12.5% of the requests");
  });
  it("names the chart and reads the saved choices", () => {
    expect(chartTitle("hour", "cost")).toBe("Hourly cost");
    expect(chartTitle("day", "tokens")).toBe("Daily processed tokens");
    expect(parseRange("7d")).toBe("7d");
    expect(parseRange("1y")).toBe("30d");
    expect(parseTab("limits")).toBe("limits");
    expect(parseTab("x")).toBe("cost");
  });
  it("splits the cost by speed only with fast requests", () => {
    expect(speedParts(totals({ cost: 10 }))).toBeNull();
    const parts = speedParts(totals({ cost: 10, fast_cost: 6, ultrafast_cost: 1, premium: 5 }))!;
    expect(parts.map((p) => [p.label, p.value])).toEqual([["Standard", 3], ["Fast", 6], ["Ultrafast", 1]]);
    expect(sumTotals([totals({ premium: 1, fast_cost: 2 }), totals({ premium: 2, fast_cost: 3 })])).toMatchObject({ premium: 3, fast_cost: 5 });
  });
  it("gives the current price of each model to the price dialog", () => {
    const rate = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 };
    expect(modelRates([{ ...model("opus", "claude", 1, 1), rate }, model("gpt", "codex", 1, 1)])).toEqual({ opus: rate });
  });
  it("tells when the limits are from the last session", () => {
    expect(reportedText("2026-11-16T11:00:00Z")).toMatch(/^From the last session, Nov 16, /);
    expect(reportedText("x")).toBe("From the last session.");
  });
  it("makes the rows of the model prices and reads them back", () => {
    const rows = priceRows({ "z-model": { input: 1, output: 2 }, "a-preview": { map_to: "a" } }, "new-model");
    expect(rows.map((r) => [r.model, r.map_to, r.input, r.output])).toEqual([
      ["a-preview", "a", "", ""],
      ["z-model", "", "1", "2"],
      ["new-model", "", "", ""],
    ]);
    expect(priceRows({ m: { input: 1, output: 1 } }, "m")).toHaveLength(1);
    const filled = rows.map((r) => (r.model === "new-model" ? { ...r, input: "3", output: "15", cache_read: "0.3" } : r));
    expect(rowsToModels([...filled, emptyRow()])).toEqual({
      models: { "a-preview": { map_to: "a" }, "z-model": { input: 1, output: 2 }, "new-model": { input: 3, output: 15, cache_read: 0.3 } },
    });
    expect(rowsToModels([{ ...emptyRow("m"), input: "1" }])).toEqual({ error: "m needs an input price and an output price." });
    expect(rowsToModels([{ ...emptyRow("m"), input: "-1", output: "1" }])).toEqual({ error: "The input price of m must be a number from 0." });
    expect(rowsToModels([emptyRow("m")])).toEqual({ error: 'Enter prices or a "Map to" model for m.' });
    expect(rowsToModels([{ ...emptyRow(""), input: "1" }])).toEqual({ error: "Enter a model ID." });
    expect(rowsToModels([{ ...emptyRow("m"), map_to: "x" }, { ...emptyRow(" m "), map_to: "y" }])).toEqual({ error: "m has two rows. Keep one." });
  });
  it("puts the page in the back and forward history", () => {
    expect(placeOf("usage", null)).toEqual({ screen: "usage" });
  });
});
