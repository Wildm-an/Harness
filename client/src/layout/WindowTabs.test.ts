import { describe, expect, it } from "vitest";
import { fitTabs } from "./WindowTabs";

const tabs = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

describe("the tabs of a narrow pane", () => {
  it("show all tabs when they fit as icons", () => {
    expect(fitTabs(tabs, "a", 1000).hidden).toEqual([]);
    expect(fitTabs(tabs, "a", 5 * 38).hidden).toEqual([]);
  });

  it("put the other tabs in the list, and always show the active tab", () => {
    const fit = fitTabs(tabs, "e", 3 * 38 + 30);
    expect(fit.shown.map((t) => t.id)).toEqual(["a", "b", "e"]);
    expect(fit.hidden.map((t) => t.id)).toEqual(["c", "d"]);
    expect(fitTabs(tabs, "a", 10).shown.map((t) => t.id)).toEqual(["a"]); // At least one tab.
  });
});
