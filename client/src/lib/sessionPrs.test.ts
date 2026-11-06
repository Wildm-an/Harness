import { describe, expect, it } from "vitest";
import type { ChatItem } from "../chat/state";
import type { PullRequest } from "../daemon/protocol";
import { listedPrs, prKeyUrl, prShortRef, sessionPrUrls } from "./pr";

const tool = (id: string, name: string, input: unknown, output: string, status: "done" | "error" = "done"): ChatItem => ({ kind: "tool", id, name, input, output, status });
const pr = (n: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  number: n, state: "open", url: `https://github.com/Wildm-an/Harness/pull/${n}`, title: `PR ${n}`, repo: "Wildm-an/Harness", ...extra,
});

describe("sessionPrUrls", () => {
  it("finds the pull requests of gh pr create and of create pull request tools, the newest first", () => {
    const items = [
      tool("1", "bash", { command: "git push -u origin x && gh pr create --fill" }, "https://github.com/Wildm-an/Harness/pull/17\n"),
      tool("2", "mcp__github__create_pull_request", { title: "t" }, '{"html_url":"https://github.com/Wildm-an/Harness/pull/19","url":"https://api.github.com/repos/Wildm-an/Harness/pulls/19"}'),
    ];
    expect(sessionPrUrls(items)).toEqual(["https://github.com/Wildm-an/Harness/pull/19", "https://github.com/Wildm-an/Harness/pull/17"]);
  });

  it("ignores links that other tools only read or name", () => {
    const items = [
      tool("1", "bash", { command: "gh pr list" }, "https://github.com/Wildm-an/Harness/pull/3"),
      tool("2", "web_fetch", { url: "x" }, "https://github.com/Wildm-an/Harness/pull/4"),
      tool("3", "mcp__github__get_pull_request", {}, "https://github.com/Wildm-an/Harness/pull/5"),
      tool("4", "bash", { command: "gh pr create" }, "https://github.com/Wildm-an/Harness/pull/6", "error"),
    ];
    expect(sessionPrUrls(items)).toEqual([]);
  });

  it("lists each pull request one time, at the place of its last mention", () => {
    const items = [
      tool("1", "bash", { command: "gh pr create" }, "https://github.com/Wildm-an/Harness/pull/7"),
      tool("2", "bash", { command: "gh pr create" }, "https://github.com/Wildm-an/Harness/pull/8"),
      tool("3", "bash", { command: "gh pr create" }, "a pull request already exists: https://github.com/Wildm-an/Harness/pull/7/files"),
    ];
    expect(sessionPrUrls(items)).toEqual(["https://github.com/Wildm-an/Harness/pull/7", "https://github.com/Wildm-an/Harness/pull/8"]);
  });
});

describe("listedPrs", () => {
  const urls = ["https://github.com/Wildm-an/Harness/pull/19", "https://github.com/Wildm-an/Harness/pull/17"];

  it("adds the pull request of the branch when the list does not have it", () => {
    const rows = listedPrs(urls, pr(12), () => undefined);
    expect(rows.map((r) => r.number)).toEqual([19, 17, 12]);
    expect(rows[2].info?.title).toBe("PR 12");
  });

  it("uses the newer reply of the store, else the branch status", () => {
    const store = (url: string) => (url.endsWith("/17") ? pr(17, { state: "merged" }) : undefined);
    const rows = listedPrs(urls, pr(17), store);
    expect(rows).toHaveLength(2);
    expect(rows[1].info?.state).toBe("merged");
    expect(rows[0].info).toBeUndefined();
    expect(listedPrs([], pr(12), () => undefined)[0].info?.state).toBe("open");
    expect(listedPrs([], pr(12), () => pr(12, { state: "closed" }))[0].info?.state).toBe("closed");
  });
});

describe("prKeyUrl", () => {
  it("gives the form of the PR list", () => {
    expect(prKeyUrl("https://github.com/Wildm-an/Harness/pull/18/files")).toBe("https://github.com/Wildm-an/Harness/pull/18");
    expect(prKeyUrl(null)).toBeNull();
  });
});

describe("prShortRef", () => {
  it("gives the repository name and the number, as the Claude app", () => {
    expect(prShortRef(pr(18))).toBe("Harness #18");
    expect(prShortRef({ number: 5, repo: null, url: null })).toBe("#5");
  });
});
