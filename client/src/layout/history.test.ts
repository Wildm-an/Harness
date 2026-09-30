import { describe, expect, it } from "vitest";
import { emptyHistory, placeOf, samePlace, step, visit, type Place } from "./history";

const start: Place = { screen: "start" };
const chatA: Place = { screen: "chat", id: "a" };
const chatB: Place = { screen: "chat", id: "b" };
const plugins: Place = { screen: "plugins" };

describe("the back and forward history", () => {
  it("adds places and moves back and forward", () => {
    let h = visit(visit(visit(emptyHistory, start), chatA), plugins);
    expect(h.index).toBe(2);
    const back = step(h, -1)!;
    expect(back.place).toEqual(chatA);
    h = back.history;
    expect(step(h, 1)!.place).toEqual(plugins);
  });

  it("removes the forward places after a new place", () => {
    let h = visit(visit(visit(emptyHistory, start), chatA), plugins);
    h = step(step(h, -1)!.history, -1)!.history; // At start.
    h = visit(h, chatB);
    expect(h.stack).toEqual([start, chatB]);
    expect(step(h, 1)).toBeNull();
  });

  it("does not add the same place two times", () => {
    const h = visit(visit(emptyHistory, chatA), { screen: "chat", id: "a" });
    expect(h.stack).toHaveLength(1);
  });

  it("has no place before the first place", () => {
    expect(step(visit(emptyHistory, start), -1)).toBeNull();
    expect(step(emptyHistory, 1)).toBeNull();
  });

  it("keeps the last 50 places", () => {
    let h = emptyHistory;
    for (let i = 0; i < 60; i++) h = visit(h, { screen: "chat", id: String(i) });
    expect(h.stack).toHaveLength(50);
    expect(h.stack[0]).toEqual({ screen: "chat", id: "10" });
    expect(h.index).toBe(49);
  });

  it("knows the place of a screen", () => {
    expect(placeOf("chat", "a")).toEqual(chatA);
    expect(placeOf("chat", null)).toBeNull();
    expect(placeOf("starting", null)).toBeNull();
    expect(samePlace(placeOf("cookbook", "a")!, { screen: "cookbook" })).toBe(true);
    expect(samePlace(chatA, chatB)).toBe(false);
  });
});
