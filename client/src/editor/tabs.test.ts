import { describe, expect, it } from "vitest";
import { withOpened } from "./tabs";

const tab = (path: string, pinned = false) => ({ path, pinned });

describe("withOpened", () => {
  it("adds the first file as an unpinned tab", () => {
    expect(withOpened([], tab("a.ts"))).toEqual({ list: [tab("a.ts")], replaced: null });
  });

  it("puts the next file in the place of the unpinned tab", () => {
    const list = [tab("a.ts", true), tab("b.ts"), tab("c.ts", true)];
    expect(withOpened(list, tab("d.ts"))).toEqual({
      list: [tab("a.ts", true), tab("d.ts"), tab("c.ts", true)],
      replaced: "b.ts",
    });
  });

  it("adds a tab when all the tabs are pinned", () => {
    const list = [tab("a.ts", true)];
    expect(withOpened(list, tab("b.ts"))).toEqual({ list: [tab("a.ts", true), tab("b.ts")], replaced: null });
  });

  it("keeps the unpinned tab when a pinned file opens", () => {
    const list = [tab("a.ts")];
    expect(withOpened(list, tab("b.ts", true))).toEqual({ list: [tab("a.ts"), tab("b.ts", true)], replaced: null });
  });

  it("does not change the list for a file that is open", () => {
    const list = [tab("a.ts", true), tab("b.ts")];
    expect(withOpened(list, tab("a.ts")).list).toBe(list);
    expect(withOpened(list, tab("b.ts")).list).toBe(list);
  });

  it("pins the tab of an open file when the file opens pinned", () => {
    const list = [tab("a.ts")];
    expect(withOpened(list, tab("a.ts", true))).toEqual({ list: [tab("a.ts", true)], replaced: null });
  });
});
