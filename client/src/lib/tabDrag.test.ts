import { describe, expect, it } from "vitest";
import { dragLayout, withMoved } from "./tabDrag";

describe("withMoved", () => {
  it("moves an item to the right and to the left", () => {
    expect(withMoved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(withMoved(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("does not change the list for the same index or an index out of the list", () => {
    const list = ["a", "b"];
    expect(withMoved(list, 1, 1)).toBe(list);
    expect(withMoved(list, 0, 2)).toBe(list);
    expect(withMoved(list, -1, 0)).toBe(list);
  });
});

describe("dragLayout", () => {
  // Three tabs: 100px, 60px, and 80px wide.
  const boxes = [
    { left: 0, width: 100 },
    { left: 100, width: 60 },
    { left: 160, width: 80 },
  ];

  it("moves no tab for a small drag", () => {
    expect(dragLayout(boxes, 0, 20)).toEqual({ dx: 20, to: 0, shifts: [0, 0, 0], rest: 0 });
  });

  it("moves the next tab left when the right edge of the held tab goes past its center", () => {
    expect(dragLayout(boxes, 0, 30)).toEqual({ dx: 30, to: 0, shifts: [0, 0, 0], rest: 0 });
    expect(dragLayout(boxes, 0, 31)).toEqual({ dx: 31, to: 1, shifts: [0, -100, 0], rest: 60 });
  });

  it("moves the tabs before it right when the held tab goes left", () => {
    expect(dragLayout(boxes, 2, -31)).toEqual({ dx: -31, to: 1, shifts: [0, 80, 0], rest: -60 });
    expect(dragLayout(boxes, 2, -111)).toEqual({ dx: -111, to: 0, shifts: [80, 80, 0], rest: -160 });
  });

  it("keeps the held tab in the tab row", () => {
    expect(dragLayout(boxes, 1, -500)).toEqual({ dx: -100, to: 0, shifts: [60, 0, 0], rest: -100 });
    expect(dragLayout(boxes, 1, 500)).toEqual({ dx: 80, to: 2, shifts: [0, 0, -60], rest: 80 });
  });
});

describe("dragLayout with a gap between the tabs", () => {
  // Three tabs of 50px with a gap of 2px.
  const boxes = [
    { left: 10, width: 50 },
    { left: 62, width: 50 },
    { left: 114, width: 50 },
  ];

  it("moves a tab by the width of the held tab and the gap", () => {
    expect(dragLayout(boxes, 0, 40)).toEqual({ dx: 40, to: 1, shifts: [0, -52, 0], rest: 52 });
    expect(dragLayout(boxes, 2, -90)).toEqual({ dx: -90, to: 0, shifts: [52, 52, 0], rest: -104 });
  });
});
