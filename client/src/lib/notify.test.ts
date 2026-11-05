import { describe, expect, it } from "vitest";
import { routineNotice, turnNotice, type RoutineRunEvent, type TurnDoneEvent } from "./notify";

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

describe("the notification of a turn that ended", () => {
  const done = (extra: Partial<TurnDoneEvent> = {}): TurnDoneEvent => ({
    session_id: "s1",
    title: "Fix the login bug",
    summary: "The login bug is fixed and the tests pass.",
    stop_reason: "end",
    ...extra,
  });
  const away = { windowVisible: false, windowFocused: false, shownSessionId: null };

  it("shows the session title and the summary", () => {
    expect(turnNotice(done(), away)).toEqual({ title: "Fix the login bug", body: "The login bug is fixed and the tests pass." });
  });

  it("shows nothing when the user sees the session", () => {
    expect(turnNotice(done(), { windowVisible: true, windowFocused: true, shownSessionId: "s1" })).toBeNull();
  });

  it("shows it when the window is in the background or shows another session", () => {
    expect(turnNotice(done(), { windowVisible: true, windowFocused: false, shownSessionId: "s1" })).not.toBeNull();
    expect(turnNotice(done(), { windowVisible: true, windowFocused: true, shownSessionId: "s2" })).not.toBeNull();
  });

  it("shows nothing when the user stopped the turn", () => {
    expect(turnNotice(done({ stop_reason: "interrupted" }), away)).toBeNull();
  });

  it("has a title before the session has one", () => {
    expect(turnNotice(done({ title: null, summary: " " }), away)).toEqual({ title: "Harness", body: "The agent finished the turn." });
  });
});
