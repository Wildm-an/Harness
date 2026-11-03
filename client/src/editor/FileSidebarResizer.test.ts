import { describe, expect, it } from "vitest";
import { EDITOR_MIN, FILE_SIDEBAR_MIN, clampFileSidebar, savedFileSidebarWidth } from "./FileSidebarResizer";

describe("the width of the file sidebar", () => {
  it("stays between the minimum and the pane width less the editor minimum", () => {
    expect(clampFileSidebar(50, 900)).toBe(FILE_SIDEBAR_MIN);
    expect(clampFileSidebar(320.4, 900)).toBe(320);
    expect(clampFileSidebar(2000, 900)).toBe(900 - EDITOR_MIN);
    expect(clampFileSidebar(300, 200)).toBe(FILE_SIDEBAR_MIN); // A very narrow pane.
  });

  it("is automatic when no width is saved", () => {
    expect(savedFileSidebarWidth()).toBeNull();
  });
});
