import { describe, expect, it } from "vitest";
import { folderNameProblem, joinFolder } from "./RecentFolders";

describe("joinFolder", () => {
  it("uses the backslash for a Windows location", () => {
    expect(joinFolder("C:\\Users\\me\\projects", "app")).toBe("C:\\Users\\me\\projects\\app");
    expect(joinFolder("C:\\Users\\me\\projects\\", "app")).toBe("C:\\Users\\me\\projects\\app");
  });

  it("uses the slash for a POSIX location", () => {
    expect(joinFolder("/home/me/projects", "app")).toBe("/home/me/projects/app");
    expect(joinFolder("/home/me/projects/", "app")).toBe("/home/me/projects/app");
  });
});

describe("folderNameProblem", () => {
  it("accepts a usual folder name", () => {
    expect(folderNameProblem("my-app")).toBeNull();
    expect(folderNameProblem("My App 2")).toBeNull();
  });

  it("refuses an empty name or a path", () => {
    expect(folderNameProblem("")).not.toBeNull();
    expect(folderNameProblem("a/b")).not.toBeNull();
    expect(folderNameProblem("a\\b")).not.toBeNull();
    expect(folderNameProblem("a:b")).not.toBeNull();
  });

  it("refuses a name that ends with a period or a space", () => {
    expect(folderNameProblem("..")).not.toBeNull();
    expect(folderNameProblem("app.")).not.toBeNull();
    expect(folderNameProblem("app ")).not.toBeNull();
  });
});
