import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrChecks, PullRequest } from "../daemon/protocol";
import { RailPrList } from "./RailChanges";
import { PrCard } from "./PrCard";

const checks: PrChecks = {
  state: "fail", total: 4, passed: 2, failed: 2, pending: 0, skipped: 0,
  items: [
    { name: "daemon (ubuntu-latest)", workflow: "test", state: "fail", url: "https://github.com/o/Harness/actions/runs/1/job/1" },
    { name: "daemon (windows-latest)", workflow: "test", state: "fail", url: "https://github.com/o/Harness/actions/runs/1/job/2" },
    { name: "client (ubuntu-latest)", workflow: "test", state: "pass", url: null },
    { name: "client (windows-latest)", workflow: "test", state: "pass", url: null },
  ],
};
const pr: PullRequest = { number: 78, state: "open", url: "https://github.com/o/Harness/pull/78", title: "Add CI", repo: "o/Harness", checks };
const row = (info: PullRequest) => [{ url: info.url, number: info.number, repo: info.repo ?? null, info }];
const noop = () => undefined;

describe("the CI line of a rail PR row", () => {
  it("shows the failed checks and Fix CI", () => {
    const html = renderToStaticMarkup(<RailPrList prs={row(pr)} onOpen={noop} onFixCi={noop} />);
    expect(html).toContain("2 of 4 checks failed");
    expect(html).toContain("ci-icon ci-fail");
    expect(html).toContain("Fix CI");
  });

  it("hides Fix CI while a turn runs, with no connection, and for a merged pull request", () => {
    expect(renderToStaticMarkup(<RailPrList prs={row(pr)} onOpen={noop} onFixCi={noop} running />)).not.toContain("Fix CI");
    expect(renderToStaticMarkup(<RailPrList prs={row(pr)} onOpen={noop} onFixCi={null} />)).not.toContain("Fix CI");
    expect(renderToStaticMarkup(<RailPrList prs={row({ ...pr, state: "merged" })} onOpen={noop} onFixCi={noop} />)).not.toContain("Fix CI");
  });

  it("shows no CI line with no checks", () => {
    const html = renderToStaticMarkup(<RailPrList prs={row({ ...pr, checks: null })} onOpen={noop} onFixCi={noop} />);
    expect(html).not.toContain("rail-ci");
  });

  it("shows passed checks with no Fix CI", () => {
    const html = renderToStaticMarkup(<RailPrList prs={row({ ...pr, checks: { ...checks, state: "pass", passed: 4, failed: 0 } })} onOpen={noop} onFixCi={noop} />);
    expect(html).toContain("All checks passed");
    expect(html).not.toContain("Fix CI");
  });
});

describe("the CI part of the hover card", () => {
  it("lists the failed checks", () => {
    const html = renderToStaticMarkup(<PrCard pr={pr} url={pr.url!} />);
    expect(html).toContain("2 of 4 checks failed");
    expect(html).toContain("test / daemon (ubuntu-latest)");
    expect(html).not.toContain("client (ubuntu-latest)");
  });
});

describe("the Auto-fix switch", () => {
  const autoFix = { on: true, onToggle: noop };
  it("shows when a pull request has checks", () => {
    const html = renderToStaticMarkup(<RailPrList prs={row(pr)} onOpen={noop} onFixCi={noop} autoFix={autoFix} />);
    expect(html).toContain("Auto-fix");
    expect(html).toContain('aria-checked="true"');
  });

  it("does not show with no checks or with no switch", () => {
    expect(renderToStaticMarkup(<RailPrList prs={row({ ...pr, checks: null })} onOpen={noop} onFixCi={noop} autoFix={autoFix} />)).not.toContain("Auto-fix");
    expect(renderToStaticMarkup(<RailPrList prs={row(pr)} onOpen={noop} onFixCi={noop} />)).not.toContain("Auto-fix");
  });
});
