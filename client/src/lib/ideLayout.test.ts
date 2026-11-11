import { describe, expect, it } from "vitest";
import {
  closePane,
  DEFAULT_IDE_OPTIONS,
  defaultLayout,
  groups,
  ideLayoutFor,
  layoutSignature,
  legacyIdeLayoutFor,
  openPane,
  reopenInSlot,
  type IdeLayoutOptions,
  type LayoutNode,
  type PaneId,
  type PaneSlot,
} from "../layout/model";
import { isEditableFile } from "../editor/paths";
import { codeFontStack, SYSTEM_CODE_FONT } from "./theme";
import { parseIdeOptions } from "./ideLayout";

const panes = (node: LayoutNode) => groups(node).map((g) => g.tabs[0]);
const options = (patch: Partial<IdeLayoutOptions>): IdeLayoutOptions => ({ ...DEFAULT_IDE_OPTIONS, ...patch });

describe("the IDE layouts", () => {
  it("is laid out as VS Code by default: Files at the left, the editor over the terminal, the chat at the right", () => {
    const layout = ideLayoutFor(options({}));
    expect(panes(layout)).toEqual(["files", "editor", "terminal", "chat"]);
    if (layout.type !== "split") throw new Error("not a split");
    const [files, middle, chat] = layout.children;
    expect(layout.direction).toBe("row");
    expect(files.type === "group" && files.tabs).toEqual(["files"]); // The full height.
    expect(middle.type === "split" && middle.direction).toBe("column"); // The terminal only under the editor.
    expect(chat.type === "group" && chat.tabs).toEqual(["chat"]); // The full height.
  });

  it("puts the chat on the left side", () => {
    const layout = ideLayoutFor(options({ chatSide: "left" }));
    expect(panes(layout).slice(0, 2)).toEqual(["chat", "files"]);
    expect(layout.type === "split" && layout.sizes[0]).toBeCloseTo(0.3);
  });

  it("has no terminal in the focus layout", () => {
    expect(panes(ideLayoutFor(options({ preset: "focus" })))).toEqual(["files", "editor", "chat"]);
  });

  it("puts the terminal under everything in the wide terminal layout", () => {
    const layout = ideLayoutFor(options({ preset: "wideTerminal", terminalShare: 0.4 }));
    expect(layout.type === "split" && layout.direction).toBe("column");
    expect(panes(layout)).toEqual(["files", "editor", "chat", "terminal"]);
    expect(layout.type === "split" && layout.sizes[1]).toBeCloseTo(0.4);
  });

  it("shows the Changes pane in the review layout", () => {
    expect(panes(ideLayoutFor(options({ preset: "review" })))).toEqual(["files", "editor", "diff", "terminal", "chat"]);
  });

  it("keeps the sizes in range", () => {
    const layout = ideLayoutFor(options({ chatShare: 5, terminalShare: Number.NaN }));
    expect(layout.type === "split" && layout.sizes[2]).toBeCloseTo(0.5);
  });

  it("knows a saved layout that is still the old default, and no other", () => {
    const old = legacyIdeLayoutFor(options({}));
    expect(layoutSignature(old)).toBe(layoutSignature(legacyIdeLayoutFor(options({})))); // The window ids do not count.
    expect(layoutSignature(old)).not.toBe(layoutSignature(ideLayoutFor(options({}))));
    if (old.type !== "split") throw new Error("not a split");
    const resized = { ...old, sizes: [0.6, 0.4] }; // The user dragged the edge.
    expect(layoutSignature(resized)).not.toBe(layoutSignature(old));
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

describe("a closed pane of the IDE view", () => {
  const sizesOf = (node: LayoutNode): string => layoutSignature(node);

  it("opens again in its last place and size", () => {
    const start = resize(ideLayoutFor(options({})), "terminal", 0.42);
    const slots = new Map<PaneId, PaneSlot>();
    const closed = closePane(start, "terminal");
    expect(reopenInSlot(start, closed, slots)).toBe(closed);
    expect(slots.has("terminal")).toBe(true);
    // openPane alone puts the terminal in another place; reopenInSlot moves it back.
    const opened = openPane(closed, "terminal");
    const placed = reopenInSlot(closed, opened, slots);
    expect(sizesOf(placed)).toBe(sizesOf(start));
  });

  it("keeps the window ids of the opened layout, so the pane does not mount again", () => {
    const start = resize(ideLayoutFor(options({})), "terminal", 0.42);
    const slots = new Map<PaneId, PaneSlot>();
    const closed = closePane(start, "terminal");
    reopenInSlot(start, closed, slots);
    const opened = openPane(closed, "terminal");
    const placed = reopenInSlot(closed, opened, slots);
    expect(placed).not.toBe(opened); // The sizes changed.
    const ids = (node: LayoutNode): string[] => (node.type === "group" ? [node.id] : [node.id, ...node.children.flatMap(ids)]);
    expect(ids(placed)).toEqual(ids(opened));
    expect(new Set(ids(placed)).size).toBe(ids(placed).length);
  });

  it("gives the space of a closed pane to the pane next to it", () => {
    const start = ideLayoutFor(options({}));
    const closed = closePane(start, "files");
    if (closed.type !== "split" || start.type !== "split") throw new Error("not a split");
    expect(closed.sizes[0]).toBeCloseTo(start.sizes[0] + start.sizes[1]); // The editor and terminal column.
    expect(closed.sizes[1]).toBeCloseTo(start.sizes[2]); // The chat keeps its width.
  });

  it("does not move panes of a new layout", () => {
    const slots = new Map<PaneId, PaneSlot>();
    const ide = ideLayoutFor(options({}));
    const code = defaultLayout();
    expect(reopenInSlot(ide, code, slots)).toBe(code);
    expect(reopenInSlot(code, ide, slots)).toBe(ide);
    expect(slots.size).toBe(0);
  });
});

/** The layout with the share of the terminal in its column set to ``share``. */
function resize(node: LayoutNode, pane: PaneId, share: number): LayoutNode {
  if (node.type === "group") return node;
  const i = node.children.findIndex((c) => c.type === "group" && c.tabs[0] === pane);
  if (i >= 0 && node.children.length === 2) {
    const sizes = i === 0 ? [share, 1 - share] : [1 - share, share];
    return { ...node, sizes };
  }
  return { ...node, children: node.children.map((c) => resize(c, pane, share)) };
}
