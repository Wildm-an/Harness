import { describe, expect, it } from "vitest";
import { base64ToBytes, fitWidthZoom, isPreviewFile, linkAction, previewKind, shownDocument, stepZoom, ZOOM_STEPS } from "./document";
import { isEditableFile } from "../editor/paths";
import { toolAction } from "../chat/toolText";
import type { ToolItem } from "../chat/state";

describe("previewKind", () => {
  it("knows PDF and Word files by extension", () => {
    expect(previewKind("docs/report.pdf")).toBe("pdf");
    expect(previewKind("Plan.DOCX")).toBe("docx");
    expect(previewKind("old.doc")).toBeNull();
    expect(previewKind("app.py")).toBeNull();
    expect(isPreviewFile("a/b/c.Pdf")).toBe(true);
  });

  it("covers files that the editor cannot open", () => {
    expect(isEditableFile("report.pdf")).toBe(false);
    expect(isEditableFile("plan.docx")).toBe(false);
  });
});

describe("base64ToBytes", () => {
  it("decodes the bytes of fs.bytes", () => {
    expect([...base64ToBytes(btoa("%PDF\u00ff"))]).toEqual([37, 80, 68, 70, 255]);
  });
});

describe("zoom", () => {
  it("steps up and down and stays in the steps", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.05, -1)).toBe(1);
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0]);
    expect(stepZoom(4, 1)).toBe(4);
  });

  it("fits the page width in the pane", () => {
    expect(fitWidthZoom(644, 612)).toBeCloseTo(1);
    expect(fitWidthZoom(10000, 612)).toBe(4);
    expect(fitWidthZoom(0, 612)).toBe(1);
    expect(fitWidthZoom(500, 0)).toBe(1);
  });
});

describe("shownDocument", () => {
  const cwd = "C:\\work\\proj";

  it("gives the project path of a show_document call with no error", () => {
    expect(shownDocument("show_document", { path: "docs/a.pdf" }, false, cwd)).toBe("docs/a.pdf");
    expect(shownDocument("show_document", { path: "C:\\work\\proj\\b.docx" }, false, cwd)).toBe("b.docx");
    expect(shownDocument("show_document", { path: "./c.pdf" }, false, cwd)).toBe("c.pdf");
  });

  it("ignores failed calls, other tools, and other files", () => {
    expect(shownDocument("show_document", { path: "a.pdf" }, true, cwd)).toBeNull();
    expect(shownDocument("read", { path: "a.pdf" }, false, cwd)).toBeNull();
    expect(shownDocument("show_document", { path: "a.txt" }, false, cwd)).toBeNull();
    expect(shownDocument("show_document", null, false, cwd)).toBeNull();
  });

  it("has a chat row text", () => {
    const item = { id: "1", name: "show_document", input: { path: "docs/a.pdf" }, status: "done" } as unknown as ToolItem;
    expect(toolAction(item)).toEqual({ verb: "Opened preview of", object: "a.pdf", mono: false });
  });
});

describe("linkAction", () => {
  it("opens web links outside and goes to bookmarks", () => {
    expect(linkAction("https://example.com/x")).toEqual({ kind: "external", url: "https://example.com/x" });
    expect(linkAction("mailto:a@b.c")).toEqual({ kind: "external", url: "mailto:a@b.c" });
    expect(linkAction("#_Toc123")).toEqual({ kind: "anchor", id: "_Toc123" });
  });

  it("does nothing for other links", () => {
    expect(linkAction("javascript:alert(1)")).toBeNull();
    expect(linkAction("file:///C:/x")).toBeNull();
    expect(linkAction(null)).toBeNull();
    expect(linkAction("#")).toBeNull();
  });
});
