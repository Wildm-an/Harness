import { describe, expect, it } from "vitest";
import { annotateScript, annotationAttachment, annotationText, parseAnnotation } from "./annotate";

const note = {
  type: "note", n: 2, comment: "Make this blue.", url: "http://localhost:5173/", title: "Shop",
  tag: '<button class="primary">', text: "Buy now", selector: "main > button.primary", size: "120×32 at 40,210",
};

describe("browser annotations", () => {
  it("read a note of the page script", () => {
    expect(parseAnnotation(JSON.stringify(note))).toMatchObject({ n: 2, comment: "Make this blue.", selector: "main > button.primary" });
    expect(parseAnnotation('{"type":"stop"}')).toBeNull();
    expect(parseAnnotation("not json")).toBeNull();
  });

  it("give the agent the page, the element, and the note", () => {
    const text = annotationText(parseAnnotation(note)!);
    expect(text).toContain('[Browser annotation 2: http://localhost:5173/ ("Shop")]');
    expect(text).toContain('Element: <button class="primary"> "Buy now"');
    expect(text).toContain("Selector: main > button.primary");
    expect(text).toContain("Note: Make this blue.");
  });

  it("make a script that the page can run on its own", () => {
    const script = annotateScript(true, "nav");
    expect(script).toContain("harness-annotate.invalid");
    expect(() => new Function(script)).not.toThrow(); // Valid JavaScript.
  });
});

describe("the chip of a browser annotation", () => {
  it("shows the element and the start of the note", () => {
    const chip = annotationAttachment(parseAnnotation(note)!);
    expect(chip.label).toBe("Annotation 2");
    expect(chip.detail).toBe("button.primary — Make this blue.");
    expect(chip.text).toContain("Selector: main > button.primary");
  });
});
