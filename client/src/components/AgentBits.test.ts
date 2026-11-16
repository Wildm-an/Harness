import { describe, expect, it } from "vitest";
import { agentInitials, timeLeft, usageTip } from "./AgentBits";

describe("AgentBits", () => {
  const now = new Date("2026-11-16T12:15:00");

  it("gives the initials of an agent", () => {
    expect(agentInitials("Claude Agent")).toBe("CA");
    expect(agentInitials("OpenCode")).toBe("OC");
    expect(agentInitials("goose")).toBe("G");
  });

  it("gives the time until a reset", () => {
    expect(timeLeft(new Date("2026-11-16T14:20:00").toISOString(), now)).toBe("2 hr 5 min");
    expect(timeLeft(new Date("2026-11-16T12:45:00").toISOString(), now)).toBe("30 min");
    expect(timeLeft(new Date("2026-11-20T13:15:00").toISOString(), now)).toBe("4 days 1 hr");
    expect(timeLeft(new Date("2026-11-16T12:00:00").toISOString(), now)).toBe("");
    expect(timeLeft(null, now)).toBe("");
  });

  it("puts the reset time in the hover tip", () => {
    const tip = usageTip({ label: "5-hour limit", percent: 17.4, resets_at: new Date("2026-11-16T14:20:00").toISOString(), severity: "normal" }, now);
    expect(tip).toMatch(/^5-hour limit: 17% used\. Resets in 2 hr 5 min \(.+\)\.$/);
    expect(usageTip({ label: "Weekly", percent: 41, resets_at: null, severity: "normal" }, now)).toBe("Weekly: 41% used.");
  });
});
