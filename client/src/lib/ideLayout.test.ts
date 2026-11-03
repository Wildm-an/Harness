import { describe, expect, it } from "vitest";
import { DEFAULT_IDE_OPTIONS, groups, ideLayoutFor, type IdeLayoutOptions, type LayoutNode } from "../layout/model";
import { isEditableFile } from "../editor/paths";
import { codeFontStack, SYSTEM_CODE_FONT } from "./theme";
import { parseIdeOptions } from "./ideLayout";

const panes = (node: LayoutNode) => groups(node).map((g) => g.tabs[0]);
const options = (patch: Partial<IdeLayoutOptions>): IdeLayoutOptions => ({ ...DEFAULT_IDE_OPTIONS, ...patch });

describe("the IDE layouts", () => {
  it("has the editor, the terminal, and the chat in the classic layout", () => {
    expect(panes(ideLayoutFor(options({})))).toEqual(["editor", "terminal", "chat"]);
  });

  it("puts the chat on the left side", () => {
    const layout = ideLayoutFor(options({ chatSide: "left" }));
    expect(panes(layout)[0]).toBe("chat");
    expect(layout.type === "split" && layout.sizes[0]).toBeCloseTo(0.3);
  });

  it("has no terminal in the focus layout", () => {
    expect(panes(ideLayoutFor(options({ preset: "focus" })))).toEqual(["editor", "chat"]);
  });

  it("puts the terminal under everything in the wide terminal layout", () => {
    const layout = ideLayoutFor(options({ preset: "wideTerminal", terminalShare: 0.4 }));
    expect(layout.type === "split" && layout.direction).toBe("column");
    expect(panes(layout)).toEqual(["editor", "chat", "terminal"]);
    expect(layout.type === "split" && layout.sizes[1]).toBeCloseTo(0.4);
  });

  it("shows the Changes pane in the review layout", () => {
    expect(panes(ideLayoutFor(options({ preset: "review" })))).toEqual(["editor", "diff", "terminal", "chat"]);
  });

  it("keeps the sizes in range", () => {
    const layout = ideLayoutFor(options({ chatShare: 5, terminalShare: Number.NaN }));
    expect(layout.type === "split" && layout.sizes[1]).toBeCloseTo(0.5);
  });

  it("reads the saved options, and gives the defaults for bad values", () => {
    expect(parseIdeOptions('{"preset":"focus","chatSide":"left","chatShare":0.4,"terminalShare":0.2}')).toEqual({
      preset: "focus",
      chatSide: "left",
      chatShare: 0.4,
      terminalShare: 0.2,
    });
    expect(parseIdeOptions('{"preset":"nope","chatShare":0.33}')).toEqual(DEFAULT_IDE_OPTIONS);
    expect(parseIdeOptions("not json")).toEqual(DEFAULT_IDE_OPTIONS);
  });
});

describe("the files that the editor can open", () => {
  it("opens text files and files with no extension", () => {
    for (const path of ["src/app.py", "README.md", "Makefile", ".gitignore", "data/notes.TXT"]) expect(isEditableFile(path)).toBe(true);
  });

  it("does not open binary files", () => {
    for (const path of ["logo.PNG", "build/app.exe", String.raw`build\app.exe`, "docs/spec.pdf", "a/b/archive.tar.gz", "model.safetensors"]) {
      expect(isEditableFile(path)).toBe(false);
    }
  });
});

describe("the code font", () => {
  it("uses the monospace font of the system", () => {
    expect(codeFontStack(SYSTEM_CODE_FONT)).toMatch(/^ui-monospace, "Cascadia Mono"/);
    expect(codeFontStack(SYSTEM_CODE_FONT)).not.toContain("JetBrains");
  });
});
