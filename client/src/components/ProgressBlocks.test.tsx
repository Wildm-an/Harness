import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanBlock, WrapUpBox } from "./ProgressBlocks";
import { latestWrapUp, verifyLine } from "../lib/progress";
import type { ChatItem } from "../chat/state";

describe("the end-of-turn box", () => {
  it("shows a finished plan at its top, so the plan and the recap are one card", () => {
    const plan = <PlanBlock steps={[{ content: "Fix it", status: "completed" }]} running={false} finished total={65_000} />;
    const html = renderToStaticMarkup(
      <WrapUpBox wrap={{ id: "w1", recap: "The fix is in.", ask: null, actions: [] }} disabled={false} onAction={() => undefined} plan={plan} />,
    );
    expect(html.match(/<section/g)).toHaveLength(1);
    expect(html).toContain('class="wrapup-box with-plan"');
    expect(html.indexOf("Plan finished · 1 step")).toBeLessThan(html.indexOf("The fix is in."));
    expect(html).toContain("1m 5s");
  });
});

describe("the verify line of the box", () => {
  it("names the verify command and its result under the recap", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "fix it" },
      {
        kind: "tool", id: "w1", name: "wrap_up", input: { recap: "The fix is in." }, status: "done",
        verify: { command: "npm test", status: "passed", exit_code: 0, seconds: 3, runs: 1 },
      },
    ];
    const wrap = latestWrapUp(items)!;
    expect(wrap.verify).toBe("Verify command passed: npm test");
    const html = renderToStaticMarkup(<WrapUpBox wrap={wrap} disabled={false} onAction={() => undefined} />);
    expect(html).toContain('class="wrapup-verify mono"');
    expect(html.indexOf("The fix is in.")).toBeLessThan(html.indexOf("Verify command passed"));
  });

  it("has a line for a failure and a timeout, and none with no run", () => {
    expect(verifyLine({ command: "make", status: "failed", exit_code: 2, seconds: 1, runs: 5 })).toBe("Verify command failed (exit code 2): make");
    expect(verifyLine({ command: "make", status: "timeout", exit_code: null, seconds: 300, runs: 1 })).toBe("Verify command did not end in time: make");
    expect(verifyLine(undefined)).toBeNull();
  });
});
