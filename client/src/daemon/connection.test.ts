import { describe, expect, it } from "vitest";
import { forSession } from "./connection";
import type { DaemonMessage } from "./protocol";

describe("the messages that the app gets", () => {
  const message = (type: string, sessionId?: string) => ({ type, ...(sessionId ? { session_id: sessionId } : {}) }) as unknown as DaemonMessage;

  it("gets the events of the open session and the messages with no session", () => {
    expect(forSession(message("token", "s1"), "s1")).toBe(true);
    expect(forSession(message("sessions"), "s1")).toBe(true);
  });

  it("does not get the events of another session", () => {
    expect(forSession(message("token", "s2"), "s1")).toBe(false);
  });

  it("gets the events about any session", () => {
    expect(forSession(message("turn.done", "s2"), "s1")).toBe(true);
    expect(forSession(message("routine.run", "s2"), null)).toBe(true);
  });
});
