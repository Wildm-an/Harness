import { describe, expect, it } from "vitest";
import type { ChatItem } from "../chat/state";
import { latestPlan } from "./progress";

const user = (id: string): ChatItem => ({ kind: "user", id, text: "Do it." });
const plan = (id: string, statuses: ("pending" | "in_progress" | "completed")[]): ChatItem => ({
  kind: "tool",
  id,
  name: "update_plan",
  input: { items: statuses.map((status, i) => ({ content: `Step ${i + 1}`, status })) },
  output: "Plan shown.",
  status: "done",
});
const bash = (id: string, output: string, status: "done" | "error"): ChatItem => ({ kind: "tool", id, name: "bash", input: {}, output, status });

describe("latestPlan", () => {
  it("shows the plan of the current turn as current", () => {
    const shown = latestPlan([user("u1"), plan("p1", ["in_progress", "pending"])]);
    expect(shown?.current).toBe(true);
    expect(shown?.steps).toHaveLength(2);
  });

  it("shows an unfinished plan of an older turn with no spinner", () => {
    const shown = latestPlan([user("u1"), plan("p1", ["completed", "in_progress"]), user("u2")]);
    expect(shown?.current).toBe(false);
  });

  it("hides a finished plan of an older turn", () => {
    expect(latestPlan([user("u1"), plan("p1", ["completed"]), user("u2")])).toBeNull();
  });

  it("hides the plan of an interrupted turn in the next turn", () => {
    const notice: ChatItem = { kind: "notice", id: "n1", level: "info", text: "The turn was interrupted." };
    expect(latestPlan([user("u1"), plan("p1", ["in_progress", "pending"]), notice, user("u2")])).toBeNull();
  });

  it("finds the interrupt in a stopped tool call after a reload", () => {
    const stopped = bash("b1", "The user interrupted the turn. The tool did not complete.", "error");
    expect(latestPlan([user("u1"), plan("p1", ["in_progress"]), stopped, user("u2")])).toBeNull();
  });

  it("keeps the plan of the interrupted turn until the next prompt", () => {
    const notice: ChatItem = { kind: "notice", id: "n1", level: "info", text: "The turn was interrupted." };
    expect(latestPlan([user("u1"), plan("p1", ["in_progress"]), notice])?.current).toBe(true);
  });

  it("shows a new plan of the current turn after an interrupted one", () => {
    const notice: ChatItem = { kind: "notice", id: "n1", level: "info", text: "The turn was interrupted." };
    const shown = latestPlan([user("u1"), plan("p1", ["in_progress"]), notice, user("u2"), plan("p2", ["pending"])]);
    expect(shown?.current).toBe(true);
    expect(shown?.steps[0].status).toBe("pending");
  });

  it("marks a plan finished when all steps are completed, or after wrap_up", () => {
    expect(latestPlan([user("u1"), plan("p1", ["completed", "in_progress"])])?.finished).toBe(false);
    expect(latestPlan([user("u1"), plan("p1", ["completed", "completed"])])?.finished).toBe(true);
    const wrap: ChatItem = { kind: "tool", id: "w1", name: "wrap_up", input: { recap: "Done." }, output: "Shown.", status: "done" };
    expect(latestPlan([user("u1"), plan("p1", ["completed", "in_progress"]), wrap])?.finished).toBe(true);
  });
});
