import { describe, expect, it } from "vitest";
import { absolutePath, deleteText, normalizePath, openFolderBlocked, renamedPath, renameProblem, selectionReference } from "./paths";
import { parsePathRef } from "../lib/openPath";

describe("editor paths", () => {
  it("makes chat paths relative to the project", () => {
    expect(normalizePath("./src/app.py", "C:\\work\\proj")).toBe("src/app.py");
    expect(normalizePath("C:\\work\\proj\\src\\app.py", "C:\\work\\proj")).toBe("src/app.py");
    expect(normalizePath("c:/WORK/proj/a.ts", "C:\\work\\proj")).toBe("a.ts");
    expect(normalizePath("/home/me/p/x.py", "/home/me/p/")).toBe("x.py");
  });

  it("makes a reference for the selected lines", () => {
    expect(selectionReference("a.py", { startLineNumber: 10, endLineNumber: 25, endColumn: 4 })).toBe("@a.py:10-25");
    expect(selectionReference("a.py", { startLineNumber: 10, endLineNumber: 11, endColumn: 1 })).toBe("@a.py:10");
    expect(selectionReference("a.py", { startLineNumber: 7, endLineNumber: 7, endColumn: 1 })).toBe("@a.py:7");
  });

  it("finds file paths in inline code", () => {
    expect(parsePathRef("src/app.py:42")).toEqual({ path: "src/app.py", line: 42 });
    expect(parsePathRef("./README.md")).toEqual({ path: "README.md", line: undefined });
    expect(parsePathRef("src/app.py:10-25")).toEqual({ path: "src/app.py", line: 10 });
    expect(parsePathRef("npm run dev")).toBeNull();
    expect(parsePathRef("1.2.3")).toBeNull();
    expect(parsePathRef("git status")).toBeNull();
    expect(parsePathRef("add")).toBeNull();
  });
});

describe("open folder", () => {
  it("can change the folder of a connected session that is idle", () => {
    expect(openFolderBlocked({ connected: true, running: false, worktree: false })).toBeNull();
  });

  it("tells why it cannot change the folder", () => {
    expect(openFolderBlocked({ connected: false, running: false, worktree: false })).toMatch(/Connect/);
    expect(openFolderBlocked({ connected: true, running: false, worktree: true })).toMatch(/worktree/);
    expect(openFolderBlocked({ connected: true, running: true, worktree: false })).toMatch(/end of the turn/);
  });
});

describe("the delete question", () => {
  it("names a file or a folder, and the Recycle Bin", () => {
    expect(deleteText({ path: "a.py", type: "file" }, [])).toMatch(/^The file goes to the Recycle Bin/);
    expect(deleteText({ path: "src", type: "dir" }, [])).toMatch(/^The folder and all the files in it go/);
  });

  it("counts the open files with unsaved changes in the item", () => {
    const open = [
      { path: "src/a.py", dirty: true },
      { path: "src/b.py", dirty: true },
      { path: "srcx/c.py", dirty: true }, // Not in src.
      { path: "src/d.py", dirty: false },
    ];
    expect(deleteText({ path: "src", type: "dir" }, open)).toContain("2 open files have unsaved changes");
    expect(deleteText({ path: "src/a.py", type: "file" }, open)).toContain("An open file has unsaved changes");
    expect(deleteText({ path: "src/d.py", type: "file" }, open)).not.toContain("unsaved");
  });
});

describe("rename and copy path in the file tree", () => {
  it("moves the item and the files in a renamed folder", () => {
    expect(renamedPath("src/a.py", "src/a.py", "src/b.py")).toBe("src/b.py");
    expect(renamedPath("src/lib/x.ts", "src/lib", "src/core")).toBe("src/core/x.ts");
    expect(renamedPath("src/library/x.ts", "src/lib", "src/core")).toBeNull(); // Only the same folder.
    expect(renamedPath("other.py", "src", "lib")).toBeNull();
  });

  it("makes the full path with the separator of the session folder", () => {
    expect(absolutePath("C:\\Users\\me\\app", "src/a.py")).toBe("C:\\Users\\me\\app\\src\\a.py");
    expect(absolutePath("/home/me/app/", "src/a.py")).toBe("/home/me/app/src/a.py");
    expect(absolutePath("/home/me/app", ".")).toBe("/home/me/app");
  });

  it("accepts a plain name only", () => {
    expect(renameProblem("b.py")).toBeNull();
    expect(renameProblem("  ")).toBe("Give a name.");
    expect(renameProblem("..")).not.toBeNull();
    expect(renameProblem("src/b.py")).toContain("no /");
    expect(renameProblem("src\\b.py")).toContain("no /");
  });
});
