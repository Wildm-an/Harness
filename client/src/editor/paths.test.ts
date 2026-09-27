import { describe, expect, it } from "vitest";
import { normalizePath, selectionReference } from "./paths";
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
