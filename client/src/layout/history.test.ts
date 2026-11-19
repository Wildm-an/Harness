import { describe, expect, it } from "vitest";
import { emptyHistory, forget, placeOf, replace, sameScreen, samePlace, step, visit, type Place } from "./history";

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

describe("a deleted session in the history", () => {
  it("goes away, and the start screens around it become one place", () => {
    const h = forget(visit(visit(visit(emptyHistory, start), chatA), start), "a");
    expect(h.stack).toEqual([start]);
    expect(h.index).toBe(0);
    expect(step(h, -1)).toBeNull();
  });

  it("keeps the other places and the current place", () => {
    const h = forget(visit(visit(visit(visit(emptyHistory, chatB), chatA), plugins), start), "a");
    expect(h.stack).toEqual([chatB, plugins, start]);
    expect(h.index).toBe(2);
  });

  it("moves the current place back when the current place goes away", () => {
    const h = forget(visit(visit(emptyHistory, start), chatA), "a");
    expect(h.stack).toEqual([start]);
    expect(h.index).toBe(0);
  });
});

describe("the inner places and Settings", () => {
  const routines: Place = { screen: "routines" };
  const routineA: Place = { screen: "routines", sub: "a" };
  const settingsGeneral: Place = { screen: "routines", settings: "general" };

  it("makes a place with an inner place and a Settings page", () => {
    expect(placeOf("routines", null, { sub: "a" })).toEqual(routineA);
    expect(placeOf("routines", null, { settings: "general" })).toEqual(settingsGeneral);
    expect(placeOf("routines", null, {})).toEqual(routines);
  });

  it("finds a different inner place or Settings page as a different place", () => {
    expect(samePlace(routines, routineA)).toBe(false);
    expect(samePlace(routines, settingsGeneral)).toBe(false);
    expect(samePlace(routineA, { screen: "routines", sub: "a" })).toBe(true);
    expect(sameScreen(routines, routineA)).toBe(true);
    expect(sameScreen(chatA, chatB)).toBe(false);
  });

  it("steps back through the inner places", () => {
    let h = visit(visit(visit(visit(emptyHistory, chatA), routines), routineA), settingsGeneral);
    h = step(h, -1)!.history;
    expect(h.stack[h.index]).toEqual(routineA);
    h = step(h, -1)!.history;
    expect(h.stack[h.index]).toEqual(routines);
    expect(step(h, -1)!.place).toEqual(chatA);
  });

  it("replaces the current place", () => {
    const h = replace(visit(visit(emptyHistory, routines), { screen: "routines", sub: "new" }), routineA);
    expect(h.stack).toEqual([routines, routineA]);
    expect(h.index).toBe(1);
  });

  it("removes the current place when it becomes the place before it", () => {
    const h = replace(visit(visit(emptyHistory, routines), routineA), routines);
    expect(h.stack).toEqual([routines]);
    expect(h.index).toBe(0);
  });
});
