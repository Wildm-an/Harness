import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RowsPending, SkeletonRows } from "./Skeleton";
import { Row } from "./SettingsDialog";

describe("skeletons (rule R8, audit M16)", () => {
  it("draws gray rows with a busy state", () => {
    const html = renderToStaticMarkup(<SkeletonRows count={3} className="side-skeleton" label="Loading the sessions" />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading the sessions"');
    expect(html.match(/skeleton skeleton-row/g)).toHaveLength(3);
  });

  it("shows a gray bar in place of the control of a setting while its value loads", () => {
    const row = (
      <Row label="Prompt suggestions">
        <button type="button">switch</button>
      </Row>
    );
    const loading = renderToStaticMarkup(<RowsPending.Provider value>{row}</RowsPending.Provider>);
    expect(loading).toContain("skeleton-control");
    expect(loading).toContain("Prompt suggestions");
    expect(loading).not.toContain("switch");
    const loaded = renderToStaticMarkup(row);
    expect(loaded).toContain("switch");
    expect(loaded).not.toContain("skeleton");
  });
});
