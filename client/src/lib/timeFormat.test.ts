import { afterEach, describe, expect, it } from "vitest";
import { formatClock, formatDateTime, formatTime, setTimeFormat, timeFormat, toTimeFormat } from "./timeFormat";

describe("the time format", () => {
  afterEach(() => setTimeFormat("12h"));

  it("is 12-hour time by default", () => {
    expect(timeFormat()).toBe("12h");
    expect(toTimeFormat(undefined)).toBe("12h");
    expect(toTimeFormat("other")).toBe("12h");
    expect(toTimeFormat("24h")).toBe("24h");
  });

  it("writes 12-hour time with AM and PM", () => {
    expect(formatClock(0, 5)).toBe("12:05 AM");
    expect(formatClock(9, 5)).toBe("9:05 AM");
    expect(formatClock(12, 0)).toBe("12:00 PM");
    expect(formatClock(21, 30)).toBe("9:30 PM");
  });

  it("writes 24-hour time when the setting is 24h", () => {
    setTimeFormat("24h");
    expect(formatClock(9, 5)).toBe("09:05");
    expect(formatTime(new Date(2026, 10, 13, 21, 30))).toBe("21:30");
    expect(formatDateTime(new Date(2026, 10, 13, 21, 30))).toMatch(/, 21:30$/);
  });
});
