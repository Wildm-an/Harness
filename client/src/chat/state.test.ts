import { describe, expect, it } from "vitest";
import { chatReducer, emptyChat, historyToItems, type ChatState } from "./state";
import type { DaemonMessage } from "../daemon/protocol";
import { filterCommands, parseSubmission } from "../components/PromptBox";

const run = (...msgs: DaemonMessage[]): ChatState =>
  msgs.reduce((s, msg) => chatReducer(s, { type: "daemon", msg }), chatReducer(emptyChat, { type: "user", text: "hi", startsTurn: true }));

const usage = { prompt_tokens: 1, completion_tokens: 1, last_prompt_tokens: 1, context_tokens: 500, context_length: 8000 };

describe("chatReducer", () => {
  it("joins streamed tokens into one assistant item", () => {
    const s = run({ type: "token", text: "Hel" }, { type: "token", text: "lo" });
    expect(s.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(s.items[1]).toMatchObject({ text: "Hello", streaming: true });
    expect(s.running).toBe(true);
  });

  it("ends the stream at a tool call and updates the tool card", () => {
    const s = run(
      { type: "token", text: "Reading." },
      { type: "tool.start", id: "c1", name: "read", input: { path: "a.py" } },
      { type: "tool.result", id: "c1", output: "1\tx", is_error: false },
      { type: "turn.end", usage, stop_reason: "end" },
    );
    expect(s.items[1]).toMatchObject({ kind: "assistant", streaming: false });
    expect(s.items[2]).toMatchObject({ kind: "tool", status: "done", output: "1\tx" });
    expect(s.running).toBe(false);
    expect(s.usage).toEqual(usage);
  });

  it("updates only the newest running card when ids repeat", () => {
    const s = run(
      { type: "tool.start", id: "c1", name: "read", input: {} },
      { type: "tool.result", id: "c1", output: "first", is_error: false },
      { type: "tool.start", id: "c1", name: "bash", input: {} },
      { type: "tool.result", id: "c1", output: "second", is_error: true },
    );
    const tools = s.items.filter((i) => i.kind === "tool");
    expect(tools.map((t) => t.kind === "tool" && t.output)).toEqual(["first", "second"]);
    expect(tools[1]).toMatchObject({ status: "error" });
  });

  it("expires an open permission request when the turn ends", () => {
    let s = run({ type: "permission.request", request_id: "r1", tool: "bash", input: { command: "ls" }, diff: null, rule: "bash(ls)" });
    expect(s.items[1]).toMatchObject({ kind: "permission" });
    s = chatReducer(s, { type: "daemon", msg: { type: "turn.end", usage, stop_reason: "interrupted" } });
    expect(s.items[1]).toMatchObject({ kind: "permission", expired: true });
    expect(s.items[2]).toMatchObject({ kind: "notice", text: "The turn was interrupted." });
  });

  it("records a decision", () => {
    let s = run({ type: "permission.request", request_id: "r1", tool: "bash", input: {}, diff: null, rule: "bash(x)" });
    s = chatReducer(s, { type: "decide", requestId: "r1", decision: "deny" });
    expect(s.items[1]).toMatchObject({ decision: "deny" });
  });

  it("stops the turn on disconnect", () => {
    const s = chatReducer(run({ type: "token", text: "x" }), { type: "disconnected" });
    expect(s.running).toBe(false);
    expect(s.items.at(-1)).toMatchObject({ kind: "notice", level: "error" });
  });
});

describe("context", () => {
  it("shows a summary card and updates the context use after a compaction", () => {
    const s = run({
      type: "context.compacted",
      reason: "auto",
      removed_messages: 6,
      trimmed_outputs: 0,
      summary: "Earlier work.",
      context_tokens: 900,
      context_length: 8000,
    });
    expect(s.items.at(-1)).toMatchObject({ kind: "summary", text: "Earlier work.", removed: 6, reason: "auto" });
    expect(s.context).toEqual({ tokens: 900, length: 8000 });
  });

  it("puts the stored summary first on load and takes the context use from turn.end", () => {
    let s = chatReducer(emptyChat, {
      type: "load",
      history: [{ role: "user", content: "hi" }],
      warnings: [],
      summary: "Old work.",
      context: { tokens: 100, length: 4096 },
    });
    expect(s.items.map((i) => i.kind)).toEqual(["summary", "user"]);
    s = chatReducer(s, { type: "daemon", msg: { type: "turn.end", usage, stop_reason: "end" } });
    expect(s.context).toEqual({ tokens: 500, length: 8000 });
  });
});

describe("historyToItems", () => {
  it("rebuilds tool cards with results and error state", () => {
    const items = historyToItems([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "ok",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "boom", is_error: true },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect(items[2]).toMatchObject({ input: { command: "ls" }, output: "boom", status: "error" });
  });
});

describe("parseSubmission", () => {
  it("splits slash commands", () => {
    expect(parseSubmission("/model demo/x")).toEqual({ kind: "command", name: "model", args: "demo/x" });
    expect(parseSubmission("  /help ")).toEqual({ kind: "command", name: "help", args: "" });
  });

  it("keeps other text as a prompt", () => {
    expect(parseSubmission("fix the / route")).toEqual({ kind: "prompt", text: "fix the / route" });
    expect(parseSubmission("   ")).toBeNull();
  });
});

describe("skills", () => {
  const item = (name: string, description = "", builtin = false) => ({
    name,
    description,
    "argument-hint": "",
    source: builtin ? "built-in" : "project (.harness)",
    builtin,
  });

  it("orders the / menu matches: exact, prefix, part of the name, description", () => {
    const items = [item("recompile", "x"), item("commit", "x"), item("compact", "", true), item("review", "compare the code")];
    expect(filterCommands(items, "comp").map((i) => i.name)).toEqual(["compact", "recompile", "review"]);
    expect(filterCommands(items, "commit").map((i) => i.name)).toEqual(["commit"]);
    expect(filterCommands(items, "").map((i) => i.name)).toEqual(["recompile", "commit", "compact", "review"]);
  });

  it("shows the typed command, not the skill text, for a stored skill message", () => {
    const items = historyToItems([{ role: "user", content: "The user started the skill /greet ...", display: "/greet Ada" }]);
    expect(items[0]).toMatchObject({ kind: "user", text: "/greet Ada" });
  });

  it("marks a tool that a forked skill runs", () => {
    const s = run({ type: "tool.start", id: "c9", name: "read", input: {}, agent: "research" });
    expect(s.items.at(-1)).toMatchObject({ kind: "tool", agent: "research" });
  });
});
