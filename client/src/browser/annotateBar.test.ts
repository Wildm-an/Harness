import { describe, expect, it } from "vitest";
import { annotateCall, annotateScript, pageMessage, usesColor, usesWidth, WIDTHS } from "./annotate";

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

  it("is not in the page: the page script gets only the start color and line width", () => {
    const script = annotateScript(true, "nav", { color: "#30a46c", width: 7 });
    expect(script).toContain('"color":"#30a46c"');
    expect(script).toContain('"width":7');
    expect(script).not.toContain('role="toolbar"');
    expect(() => new Function(script)).not.toThrow();
  });

  it("sends each choice of the bar to the page script", () => {
    expect(annotateCall("setTool", "arrow")).toContain('setTool("arrow")');
    expect(annotateCall("setColor", "#2a78d6")).toContain('setColor("#2a78d6")');
    expect(annotateCall("setWidth", 4)).toContain("setWidth(4)");
    expect(annotateCall("undo")).toContain("undo()");
  });

  it("reads the messages of the page", () => {
    expect(pageMessage('{"type":"stop"}')).toEqual({ type: "stop" });
    expect(pageMessage("not json")).toBeNull();
    expect(pageMessage('{"n":1}')).toBeNull();
  });
});
