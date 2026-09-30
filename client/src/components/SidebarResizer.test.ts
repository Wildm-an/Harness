import { describe, expect, it } from "vitest";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebar } from "./SidebarResizer";

describe("clampSidebar", () => {
  it("keeps the width in the limits", () => {
    expect(clampSidebar(100)).toBe(SIDEBAR_MIN);
    expect(clampSidebar(900)).toBe(SIDEBAR_MAX);
    expect(clampSidebar(300.4)).toBe(300);
  });

  it("gives the default width for a value that is not a number", () => {
    expect(clampSidebar(Number("abc"))).toBe(SIDEBAR_DEFAULT);
  });
});
