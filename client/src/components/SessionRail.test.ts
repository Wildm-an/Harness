import { describe, expect, it } from "vitest";
import { showWorktreeRow } from "./SessionRail";

describe("the Worktree row of the Environment section", () => {
  const worktree = { path: "C:/p/.harness/worktrees/a", branch: "harness/a", base: "master" } as never;

  it("hides when the session is not in a worktree and the worktree option of the project is off", () => {
    expect(showWorktreeRow({ worktree: null, worktreeOption: false })).toBe(false);
  });

  it("shows when the worktree option of the project is on", () => {
    expect(showWorktreeRow({ worktree: null, worktreeOption: true })).toBe(true);
  });

  it("shows for a session in a worktree, also when the option is off now", () => {
    expect(showWorktreeRow({ worktree, worktreeOption: false })).toBe(true);
  });
});
