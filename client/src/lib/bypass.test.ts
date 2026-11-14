import { describe, expect, it } from "vitest";
import { bypassAllowed, setAllowBypass, shownModes } from "./bypass";

const MODES = [{ mode: "default" }, { mode: "auto" }, { mode: "bypassPermissions" }];

describe("the bypass switch", () => {
  it("hides bypass while the setting is off, except for a session that is in bypass", () => {
    expect(shownModes(MODES, false).map((m) => m.mode)).toEqual(["default", "auto"]);
    expect(shownModes(MODES, false, "bypassPermissions")).toHaveLength(3);
    expect(shownModes(MODES, true)).toHaveLength(3);
  });

  it("keeps the value of the last user settings", () => {
    setAllowBypass(true);
    expect(bypassAllowed()).toBe(true);
    setAllowBypass(false);
    expect(bypassAllowed()).toBe(false);
  });
});
