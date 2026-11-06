import { describe, expect, it } from "vitest";
import { artifactUrl, fileKind, openTarget } from "./cardActions";

describe("the cards of sent files and artifacts", () => {
  it("knows the kind of a file by its extension", () => {
    expect(fileKind("report.PDF")).toBe("pdf");
    expect(fileKind("chart.png")).toBe("image");
    expect(fileKind("data.csv")).toBe("sheet");
    expect(fileKind("notes.md")).toBe("text");
    expect(fileKind("app.tsx")).toBe("code");
    expect(fileKind("build")).toBe("file");
  });

  it("opens a file in a pane, in the default app, or not at all", () => {
    expect(openTarget("auto", "pdf", true, true)).toBe("pane");
    expect(openTarget("render", "html", true, false)).toBe("pane");
    // "attach", or a file that no pane shows: the default app of this computer.
    expect(openTarget("attach", "pdf", true, true)).toBe("app");
    expect(openTarget("auto", "sheet", true, true)).toBe("app");
    // A daemon on another computer: a pane if one can show it, else nothing.
    expect(openTarget("attach", "pdf", true, false)).toBe("pane");
    expect(openTarget("auto", "sheet", true, false)).toBe("none");
    // A file out of the project: never a pane.
    expect(openTarget("render", "pdf", false, true)).toBe("app");
    expect(openTarget("render", "pdf", false, false)).toBe("none");
  });

  it("makes the URL of an artifact page", () => {
    expect(artifactUrl("http://127.0.0.1:47615/", "abc_123")).toBe("http://127.0.0.1:47615/artifacts/abc_123/");
  });
});
