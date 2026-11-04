import { describe, expect, it } from "vitest";
import { nextFollow } from "./MessageList";

describe("the list follows the agent", () => {
  it("only when the user is fully at the bottom", () => {
    expect(nextFollow(false, 0, 500, 400)).toBe(true);
    expect(nextFollow(false, 2, 500, 400)).toBe(true);
    // Near the bottom, but not at it: a stopped follow stays stopped.
    expect(nextFollow(false, 40, 460, 400)).toBe(false);
  });

  it("stops at a scroll up, also near the bottom", () => {
    expect(nextFollow(true, 30, 470, 500)).toBe(false);
  });

  it("does not stop when the output grows under a list that follows", () => {
    // The scroll position stays, and the gap grows until the next follow scroll.
    expect(nextFollow(true, 120, 500, 500)).toBe(true);
  });
});
