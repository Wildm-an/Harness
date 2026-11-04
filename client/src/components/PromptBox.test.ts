import { describe, expect, it } from "vitest";
import { draftOf, saveDraft } from "./PromptBox";

describe("the unsent prompt of a session", () => {
  it("stays with the session where the user typed it", () => {
    saveDraft("a", "Fix the login page");
    saveDraft("b", "Add a test");
    expect(draftOf("a")).toBe("Fix the login page");
    expect(draftOf("b")).toBe("Add a test");
    expect(draftOf("c")).toBe("");
  });

  it("is removed when the box is empty", () => {
    saveDraft("a", "text");
    saveDraft("a", "");
    expect(draftOf("a")).toBe("");
  });
});
