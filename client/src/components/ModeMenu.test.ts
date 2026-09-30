import { describe, expect, it } from "vitest";
import { MODES, nextMode } from "./ModeMenu";

describe("the permission mode menu", () => {
  it("goes through the modes with Shift+Tab, as Claude Code does", () => {
    expect(nextMode("default")).toBe("acceptEdits");
    expect(nextMode("acceptEdits")).toBe("plan");
    expect(nextMode("plan")).toBe("auto");
    expect(nextMode("auto")).toBe("default");
    // Bypass is only in the menu. Shift+Tab from it goes to the first mode.
    expect(nextMode("bypassPermissions")).toBe("default");
  });

  it("has a short name for the chip under the prompt box", () => {
    expect(MODES.map((m) => m.short)).toEqual(["Ask", "Accept edits", "Plan", "Auto", "Bypass"]);
  });

  it("has a label for each mode", () => {
    expect(MODES.map((m) => m.mode)).toEqual(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
  });
});
