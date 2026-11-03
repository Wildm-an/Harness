import { describe, expect, it } from "vitest";
import { filesPromptText, isAddFilesShortcut, pathInProject } from "./fileRefs";

const key = (k: Partial<KeyboardEvent>) => ({ code: "KeyU", key: "u", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...k });

describe("Ctrl+U: add files to the prompt", () => {
  it("is Ctrl+U or Cmd+U with no other modifier", () => {
    expect(isAddFilesShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isAddFilesShortcut(key({ metaKey: true }))).toBe(true);
    expect(isAddFilesShortcut(key({}))).toBe(false);
    expect(isAddFilesShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("finds the path of a file in the project, with no case on Windows", () => {
    expect(pathInProject(String.raw`C:\Work\App\src\main.ts`, String.raw`c:\work\app`)).toBe("src/main.ts");
    expect(pathInProject("/home/me/app/README.md", "/home/me/app/")).toBe("README.md");
    expect(pathInProject(String.raw`C:\Work\Apple\x.ts`, String.raw`C:\Work\App`)).toBeNull();
    expect(pathInProject("/home/me/App/x.ts", "/home/me/app")).toBeNull(); // Case counts outside Windows.
  });

  it("makes @ references for project files, and quoted paths for the others", () => {
    const text = filesPromptText(
      [String.raw`C:\Work\App\src\main.ts`, String.raw`C:\Work\App\my notes.md`, String.raw`D:\Downloads\spec.txt`],
      String.raw`C:\Work\App`,
    );
    expect(text).toBe(String.raw`@src/main.ts "C:\Work\App\my notes.md" "D:\Downloads\spec.txt"`);
  });
});
