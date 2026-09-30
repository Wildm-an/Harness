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
    expect(shape(defaultLayout())).toEqual({ row: [["chat"], ["editor", "browser"]] });
  });

  it("opens a new pane in the group without the chat, and activates a pane that is there", () => {
    let l = openPane(base(), "diff");
    expect(shape(l)).toEqual({ row: [["chat"], ["editor", "diff"]] });
    expect(findGroupOf(l, "diff")!.active).toBe("diff");
    l = openPane(l, "editor");
    expect(findGroupOf(l, "editor")!.active).toBe("editor");
    expect(shape(l)).toEqual({ row: [["chat"], ["editor", "diff"]] });
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

  it("moves a pane into another group and removes the empty group", () => {
    const l = base();
    const moved = movePane(l, "editor", findGroupOf(l, "chat")!.id, "center");
    expect(shape(moved)).toEqual(["chat", "editor"]);
    expect(moved.type === "group" && moved.active).toBe("editor");
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
    expect(shape(parseLayout(saved)!)).toEqual({ row: [["chat"], ["editor", "browser"]] });
    const noChat = { type: "group", id: "g1", tabs: ["editor"], active: "editor" };
    expect(findGroupOf(parseLayout(noChat)!, "chat")).not.toBeNull();
    const unknownTab = { type: "group", id: "g1", tabs: ["chat", "no-such-pane"], active: "no-such-pane" };
    expect(parseLayout(unknownTab)).toMatchObject({ tabs: ["chat"], active: "chat" });
  });
});
