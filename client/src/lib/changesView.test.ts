import { describe, expect, it } from "vitest";
import { fileRows, mergeRuns, splitPath } from "./changesView";

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -3,3 +3,3 @@
 const a = 1;
-const b = "old";
+const b = "new";
 const c = 3;
@@ -20,2 +20,3 @@ function f() {
 x();
+y();
 z();
`;

describe("the rows of the Changes pane", () => {
  it("shows the unmodified lines before and between the parts of a file", () => {
    const { rows, added, removed } = fileRows(PATCH);
    expect([added, removed]).toEqual([2, 1]);
    expect(rows[0]).toEqual({ kind: "gap", count: 2 }); // Lines 1 and 2.
    const gap = rows.filter((r) => r.kind === "gap");
    expect(gap).toEqual([{ kind: "gap", count: 2 }, { kind: "gap", count: 14 }]); // Lines 6 to 19.
  });

  it("marks the changed words of a removed line and the added line after it", () => {
    const { rows } = fileRows(PATCH);
    const del = rows.find((r) => r.kind === "del");
    const add = rows.find((r) => r.kind === "add");
    expect(del && "words" in del && del.words?.some((w) => w.changed && w.text.includes("old"))).toBe(true);
    expect(add && "words" in add && add.words?.some((w) => w.changed && w.text.includes("new"))).toBe(true);
    expect(del && "oldNo" in del ? del.oldNo : null).toBe(4);
  });

  it("has no gap at the start of a new file", () => {
    const { rows } = fileRows("--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n");
    expect(rows.map((r) => r.kind)).toEqual(["add", "add"]);
  });
});

describe("mergeRuns", () => {
  it("splits the syntax runs where a changed word starts and ends", () => {
    const runs = [{ text: "const ", cls: "mtk6" }, { text: '"new"', cls: "mtk20" }];
    const words = [{ text: 'const "', changed: false }, { text: "new", changed: true }, { text: '"', changed: false }];
    expect(mergeRuns(runs, words)).toEqual([
      { text: "const ", cls: "mtk6", changed: false },
      { text: '"', cls: "mtk20", changed: false },
      { text: "new", cls: "mtk20", changed: true },
      { text: '"', cls: "mtk20", changed: false },
    ]);
  });

  it("gives null when the runs have another text", () => {
    expect(mergeRuns([{ text: "a", cls: "" }], [{ text: "b", changed: true }])).toBeNull();
  });
});

describe("splitPath", () => {
  it("splits the file name and the folder", () => {
    expect(splitPath("client/src/lib/pr.ts")).toEqual({ name: "pr.ts", dir: "client/src/lib" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });
});
