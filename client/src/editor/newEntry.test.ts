import { describe, expect, it } from "vitest";
import { newEntryProblem, newEntryStart } from "./paths";
import { filterLanguages, languageItems } from "./LanguageMenu";

describe("New file and New folder", () => {
  it("accepts a path in the project", () => {
    expect(newEntryProblem("src/utils/helpers.py")).toBeNull();
    expect(newEntryProblem(String.raw`src\utils\helpers.py`)).toBeNull();
    expect(newEntryProblem("README")).toBeNull();
  });

  it("tells why a name cannot work", () => {
    expect(newEntryProblem("  ")).toBe("Type a name.");
    expect(newEntryProblem("../outside.py")).toMatch(/in the project/);
    expect(newEntryProblem(String.raw`C:\temp\x.py`)).toMatch(/in the project/);
    expect(newEntryProblem("/etc/x")).toMatch(/in the project/);
    expect(newEntryProblem("bad?name.py")).toMatch(/cannot have/);
  });

  it("starts the name in the folder of the open file", () => {
    expect(newEntryStart("src/app/main.py")).toBe("src/app/");
    expect(newEntryStart("README.md")).toBe("");
    expect(newEntryStart(null)).toBe("");
  });
});

describe("the language menu", () => {
  const items = languageItems([
    { id: "python", aliases: ["Python", "py"] },
    { id: "plaintext", aliases: ["Plain Text"] },
    { id: "typescript", aliases: ["TypeScript"] },
    { id: "python" },
    { id: "rust" },
  ]);

  it("lists each language once, plain text first, then by name", () => {
    expect(items.map((i) => i.id)).toEqual(["plaintext", "python", "rust", "typescript"]);
    expect(items[1].name).toBe("Python");
  });

  it("filters by the name or the id", () => {
    expect(filterLanguages(items, "type").map((i) => i.id)).toEqual(["typescript"]);
    expect(filterLanguages(items, "RU").map((i) => i.id)).toEqual(["rust"]);
    expect(filterLanguages(items, "")).toHaveLength(4);
  });
});
