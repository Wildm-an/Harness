import { describe, expect, it } from "vitest";
import { canStartPeek, peekGate, type PeekGateEvent } from "./sidebarPeek";

const run = (events: PeekGateEvent[], start = false) => events.reduce(peekGate, start);

describe("sidebar peek gate", () => {
  it("does not block the peek at first", () => {
    expect(canStartPeek(false, 0)).toBe(true);
  });

  it("blocks the peek after a hide click while the pointer stays on the toggle", () => {
    const blocked = run([{ type: "hide-click" }, { type: "pointer", overToggle: true }, { type: "pointer", overToggle: true }]);
    expect(blocked).toBe(true);
    expect(canStartPeek(blocked, 0)).toBe(false);
  });

  it("shows the peek again after the pointer leaves the toggle and comes back", () => {
    const left = run([{ type: "hide-click" }, { type: "pointer", overToggle: true }, { type: "leave" }]);
    expect(left).toBe(false);
    expect(canStartPeek(run([{ type: "pointer", overToggle: true }], left), 0)).toBe(true);
  });

  it("removes the block when the pointer moves off the toggle", () => {
    // The pointer can be off the new toggle after the hide, so the toggle gets no leave event.
    expect(run([{ type: "hide-click" }, { type: "pointer", overToggle: false }])).toBe(false);
  });

  it("does not block on a pointer move alone", () => {
    expect(run([{ type: "pointer", overToggle: true }])).toBe(false);
  });

  it("does not start the peek during a drag", () => {
    expect(canStartPeek(false, 1)).toBe(false);
  });
});
