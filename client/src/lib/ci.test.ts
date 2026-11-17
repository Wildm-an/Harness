import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrChecks, PullRequest } from "../daemon/protocol";
import { MAX_AUTO_FIXES, autoFixOn, autoFixStep, checksUrl, ciSummary, failedCheckNames, finishedCi, fixCiPrompt, setAutoFix } from "./pr";
import { ciNotice } from "./notify";

const checks = (over: Partial<PrChecks>): PrChecks => ({ state: "pass", total: 4, passed: 4, failed: 0, pending: 0, skipped: 0, items: [], ...over });

const pr = (state: PrChecks["state"] | "none" | "old"): PullRequest => ({
  number: 78,
  state: "open",
  url: "https://github.com/o/Harness/pull/78",
  title: "Add CI",
  checks: state === "old" ? undefined : state === "none" ? null : checks({ state }),
});

describe("ciSummary", () => {
  it("names the failed, the running, and the passed checks", () => {
    expect(ciSummary(checks({ state: "fail", passed: 2, failed: 2 }))?.text).toBe("2 of 4 checks failed");
    expect(ciSummary(checks({ state: "fail", passed: 0, failed: 1, total: 1 }))?.text).toBe("1 check failed");
    expect(ciSummary(checks({ state: "pending", passed: 1, pending: 3 }))?.text).toBe("3 of 4 checks running");
    expect(ciSummary(checks({}))).toMatchObject({ state: "pass", text: "All checks passed", tip: "4 checks: 4 passed." });
    expect(ciSummary(checks({ state: null, passed: 0, skipped: 4 }))?.state).toBe("skip");
  });

  it("is null with no checks", () => {
    expect(ciSummary(null)).toBeNull();
    expect(ciSummary(undefined)).toBeNull();
  });
});

describe("finishedCi", () => {
  it("reports a run that goes from running to passed or failed", () => {
    const last = new Map<string, PrChecks["state"]>();
    let now = pr("pending");
    const info = () => now;
    expect(finishedCi(last, ["u"], info)).toEqual([]);
    now = pr("fail");
    expect(finishedCi(last, ["u"], info)).toEqual([{ url: "u", pr: now, state: "fail" }]);
    expect(finishedCi(last, ["u"], info)).toEqual([]); // Only one time.
  });

  it("does not report the first state, or a reply with no checks", () => {
    const last = new Map<string, PrChecks["state"]>();
    expect(finishedCi(last, ["u"], () => pr("fail"))).toEqual([]);
    expect(finishedCi(last, ["v"], () => pr("old"))).toEqual([]);
    expect(last.has("v")).toBe(false);
    expect(finishedCi(last, ["w"], () => undefined)).toEqual([]);
  });
});

describe("Fix CI", () => {
  it("names the pull request, the branch, and the failed checks", () => {
    const text = fixCiPrompt({ ...pr("fail"), head: "feature" }, ["daemon (ubuntu)"]);
    expect(text).toContain("https://github.com/o/Harness/pull/78");
    expect(text).toContain("(feature)");
    expect(text).toContain("The failed checks: daemon (ubuntu).");
    expect(text).toContain("Do not force the push");
  });

  it("links the checks page", () => {
    expect(checksUrl("https://github.com/o/r/pull/5")).toBe("https://github.com/o/r/pull/5/checks");
    expect(checksUrl(null)).toBeNull();
  });
});

describe("ciNotice", () => {
  const ev = { session_id: "s1", state: "fail" as const, ref: "Harness #78", title: "Add CI", failed: 2, total: 4 };
  const away = { windowVisible: true, windowFocused: false, shownSessionId: "s1" };

  it("shows when the user does not see the session", () => {
    expect(ciNotice(ev, away)).toEqual({ title: "CI failed: Harness #78", body: "Add CI. 2 of 4 checks failed." });
    expect(ciNotice({ ...ev, state: "pass" }, away)?.title).toBe("CI passed: Harness #78");
    expect(ciNotice(ev, { ...away, windowFocused: true })).toBeNull();
  });
});

describe("Auto-fix", () => {
  it("fixes a failed run, stops after the limit, and starts again after a passed run", () => {
    const tries = new Map<string, number>();
    const steps = Array.from({ length: MAX_AUTO_FIXES + 2 }, () => autoFixStep(tries, "u", pr("fail"), "fail"));
    expect(steps).toEqual([...Array(MAX_AUTO_FIXES).fill("fix"), "limit", null]);
    expect(autoFixStep(tries, "u", pr("pass"), "pass")).toBeNull();
    expect(autoFixStep(tries, "u", pr("fail"), "fail")).toBe("fix");
  });

  it("does not fix a merged or closed pull request", () => {
    const tries = new Map<string, number>();
    expect(autoFixStep(tries, "u", { ...pr("fail"), state: "merged" }, "fail")).toBeNull();
    expect(autoFixStep(tries, "u", { ...pr("fail"), state: "closed" }, "fail")).toBeNull();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps the switch for each session, default off", () => {
    // The tests run with no browser: a storage in memory.
    const data = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } });
    expect(autoFixOn("s-auto")).toBe(false);
    setAutoFix("s-auto", true);
    expect(autoFixOn("s-auto")).toBe(true);
    expect(autoFixOn("s-other")).toBe(false);
    setAutoFix("s-auto", false);
    expect(autoFixOn("s-auto")).toBe(false);
    expect(autoFixOn(null)).toBe(false);
  });

  it("names the failed and the cancelled checks", () => {
    const items: PrChecks["items"] = [
      { name: "a", workflow: null, state: "fail", url: null },
      { name: "b", workflow: null, state: "pass", url: null },
      { name: "c", workflow: null, state: "cancel", url: null },
    ];
    expect(failedCheckNames({ ...pr("fail"), checks: checks({ state: "fail", items }) })).toEqual(["a", "c"]);
  });

  it("adds the note to the notification", () => {
    const ev = { session_id: "s1", state: "fail" as const, ref: "Harness #78", title: null, failed: 1, total: 2, note: "Auto-fix started." };
    expect(ciNotice(ev, { windowVisible: false, windowFocused: false, shownSessionId: null })?.body).toBe("1 of 2 checks failed. Auto-fix started.");
  });
});
