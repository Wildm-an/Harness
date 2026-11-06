import { describe, expect, it } from "vitest";
import { answerText, collectAnswers, collectNotes, previewOption } from "./QuestionCard";
import { planOutcome } from "./PlanCard";
import { chatReducer, emptyChat, requestCard } from "../chat/state";
import type { AskQuestion } from "../daemon/protocol";

const QUESTIONS: AskQuestion[] = [
  { question: "Which database?", header: "Database", options: [{ label: "SQLite", description: "" }, { label: "Postgres", description: "" }], multiSelect: false },
  { question: "Which features?", header: "Features", options: [{ label: "Auth", description: "" }, { label: "Search", description: "" }], multiSelect: true },
];

describe("the question card", () => {
  it("shows the preview of the option under the pointer, else the picked option, else the first", () => {
    const options = [
      { label: "Grid", description: "", preview: "[] []" },
      { label: "List", description: "", preview: "[]" },
    ];
    expect(previewOption(options, "List", [])?.label).toBe("List");
    expect(previewOption(options, null, ["List"])?.label).toBe("List");
    expect(previewOption(options, null, [])?.label).toBe("Grid");
  });

  it("sends only the notes of answered questions", () => {
    expect(collectNotes({ A: "Grid" }, { A: " wide ", B: "skipped", C: "  " })).toEqual({ A: "wide" });
  });

  it("joins the picked options and the text of Something else", () => {
    expect(answerText(["Auth", "Search"], "  ")).toBe("Auth, Search");
    expect(answerText([], " Redis ")).toBe("Redis");
    expect(collectAnswers(QUESTIONS, { "Which database?": ["SQLite"] }, { "Which features?": "None" }))
      .toEqual({ "Which database?": "SQLite", "Which features?": "None" });
    expect(collectAnswers(QUESTIONS, {}, {})).toEqual({});
  });

  it("makes a card of each kind of request, and expires it at the end of the turn", () => {
    const base = { request_id: "q1", tool: "ask_user_question", input: {}, diff: null, rule: null };
    expect(requestCard({ ...base, kind: "question", questions: QUESTIONS })).toEqual({ kind: "question", id: "q1", questions: QUESTIONS });
    expect(requestCard({ ...base, request_id: "p1", kind: "plan", plan: "1. Do it." })).toEqual({ kind: "plan", id: "p1", plan: "1. Do it." });
    expect(requestCard({ ...base, tool: "edit" }).kind).toBe("permission");
    let s = chatReducer(emptyChat, { type: "daemon", msg: { type: "permission.request", ...base, kind: "question", questions: QUESTIONS } });
    s = chatReducer(s, { type: "answer", requestId: "q1", answers: { "Which database?": "SQLite" } });
    expect(s.items[0]).toMatchObject({ kind: "question", answers: { "Which database?": "SQLite" } });
    s = chatReducer(s, { type: "daemon", msg: { type: "permission.request", ...base, request_id: "p1", kind: "plan", plan: "x" } });
    s = chatReducer(s, { type: "daemon", msg: { type: "turn.end", stop_reason: "denied", usage: { prompt_tokens: 1, completion_tokens: 1, last_prompt_tokens: 1, context_tokens: 1, context_length: 8 } } as never });
    expect(s.items.find((i) => i.id === "p1")).toMatchObject({ kind: "plan", expired: true });
  });

  it("names the decision on a plan", () => {
    expect(planOutcome({ kind: "plan", id: "p", plan: "", decision: "accept", mode: "acceptEdits" })).toBe("Accepted · Allow edits");
    expect(planOutcome({ kind: "plan", id: "p", plan: "", decision: "revise" })).toBe("Changes asked");
    expect(planOutcome({ kind: "plan", id: "p", plan: "", expired: true })).toBe("No decision");
  });
});
