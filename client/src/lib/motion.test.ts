import { describe, expect, it } from "vitest";
import { MAX_ENTERING, enteringChildren } from "./motion";

/** A stand-in for a DOM element with children. */
const parent = (children: object[]) => ({ children }) as unknown as Element;

describe("enteringChildren (M3)", () => {
  it("does not animate the first render", () => {
    const known = new WeakSet<Element>();
    const a = {};
    expect(enteringChildren(parent([a]), known, true)).toEqual([]);
  });

  it("animates one or two new items", () => {
    const known = new WeakSet<Element>();
    const a = {}, b = {}, c = {};
    enteringChildren(parent([a]), known, true);
    expect(enteringChildren(parent([a, b]), known, false)).toEqual([b]);
    expect(enteringChildren(parent([a, b, c]), known, false)).toEqual([c]);
    // An item that stays does not animate again.
    expect(enteringChildren(parent([a, b, c]), known, false)).toEqual([]);
  });

  it("does not animate a load: many items at once", () => {
    const known = new WeakSet<Element>();
    enteringChildren(parent([{}]), known, true);
    const loaded = Array.from({ length: MAX_ENTERING + 1 }, () => ({}));
    expect(enteringChildren(parent(loaded), known, false)).toEqual([]);
    // They are known now: the next new item animates.
    const next = {};
    expect(enteringChildren(parent([...loaded, next]), known, false)).toEqual([next]);
  });
});
