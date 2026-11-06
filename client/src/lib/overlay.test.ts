import { describe, expect, it } from "vitest";
import { clearShift } from "./overlay";

// A window 1200 wide and 800 high. The toast stack is at the bottom right: 340 wide.
const toast = { left: 844, top: 600, right: 1184, bottom: 784 };

describe("clearShift", () => {
  it("does not move a popup that no webview touches", () => {
    expect(clearShift(toast, [])).toBe(0);
    expect(clearShift(toast, [{ left: 300, top: 40, right: 700, bottom: 800 }])).toBe(0);
  });

  it("moves the popup to the left of a webview at the right", () => {
    const shift = clearShift(toast, [{ left: 700, top: 40, right: 1200, bottom: 800 }]);
    expect(shift).toBe(700 - 16 - 1184);
    expect(toast.right + shift!).toBe(684);
  });

  it("does not move the popup for a webview above it", () => {
    expect(clearShift(toast, [{ left: 700, top: 40, right: 1200, bottom: 500 }])).toBe(0);
  });

  it("gives null when there is no room at the left of the webview", () => {
    expect(clearShift(toast, [{ left: 200, top: 40, right: 1200, bottom: 800 }])).toBeNull();
  });

  it("moves past two webviews side by side", () => {
    const shift = clearShift(toast, [
      { left: 900, top: 40, right: 1200, bottom: 800 },
      { left: 700, top: 40, right: 890, bottom: 800 },
    ]);
    expect(toast.right + shift!).toBe(684);
  });
});
