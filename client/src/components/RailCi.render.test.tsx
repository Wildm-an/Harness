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

describe("the CI count of a rail PR row", () => {
  it("shows the GitHub icon and the count of the checks, with the checks closed", () => {
    const html = renderToStaticMarkup(<RailPrList prs={row(pr)} onOpen={noop} onFixCi={noop} />);
    expect(html).toContain("rail-ci-count");
    expect(html).toContain("<span>2/4</span>");
    expect(html).toContain("ci-icon ci-fail");
    expect(html).toContain('aria-label="2 of 4 checks failed. Show the checks."');
    expect(html).not.toContain("rail-ci-menu");
  });

  it("shows no count with no checks", () => {
    const html = renderToStaticMarkup(<RailPrList prs={row({ ...pr, checks: null })} onOpen={noop} onFixCi={noop} />);
    expect(html).not.toContain("rail-ci");
  });

  it("shows the running icon for running checks", () => {
    const html = renderToStaticMarkup(<RailPrList prs={row({ ...pr, checks: { ...checks, state: "pending", failed: 0, pending: 2 } })} onOpen={noop} onFixCi={noop} />);
    expect(html).toContain("ci-icon ci-pending");
    expect(html).toContain("ci-icon-arc");
    expect(html).toContain("<span>2/4</span>");
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
