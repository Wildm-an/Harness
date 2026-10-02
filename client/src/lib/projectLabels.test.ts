import { describe, expect, it } from "vitest";
import { parentHints } from "./projectLabels";

const item = (key: string, name: string, path: string) => ({ key, name, path });

describe("parentHints", () => {
  it("adds nothing to unique names", () => {
    expect(parentHints([item("a", "app", "C:/work/app"), item("b", "site", "C:/work/site")]).size).toBe(0);
  });

  it("adds the parent folder to the same names", () => {
    const hints = parentHints([item("a", "app", String.raw`C:\work\app`), item("b", "App", String.raw`D:\other\app`), item("c", "site", "C:/site")]);
    expect(hints.get("a")).toBe("work");
    expect(hints.get("b")).toBe("other");
    expect(hints.has("c")).toBe(false);
  });

  it("uses more parent folders when the parents have the same name", () => {
    const hints = parentHints([item("a", "app", "/home/x/src/app"), item("b", "app", "/home/y/src/app")]);
    expect(hints.get("a")).toBe("x/src");
    expect(hints.get("b")).toBe("y/src");
  });

  it("uses the drive when the folders differ only by the drive", () => {
    const hints = parentHints([item("a", "app", "C:/app"), item("b", "app", "D:/app")]);
    expect(hints.get("a")).toBe("C:/app");
    expect(hints.get("b")).toBe("D:/app");
  });
});
