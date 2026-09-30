import { describe, expect, it } from "vitest";
import { formatElapsed, formatTokens, modelName, turnTokens, workingStatus } from "./WorkingLine";
import { chatReducer, emptyChat, type ChatItem } from "../chat/state";

describe("the working line", () => {
  it("formats the time and the tokens as Claude Code does", () => {
    expect(formatElapsed(8_400)).toBe("8s");
    expect(formatElapsed(71_000)).toBe("1m 11s");
    expect(formatElapsed(3_720_000)).toBe("1h 2m");
    expect(formatTokens(1)).toBe("1 token");
    expect(formatTokens(950)).toBe("950 tokens");
    expect(formatTokens(1_100)).toBe("1.1k tokens");
    expect(formatTokens(2_000)).toBe("2k tokens");
    expect(formatTokens(12_400)).toBe("12k tokens");
    expect(modelName("BugsAI/qwen3.8-flash-next")).toBe("qwen3.8-flash-next");
  });

  it("tells what the agent does now", () => {
    const tool = (name: string, status: "running" | "done"): ChatItem => ({ kind: "tool", id: name, name, input: {}, status });
    expect(workingStatus([], "fake/test-model")).toEqual({ tasks: 0, text: "Waiting for test-model…" });
    expect(workingStatus([tool("bash", "running")], "m")).toEqual({ tasks: 1, text: "Running Bash…" });
    expect(workingStatus([tool("bash", "done"), { kind: "assistant", id: "a", text: "Hi", streaming: true }], "m"))
      .toEqual({ tasks: 0, text: "Writing…" });
    const ask: ChatItem = { kind: "permission", id: "r", tool: "edit", input: {}, diff: null, rule: "edit(a)" };
    expect(workingStatus([tool("edit", "running"), ask], "m").text).toBe("Waiting for your approval…");
  });

  it("adds an estimate for the reply that streams now", () => {
    const items: ChatItem[] = [{ kind: "assistant", id: "a", text: "x".repeat(40), streaming: true }];
    expect(turnTokens({ startedAt: 0, tokens: 100 }, items)).toBe(110);
    expect(turnTokens(null, [])).toBe(0);
  });

  it("keeps the start time and the tokens of the turn in the chat state", () => {
    let s = chatReducer(emptyChat, { type: "user", text: "hi", startsTurn: true });
    expect(s.turn?.tokens).toBe(0);
    const started = s.turn!.startedAt;
    s = chatReducer(s, { type: "daemon", msg: { type: "turn.usage", prompt_tokens: 90, completion_tokens: 25, last_prompt_tokens: 90 } });
    expect(s.turn).toEqual({ startedAt: started, tokens: 25 });
    const usage = { prompt_tokens: 1, completion_tokens: 1, last_prompt_tokens: 1, context_tokens: 1, context_length: 8 };
    s = chatReducer(s, { type: "daemon", msg: { type: "turn.end", usage, stop_reason: "end" } });
    expect(s.turn).toBeNull();
    // A return to a running turn: the time comes from the daemon, in seconds.
    s = chatReducer(emptyChat, {
      type: "load", history: [], warnings: [], summary: null, context: null,
      running: true, turnStartedAt: 1_000, turnTokens: 40,
    });
    expect(s.turn).toEqual({ startedAt: 1_000_000, tokens: 40 });
  });
});
