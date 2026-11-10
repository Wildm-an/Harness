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

  it("keeps the plan after a stop by Send now of a queued message", () => {
    const notice: ChatItem = { kind: "notice", id: "n1", level: "info", text: "The turn was interrupted.", sendNow: true };
    const stopped = bash("b1", "The user interrupted the turn. The tool did not complete.", "error");
    const shown = latestPlan([user("u1"), plan("p1", ["in_progress", "pending"]), stopped, notice, user("u2")]);
    expect(shown?.current).toBe(false);
    expect(shown?.steps).toHaveLength(2);
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

describe("step times", () => {
  const at = (item: ChatItem, ts: number): ChatItem => ({ ...(item as Extract<ChatItem, { kind: "tool" }>), ts });

  it("times each step from its start to its completion, and the total of a finished plan", () => {
    const shown = latestPlan([
      user("u1"),
      at(plan("p1", ["in_progress", "pending", "pending"]), 1_000),
      at(plan("p2", ["completed", "in_progress", "pending"]), 6_000),
      // Step 3 goes from pending to completed: it starts at the call before.
      at(plan("p3", ["completed", "completed", "completed"]), 71_000),
    ]);
    expect(shown?.finished).toBe(true);
    expect(shown?.times).toEqual([5_000, 65_000, 65_000]);
    expect(shown?.total).toBe(70_000);
  });

  it("shows no total before the end, and ends the step in progress at wrap_up", () => {
    const items = [user("u1"), at(plan("p1", ["in_progress", "pending"]), 0), at(plan("p2", ["completed", "in_progress"]), 2_000)];
    const running = latestPlan(items);
    expect(running?.times).toEqual([2_000, null]);
    expect(running?.total).toBeNull();
    const wrap: ChatItem = { kind: "tool", id: "w1", name: "wrap_up", input: { recap: "Done." }, output: "Shown.", status: "done", ts: 9_000 };
    const done = latestPlan([...items, wrap]);
    expect(done?.times).toEqual([2_000, 7_000]);
    expect(done?.total).toBe(9_000);
  });

  it("shows no times for calls with no time (an old session)", () => {
    const shown = latestPlan([user("u1"), plan("p1", ["in_progress"]), plan("p2", ["completed"])]);
    expect(shown?.times).toEqual([null]);
    expect(shown?.total).toBeNull();
  });
});
