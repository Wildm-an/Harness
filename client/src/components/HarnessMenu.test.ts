import { describe, expect, it } from "vitest";
import { harnessLabel } from "./HarnessMenu";

describe("the harness chip", () => {
  it("shows the harness and its current model", () => {
    const models = [
      { id: "fast", name: "Fast", description: "" },
      { id: "smart", name: "Smart", description: "" },
    ];
    expect(harnessLabel({ id: "opencode", name: "OpenCode" })).toBe("OpenCode");
    expect(harnessLabel({ id: "opencode", name: "OpenCode", models, model: "smart" })).toBe("OpenCode · Smart");
    expect(harnessLabel({ id: "opencode", name: "OpenCode", models, model: "gone" })).toBe("OpenCode");
  });
});
