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

  it("is in the page, with the start settings and the theme of the app", () => {
    const script = annotateScript(true, "nav", { color: "#30a46c", width: 7, shape: "arrow", capture: true, theme: { accent: "#d97757" } });
    expect(script).toContain('"color":"#30a46c"');
    expect(script).toContain('"width":7');
    expect(script).toContain('"accent":"#d97757"');
    expect(() => new Function(script)).not.toThrow();
  });

  it("shows a spinner while the app takes the screenshot", () => {
    expect(annotateCall("busy", true)).toContain("busy(true)");
  });

  it("reads the messages of the bar", () => {
    expect(pageMessage('{"type":"add"}')).toEqual({ type: "add" });
    expect(pageMessage('{"type":"prefs","width":4}')).toMatchObject({ type: "prefs", width: 4 });
    expect(pageMessage("not json")).toBeNull();
    expect(pageMessage('{"n":1}')).toBeNull();
  });
});
