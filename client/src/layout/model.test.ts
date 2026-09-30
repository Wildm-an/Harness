import { describe, expect, it } from "vitest";
import {
  closePane,
  defaultLayout,
  findGroupOf,
  group,
  groups,
  movePane,
  normalize,
  openPane,
  parseLayout,
  resize,
  setSideShare,
  sideShareOf,
  type LayoutNode,
  type Split,
} from "./model";

// A fixed start layout: the tests do not depend on the default layout.
const base = (): LayoutNode =>
  normalize({ type: "split", id: "s0", direction: "row", children: [group(["chat"]), group(["editor"])], sizes: [0.45, 0.55] });

const shape = (n: LayoutNode): unknown =>
  n.type === "group" ? n.tabs : { [n.direction]: n.children.map(shape) };

describe("layout", () => {
  it("has chat on the left and the editor on the right by default", () => {
    expect(shape(defaultLayout())).toEqual({ row: [["chat"], ["editor"]] });
  });

  it("opens each new pane in its own window, below the last window", () => {
    let l = openPane(base(), "diff");
    expect(shape(l)).toEqual({ row: [["chat"], { column: [["editor"], ["diff"]] }] });
    l = openPane(l, "terminal");
    expect(shape(l)).toEqual({ row: [["chat"], { column: [["editor"], ["diff"], ["terminal"]] }] });
    expect(openPane(l, "editor")).toEqual(l); // A pane that is open stays where it is.
  });

  it("gives each pane of an old saved group its own window", () => {
    const old = { type: "split", id: "s1", direction: "row", sizes: [0.4, 0.6],
      children: [{ type: "group", id: "g1", tabs: ["chat"], active: "chat" }, { type: "group", id: "g2", tabs: ["editor", "browser"], active: "browser" }] };
    expect(shape(parseLayout(old)!)).toEqual({ row: [["chat"], { column: [["editor"], ["browser"]] }] });
    const mixed = { type: "group", id: "g3", tabs: ["chat", "terminal"], active: "chat" };
    expect(shape(parseLayout(mixed)!)).toEqual({ row: [["chat"], ["terminal"]] });
  });

  it("adds a group on the right when all groups have the chat", () => {
    expect(shape(openPane(group(["chat"]), "editor"))).toEqual({ row: [["chat"], ["editor"]] });
  });

  it("moves a pane to a side of a group and makes a split", () => {
    const l = openPane(base(), "diff");
    const right = findGroupOf(l, "editor")!;
    const down = movePane(l, "diff", right.id, "bottom");
    expect(shape(down)).toEqual({ row: [["chat"], { column: [["editor"], ["diff"]] }] });
    const left = movePane(l, "diff", findGroupOf(l, "chat")!.id, "left");
    // A new group beside a group in a row joins the row.
    expect(shape(left)).toEqual({ row: [["diff"], ["chat"], ["editor"]] });
  });

  it("does not put two panes in one window", () => {
    const l = base();
    expect(movePane(l, "editor", findGroupOf(l, "chat")!.id, "center")).toBe(l);
  });

  it("does not move a single pane beside itself", () => {
    const l = base();
    const g = findGroupOf(l, "editor")!;
    expect(movePane(l, "editor", g.id, "right")).toBe(l);
  });

  it("closes a pane and removes its empty group", () => {
    const l = openPane(base(), "diff");
    expect(shape(closePane(l, "diff"))).toEqual({ row: [["chat"], ["editor"]] });
    const closed = closePane(closePane(l, "diff"), "editor");
    expect(shape(closed)).toEqual(["chat"]);
    expect(groups(closed)).toHaveLength(1);
  });

  it("keeps the sizes of a split at a sum of 1", () => {
    const l = base() as Split;
    const r = resize(l, l.id, [0.3, 0.7]) as Split;
    expect(r.sizes).toEqual([0.3, 0.7]);
    const n = normalize({ ...l, sizes: [2, 6] }) as Split;
    expect(n.sizes).toEqual([0.25, 0.75]);
  });

  it("reads only valid saved layouts, and always keeps the chat", () => {
    expect(parseLayout({ type: "nonsense" })).toBeNull();
    expect(parseLayout(null)).toBeNull();
    const saved = JSON.parse(JSON.stringify(defaultLayout()));
    expect(shape(parseLayout(saved)!)).toEqual({ row: [["chat"], ["editor"]] });
    const noChat = { type: "group", id: "g1", tabs: ["editor"], active: "editor" };
    expect(findGroupOf(parseLayout(noChat)!, "chat")).not.toBeNull();
    const unknownTab = { type: "group", id: "g1", tabs: ["chat", "no-such-pane"], active: "no-such-pane" };
    expect(parseLayout(unknownTab)).toMatchObject({ tabs: ["chat"], active: "chat" });
  });

  it("opens a new side area at the last width of the side windows", () => {
    setSideShare(0.3);
    const l = openPane(group(["chat"]), "terminal") as Split;
    expect(l.sizes[0]).toBeCloseTo(0.7);
    expect(sideShareOf(l)).toBeCloseTo(0.3);
    setSideShare(5); // Out of range: at most 0.8.
    expect(sideShareOf(openPane(group(["chat"]), "terminal"))).toBeCloseTo(0.8);
    setSideShare(0.55);
  });
});
