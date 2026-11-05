import { describe, expect, it } from "vitest";
import { routineNotice, type RoutineRunEvent } from "./notify";

const run = (status: RoutineRunEvent["status"], name = "Daily summary"): RoutineRunEvent => ({ name, status, session_id: "s1" });
const hidden = { windowVisible: false, shownSessionId: null };

describe("the notification of a routine run", () => {
  it("gives the text for each end state", () => {
    expect(routineNotice(run("waiting"), hidden)).toBe("Daily summary needs your approval");
    expect(routineNotice(run("done"), hidden)).toBe("Daily summary finished");
    expect(routineNotice(run("failed"), hidden)).toBe("Daily summary failed");
  });

  it("shows nothing when the run starts", () => {
    expect(routineNotice(run("running"), hidden)).toBeNull();
  });

  it("shows nothing when the window shows the session", () => {
    expect(routineNotice(run("done"), { windowVisible: true, shownSessionId: "s1" })).toBeNull();
  });

  it("shows when the window shows another session or no session", () => {
    expect(routineNotice(run("done"), { windowVisible: true, shownSessionId: "s2" })).toBe("Daily summary finished");
    expect(routineNotice(run("failed"), { windowVisible: true, shownSessionId: null })).toBe("Daily summary failed");
  });

  it("shows when the window is hidden, also for the session that it shows", () => {
    expect(routineNotice(run("waiting"), { windowVisible: false, shownSessionId: "s1" })).toBe("Daily summary needs your approval");
  });

  it("names a routine with no name", () => {
    expect(routineNotice(run("done", "  "), hidden)).toBe("A routine finished");
  });
});
