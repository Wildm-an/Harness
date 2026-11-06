import { describe, expect, it } from "vitest";
import type { GitChanges } from "../daemon/protocol";
import { compareUrl, gitActions, prRefText, prUrlRef, timeAgo, workRows, workSignature } from "./pr";

const base: GitChanges = {
  repo: true, branch: "feature", base: "origin/main", added: 0, removed: 0, files: 0, github: true,
  remote: true, upstream: "origin/feature", behind: 0,
  uncommitted: { files: 0, added: 0, removed: 0 },
  unpushed: { commits: 0, files: 0, added: 0, removed: 0 },
  pushed: { commits: 0, files: 0, added: 0, removed: 0 },
  pr: null,
};
const open = { number: 5, state: "open" as const, url: "https://github.com/o/r/pull/5", title: "T" };

describe("prUrlRef", () => {
  it("reads the repository and the number", () => {
    expect(prUrlRef("https://github.com/Wildm-an/Harness/pull/5")).toEqual({ repo: "Wildm-an/Harness", number: 5 });
    expect(prUrlRef("https://github.com/o/r/pull/12/files")).toEqual({ repo: "o/r", number: 12 });
    expect(prUrlRef("https://github.com/o/r/issues/12")).toBeNull();
    expect(prUrlRef("https://example.com/o/r/pull/1")).toBeNull();
  });
  it("names the pull request", () => {
    expect(prRefText({ number: 5, url: "https://github.com/o/r/pull/5" })).toBe("o/r #5");
    expect(prRefText({ number: 5, url: null })).toBe("#5");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  it("gives a short time", () => {
    expect(timeAgo("2026-11-05T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-11-05T11:58:00Z", now)).toBe("2m ago");
    expect(timeAgo("2026-11-05T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-11-01T12:00:00Z", now)).toBe("4d ago");
    expect(timeAgo(null, now)).toBeNull();
  });
});

describe("workRows", () => {
  it("shows only the parts with work", () => {
    const rows = workRows({
      ...base,
      uncommitted: { files: 2, added: 4, removed: 1 },
      pushed: { commits: 3, files: 5, added: 40, removed: 2 },
    });
    expect(rows.map((r) => [r.kind, r.label, r.detail])).toEqual([
      ["uncommitted", "Uncommitted", "2 files"],
      ["pushed", "Pushed", "3 commits"],
    ]);
  });
});

describe("gitActions", () => {
  it("offers Create PR for work with no open pull request, as in the Claude app", () => {
    const work = { ...base, files: 2, uncommitted: { files: 2, added: 1, removed: 0 } };
    expect(gitActions(work, null)).toEqual({ primary: "pr", choices: ["pr", "draft"], manual: true });
    // The checked action of the menu is the action of the button.
    expect(gitActions(work, null, "draft").primary).toBe("draft");
    expect(gitActions(work, null, "push").primary).toBe("pr");
    expect(gitActions({ ...base, files: 0 }, null).primary).toBeNull();
  });
  it("offers Commit and push or Push for an open pull request", () => {
    expect(gitActions({ ...base, uncommitted: { files: 1, added: 1, removed: 0 } }, open).primary).toBe("commitPush");
    expect(gitActions({ ...base, unpushed: { commits: 2, files: 1, added: 1, removed: 0 } }, open).primary).toBe("push");
    expect(gitActions({ ...base, files: 3, pushed: { commits: 1, files: 3, added: 1, removed: 0 } }, open).primary).toBeNull();
  });
  it("offers Create PR again after a merge", () => {
    expect(gitActions({ ...base, files: 1, uncommitted: { files: 1, added: 1, removed: 0 } }, { ...open, state: "merged" }).primary).toBe("pr");
  });
  it("offers Commit with no remote", () => {
    const local = { ...base, github: false, remote: false, upstream: null, unpushed: null, pushed: null, files: 1, uncommitted: { files: 1, added: 1, removed: 0 } };
    expect(gitActions(local, null)).toEqual({ primary: "commit", choices: ["commit"], manual: false });
  });
  it("checks Commit when the user chose it", () => {
    expect(gitActions({ ...base, uncommitted: { files: 1, added: 1, removed: 0 } }, open, "commit").primary).toBe("commit");
  });
  it("works with an older daemon (no parts)", () => {
    const old: GitChanges = { repo: true, branch: "f", base: null, added: 1, removed: 0, files: 1, github: true };
    expect(gitActions(old, null).primary).toBe("pr");
    expect(gitActions({ ...old, github: false }, null).primary).toBe("commit");
  });
});

describe("compareUrl", () => {
  it("opens the GitHub page that makes a pull request", () => {
    expect(compareUrl({ ...base, github_repo: "o/r", upstream: "origin/claude/x", base: "origin/master" })).toBe("https://github.com/o/r/compare/master...claude/x?expand=1");
  });
  it("needs the branch on the remote", () => {
    expect(compareUrl({ ...base, github_repo: "o/r", upstream: null })).toBeNull();
    expect(compareUrl({ ...base, github_repo: null })).toBeNull();
  });
});

describe("workSignature", () => {
  it("changes with the work", () => {
    const a = workSignature(base, null);
    expect(workSignature(base, null)).toBe(a);
    expect(workSignature({ ...base, uncommitted: { files: 1, added: 1, removed: 0 } }, null)).not.toBe(a);
    expect(workSignature(base, open)).not.toBe(a);
  });
});
