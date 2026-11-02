import { describe, expect, it } from "vitest";
import { startBranch, worktreeLabel } from "./WorktreeMenu";

const info = { repo: true, current: "main", branches: ["main", "feature", "old"] };

describe("the worktree chip", () => {
  it("starts from the saved branch if it still exists, else from the current branch", () => {
    expect(startBranch({ on: true, base: "feature" }, info)).toBe("feature");
    expect(startBranch({ on: true, base: "deleted" }, info)).toBe("main");
    expect(startBranch({ on: true, base: null }, info)).toBe("main");
    expect(startBranch({ on: true, base: null }, { ...info, current: null })).toBe("main"); // A detached HEAD.
    expect(startBranch({ on: true, base: null }, { repo: false, current: null, branches: [] })).toBeNull();
    expect(startBranch({ on: true, base: null }, null)).toBeNull();
  });

  it("shows the branch, and the worktree when it is on", () => {
    expect(worktreeLabel({ on: false, base: null }, info)).toBe("main");
    expect(worktreeLabel({ on: true, base: "feature" }, info)).toBe("Worktree from feature");
    expect(worktreeLabel({ on: true, base: null }, { repo: true, current: null, branches: [] })).toBe("Worktree");
  });
});
