import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, toSplitRows, wordSegments } from "./diff";

const DIFF = `--- a/src/app.py
+++ b/src/app.py
@@ -1,4 +1,5 @@ def main
 import os
-x = 1
-y = 2
+x = 10
+y = 2
+z = 3

 print(x)
@@ -20,2 +21,2 @@
-old
+new
`;

describe("parseUnifiedDiff", () => {
  it("reads the path, the hunks, the line numbers, and the counts", () => {
    const d = parseUnifiedDiff(DIFF);
    expect(d.path).toBe("src/app.py");
    expect(d.added).toBe(4);
    expect(d.removed).toBe(3);
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[0].header).toBe("def main");
    const [ctx, del1] = d.hunks[0].lines;
    expect(ctx).toEqual({ kind: "context", text: "import os", oldNo: 1, newNo: 1 });
    expect(del1).toEqual({ kind: "del", text: "x = 1", oldNo: 2 });
    // The empty context line keeps its place, and the numbers continue after it.
    expect(d.hunks[0].lines.at(-2)).toEqual({ kind: "context", text: "", oldNo: 4, newNo: 5 });
    expect(d.hunks[0].lines.at(-1)).toEqual({ kind: "context", text: "print(x)", oldNo: 5, newNo: 6 });
    expect(d.hunks[1].lines[1]).toEqual({ kind: "add", text: "new", newNo: 21 });
  });

  it("removes carriage returns and skips the no-newline marker", () => {
    const d = parseUnifiedDiff("--- a/f\r\n+++ b/f\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n\\ No newline at end of file\n");
    expect(d.hunks[0].lines).toEqual([
      { kind: "del", text: "a", oldNo: 1 },
      { kind: "add", text: "b", newNo: 1 },
    ]);
  });

  it("marks a new file", () => {
    const d = parseUnifiedDiff("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n");
    expect(d).toMatchObject({ path: "new.txt", isNewFile: true, added: 1, removed: 0 });
  });
});

describe("toSplitRows", () => {
  it("pairs deleted lines with the added lines after them", () => {
    const rows = toSplitRows(parseUnifiedDiff(DIFF).hunks[0]);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["import os", "import os"],
      ["x = 1", "x = 10"],
      ["y = 2", "y = 2"],
      [null, "z = 3"],
      ["", ""],
      ["print(x)", "print(x)"],
    ]);
  });
});

describe("wordSegments", () => {
  it("marks only the changed words of similar lines", () => {
    const w = wordSegments("const port = 8000;", "const port = 9000;")!;
    expect(w.left.filter((s) => s.changed).map((s) => s.text)).toEqual(["8000"]);
    expect(w.right.filter((s) => s.changed).map((s) => s.text)).toEqual(["9000"]);
  });

  it("returns null for lines that are too different", () => {
    expect(wordSegments("alpha beta gamma", "completely other text here")).toBeNull();
  });
});
