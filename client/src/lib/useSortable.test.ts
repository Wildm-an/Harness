import { describe, expect, it } from "vitest";
import { reorder, shiftOf, targetIndex } from "./useSortable";

// Three items of 40 px with no gap: tops 0, 40, 80.
const tops = [0, 40, 80];
const heights = [40, 40, 40];

describe("drag to reorder", () => {
  it("finds the new place of the held item from its middle", () => {
    expect(targetIndex(tops, heights, 0, 0)).toBe(0);
    expect(targetIndex(tops, heights, 0, 30)).toBe(0); // Its middle (50) is above the middle of item 1 (60).
    expect(targetIndex(tops, heights, 0, 45)).toBe(1);
    expect(targetIndex(tops, heights, 0, 90)).toBe(2);
    expect(targetIndex(tops, heights, 2, -90)).toBe(0);
  });

  it("slides the other items out of the way", () => {
    // Item 0 goes to place 2: items 1 and 2 move up by its space.
    expect([0, 1, 2].map((i) => shiftOf(i, 0, 2, tops, heights))).toEqual([0, -40, -40]);
    // Item 2 goes to place 0: items 0 and 1 move down.
    expect([0, 1, 2].map((i) => shiftOf(i, 2, 0, tops, heights))).toEqual([40, 40, 0]);
  });

  it("gives the order after the drop", () => {
    expect(reorder(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(reorder(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(reorder(["a", "b", "c"], "b", 9)).toEqual(["a", "c", "b"]);
  });
});
