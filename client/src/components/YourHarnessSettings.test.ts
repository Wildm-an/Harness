import { describe, expect, it } from "vitest";
import { memoryName, memoryProblem } from "./YourHarnessSettings";

describe("the memory form", () => {
  it("makes a name from the first words, as the daemon does", () => {
    expect(memoryName("I am a Dev, at ACME!")).toBe("i-am-a-dev-at-acme");
    expect(memoryName("Ünïcode only")).toBe("n-code-only");
    expect(memoryName("")).toBe("");
  });

  it("finds the first problem", () => {
    const ok = { name: "user-role", description: "The role.", content: "Engineer." };
    expect(memoryProblem(ok)).toBeNull();
    expect(memoryProblem({ ...ok, name: "Bad Name" })).toMatch(/lowercase/);
    expect(memoryProblem({ ...ok, name: "-x" })).toMatch(/lowercase/);
    expect(memoryProblem({ ...ok, description: " " })).toMatch(/description/);
    expect(memoryProblem({ ...ok, description: "x".repeat(201) })).toMatch(/200/);
    expect(memoryProblem({ ...ok, content: "" })).toMatch(/content/);
  });
});
