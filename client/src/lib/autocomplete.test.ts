import { describe, expect, it } from "vitest";
import { PREFIX_CHARS, SUFFIX_CHARS, autocompleteOn, cursorContext, wantsCompletion } from "./autocomplete";

describe("editor autocomplete", () => {
  it("is on by default", () => {
    expect(autocompleteOn()).toBe(true);
  });

  it("splits the text at the cursor and cuts long text", () => {
    expect(cursorContext("abcdef", 2)).toEqual({ prefix: "ab", suffix: "cdef" });
    const long = "a".repeat(PREFIX_CHARS + 50) + "|" + "b".repeat(SUFFIX_CHARS + 50);
    const at = PREFIX_CHARS + 50;
    const { prefix, suffix } = cursorContext(long, at);
    expect(prefix.length).toBe(PREFIX_CHARS);
    expect(suffix.length).toBe(SUFFIX_CHARS);
    expect(suffix.startsWith("|")).toBe(true);
  });

  it("asks only where a completion can help", () => {
    expect(wantsCompletion("def add(a, b):\n    ", "\n")).toBe(true);
    expect(wantsCompletion("print(", ")\n")).toBe(true); // Only a closing bracket after the cursor.
    expect(wantsCompletion("x = foo", "bar()\n")).toBe(false); // Text after the cursor on the line.
    expect(wantsCompletion("   \n", "")).toBe(false); // An empty file.
  });
});
