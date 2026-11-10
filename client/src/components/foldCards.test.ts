import { describe, expect, it } from "vitest";
import type { ChatItem } from "../chat/state";
import { foldCards, replyTexts } from "./MessageList";

const user = (id: string): ChatItem => ({ kind: "user", id, text: id });
const tool = (id: string, name = "bash", input: unknown = { command: "git status" }): ChatItem => ({ kind: "tool", id, name, input, status: "running" });
const permission = (id: string, extra: Partial<Extract<ChatItem, { kind: "permission" }>> = {}): ChatItem =>
  ({ kind: "permission", id, tool: "bash", input: { command: "git status" }, diff: null, rule: "bash(git status)", ...extra }) as ChatItem;
const ids = (items: ChatItem[]) => items.map((i) => i.id);

describe("foldCards (audit R1, R3)", () => {
  it("hides the row of a call while its permission card waits", () => {
    expect(ids(foldCards([user("u"), tool("t"), permission("p")]))).toEqual(["u", "p"]);
  });

  it("after the answer, keeps one row with the answer as a mark", () => {
    const row = tool("t");
    const out = foldCards([user("u"), row, permission("p", { decision: "allow_once" })]);
    expect(ids(out)).toEqual(["u", "t"]);
    expect(out[1]).toMatchObject({ kind: "tool", approval: "allow_once" });
    // The same answer gives the same copy, so a memoized row does not draw again.
    expect(foldCards([user("u"), row, permission("p", { decision: "allow_once" })])[1]).toBe(out[1]);
  });

  it("keeps an expired card and its row", () => {
    expect(ids(foldCards([tool("t"), permission("p", { expired: true })]))).toEqual(["t", "p"]);
  });

  it("pairs the call with the same input, and not across a message of the user", () => {
    const other = tool("t1", "bash", { command: "ls" });
    expect(ids(foldCards([other, tool("t2"), permission("p")]))).toEqual(["t1", "p"]);
    expect(ids(foldCards([tool("t"), user("u"), permission("p")]))).toEqual(["t", "u", "p"]);
  });

  it("hides the row of a question or a plan: the card shows it", () => {
    const question: ChatItem = { kind: "question", id: "q", questions: [], tool: "ask_user_question" };
    const plan: ChatItem = { kind: "plan", id: "pl", plan: "x" };
    expect(ids(foldCards([tool("tq", "ask_user_question", {}), question]))).toEqual(["q"]);
    expect(ids(foldCards([tool("tp", "exit_plan_mode", {}), plan]))).toEqual(["pl"]);
  });

  it("changes nothing with no card", () => {
    const items = [user("u"), tool("t")];
    expect(foldCards(items)).toBe(items);
  });
});

describe("replyTexts (audit U10)", () => {
  const reply = (id: string, text: string): ChatItem => ({ kind: "assistant", id, text, streaming: false });

  it("gives the text of each finished reply to its last text item", () => {
    const items = [user("u1"), reply("a1", "First."), tool("t"), reply("a2", "Done."), user("u2"), reply("a3", "Next.")];
    const out = replyTexts(items, false);
    expect([...out]).toEqual([
      ["a2", "First.\n\nDone."],
      ["a3", "Next."],
    ]);
  });

  it("does not give the reply of the running turn", () => {
    expect([...replyTexts([user("u"), reply("a", "Working.")], true)]).toEqual([]);
  });
});
