import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanBlock, WrapUpBox } from "./ProgressBlocks";

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
