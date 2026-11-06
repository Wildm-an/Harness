import { describe, expect, it } from "vitest";
import { usesColor, usesWidth, WIDTHS } from "./AnnotateBar";
import { annotateCall } from "./annotate";

describe("the annotation bar", () => {
  it("shows the color only for the pen, the shapes, and text", () => {
    expect(usesColor("none")).toBe(false);
    expect(usesColor("select")).toBe(false);
    for (const tool of ["pen", "line", "arrow", "rect", "ellipse", "step", "text"] as const) expect(usesColor(tool)).toBe(true);
  });

  it("shows the line width only for the pen and the line shapes", () => {
    for (const tool of ["none", "select", "text", "step"] as const) expect(usesWidth(tool)).toBe(false);
    for (const tool of ["pen", "line", "arrow", "rect", "ellipse"] as const) expect(usesWidth(tool)).toBe(true);
  });

  it("has four line widths, from thin to thick", () => {
    expect(WIDTHS.map(([w]) => w)).toEqual([...WIDTHS.map(([w]) => w)].sort((a, b) => a - b));
    expect(WIDTHS).toHaveLength(4);
  });

  it("sends the line width to the page", () => {
    expect(annotateCall("setTool", "pen", "#e5484d", 7)).toContain('setTool("pen","#e5484d",7)');
  });
});
