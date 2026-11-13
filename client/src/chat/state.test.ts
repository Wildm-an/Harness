import { describe, expect, it } from "vitest";
import { chatReducer, emptyChat, historyToItems, type ChatState } from "./state";
import type { DaemonMessage } from "../daemon/protocol";
import { filterCommands, insertCommand, isSkill, parseSubmission, slashAt } from "../components/PromptBox";

const run = (...msgs: DaemonMessage[]): ChatState =>
  msgs.reduce((s, msg) => chatReducer(s, { type: "daemon", msg }), chatReducer(emptyChat, { type: "user", text: "hi", startsTurn: true }));

const usage = { prompt_tokens: 1, completion_tokens: 1, last_prompt_tokens: 1, context_tokens: 500, context_length: 8000 };

describe("chatReducer", () => {
  it("puts a file card after a tool call that made a new PDF or Word file", () => {
    const s = run(
      { type: "tool.start", id: "c1", name: "bash", input: { command: "python build.py" } },
      { type: "tool.start", id: "c2", name: "read", input: { path: "a.py" } },
      { type: "tool.result", id: "c1", output: "ok", is_error: false, created: ["out/report.docx", "out/report.pdf"] },
      { type: "tool.result", id: "c2", output: "x", is_error: false },
    );
    expect(s.items.map((i) => i.kind)).toEqual(["user", "tool", "file", "file", "tool"]);
    expect(s.items[2]).toMatchObject({ kind: "file", path: "out/report.docx", toolId: "c1" });
  });

  it("puts the card of send_file or artifact after its tool call, also from the history", () => {
    const card = { type: "artifact" as const, id: "a1b2c3d4", title: "Report", description: "", version: 2, updated: 1 };
    const s = run(
      { type: "tool.start", id: "c1", name: "artifact", input: { file_path: "r.html" } },
      { type: "tool.result", id: "c1", output: "Published", is_error: false, card },
    );
    expect(s.items.map((i) => i.kind)).toEqual(["user", "tool", "card"]);
    expect(s.items[2]).toMatchObject({ kind: "card", toolId: "c1", card });
    const items = historyToItems([
      { role: "user", content: "publish" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "artifact", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Published", card, ts: 2 },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "card"]);
    expect(items[1]).toMatchObject({ ts: 2000 });
  });

  it("shows the file cards again when the session opens", () => {
    const items = historyToItems([
      { role: "user", content: "make a memo" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "office_edit", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Created memo.docx", created: ["memo.docx"] },
      { role: "assistant", content: "Done." },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "file", "assistant"]);
    expect(items[2]).toMatchObject({ path: "memo.docx" });
  });

  it("puts nothing in the chat for a model switch, but keeps its warnings", () => {
    const s = run({
      type: "command.result",
      name: "model",
      text: "The model is now demo/other.", // An older daemon sends this text.
      model: "demo/other",
      warnings: ["The model other does not support tool calls."],
      context_length: 4096,
    });
    expect(s.items.map((i) => i.kind)).toEqual(["user", "notice"]);
    expect(s.items[1]).toMatchObject({ level: "warning" });
  });

  it("shows the text of /model with no model change", () => {
    const s = run({ type: "command.result", name: "model", text: "Model: demo/x. Providers: demo." });
    expect(s.items[1]).toMatchObject({ kind: "notice", level: "info", text: "Model: demo/x. Providers: demo." });
  });

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

  it("shows a steer message where the agent took it", () => {
    const s = run(
      { type: "token", text: "Working." },
      { type: "steer.taken", id: "q1", text: "use tabs" },
      { type: "token", text: "OK, tabs." },
    );
    expect(s.items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(s.items[1]).toMatchObject({ streaming: false });
    expect(s.items[2]).toMatchObject({ text: "use tabs", messageId: "q1" });
    expect(s.running).toBe(true);
  });

  it("keeps the id and the time of a stored user message", () => {
    const [item] = historyToItems([{ role: "user", content: "hi", id: "u1", ts: 1700000000 }]);
    expect(item).toMatchObject({ kind: "user", messageId: "u1", ts: 1700000000000 });
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

  it("loads a running turn after a return to the session", () => {
    let s = chatReducer(emptyChat, {
      type: "load",
      history: [
        { role: "user", content: "edit it" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "edit", arguments: "{}" } }] },
      ],
      warnings: [],
      summary: null,
      context: null,
      running: true,
      partial: null,
      requests: [{ request_id: "r1", tool: "edit", input: {}, diff: null, rule: "edit(a.py)" }],
    });
    expect(s.running).toBe(true);
    expect(s.items.map((i) => i.kind)).toEqual(["user", "tool", "permission"]);
    // The tool.start event of a call that the history shows does not add a second card.
    s = chatReducer(s, { type: "daemon", msg: { type: "tool.start", id: "c1", name: "edit", input: {} } });
    expect(s.items.filter((i) => i.kind === "tool")).toHaveLength(1);
  });

  it("shows the streamed text of a running turn after a return to the session", () => {
    const s = chatReducer(emptyChat, {
      type: "load", history: [{ role: "user", content: "hi" }], warnings: [], summary: null, context: null,
      running: true, partial: "Hel",
    });
    const next = chatReducer(s, { type: "daemon", msg: { type: "token", text: "lo" } });
    expect(next.items[1]).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
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

  it("keeps the reason of a plugin approval request, and shows plugin notices and a blocked turn", () => {
    let s = run({ type: "permission.request", request_id: "r2", tool: "glob", input: {}, diff: null, rule: null, reason: "A plugin asks." });
    expect(s.items[1]).toMatchObject({ kind: "permission", rule: null, reason: "A plugin asks." });
    s = chatReducer(s, { type: "daemon", msg: { type: "notice", level: "info", text: "A plugin added a message: more" } });
    expect(s.items.at(-1)).toMatchObject({ kind: "notice", level: "info", text: "A plugin added a message: more" });
    s = chatReducer(s, { type: "daemon", msg: { type: "turn.end", usage, stop_reason: "blocked" } });
    expect(s.items.at(-1)).toMatchObject({ kind: "notice", text: "A plugin or a hook ended the turn." });
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

  it("finds the / token at the caret, at the start or after a space", () => {
    expect(slashAt("/rev", 4)).toEqual({ start: 0, query: "rev" });
    expect(slashAt("fix it with /gr", 15)).toEqual({ start: 12, query: "gr" });
    expect(slashAt("fix it with / now", 13)).toEqual({ start: 12, query: "" });
    expect(slashAt("see a/b", 7)).toBeNull();
    expect(slashAt("read /usr/lib", 13)).toBeNull();
    expect(slashAt("/greet Ada", 10)).toBeNull();
  });

  it("puts a skill in the middle of a prompt, and keeps the text after it", () => {
    expect(insertCommand("fix it with /gr now", 15, 12, "greet")).toEqual({ text: "fix it with /greet now", caret: 18 });
    expect(insertCommand("fix it with /", 13, 12, "greet")).toEqual({ text: "fix it with /greet ", caret: 19 });
  });

  it("shows only skills in the middle of a prompt", () => {
    expect(isSkill({ ...item("greet"), path: "/p/greet/SKILL.md" })).toBe(true);
    expect(isSkill(item("compact", "", true))).toBe(false);
    expect(isSkill({ ...item("deploy"), source: "plugin (ops)" })).toBe(false); // A plugin command has no path.
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

describe("the notes of background tasks", () => {
  it("start a turn with a note line, not a user message", () => {
    const s = chatReducer(emptyChat, { type: "daemon", msg: { type: "turn.started", id: "m1", text: "Background task ended: build", origin: "task" } });
    expect(s.running).toBe(true);
    expect(s.items[0]).toMatchObject({ kind: "user", origin: "task", text: "Background task ended: build" });
  });

  it("keep the card of a background subagent open after the turn ends", () => {
    const request = { type: "permission.request" as const, request_id: "r1", tool: "bash", input: {}, diff: null, rule: null, background: true, agent: "Count files" };
    const s = run(request, { type: "turn.end", usage, stop_reason: "end" });
    expect(s.items.find((i) => i.kind === "permission")).toMatchObject({ background: true });
    expect(s.items.find((i) => i.kind === "permission")).not.toHaveProperty("expired", true);
  });
});

describe("a card of a background agent", () => {
  it("goes before the reply that streams, and names the agent", () => {
    const s = run(
      { type: "token", text: "Here is " },
      { type: "permission.request", request_id: "r2", tool: "bash", input: {}, diff: null, rule: null, background: true, agent: "Read the README" },
      { type: "token", text: "the result." },
    );
    expect(s.items.map((i) => i.kind)).toEqual(["user", "permission", "assistant"]);
    expect(s.items[2]).toMatchObject({ text: "Here is the result." });
    expect(s.items[1]).toMatchObject({ reason: 'The background agent "Read the README" asks.' });
  });
});

describe("the image input of the session model", () => {
  const load = (imageInput: boolean | null) =>
    chatReducer(emptyChat, { type: "load", history: [], warnings: [], summary: null, context: null, imageInput });

  it("comes from the open, and changes with the model checks", () => {
    expect(emptyChat.imageInput).toBeNull();
    expect(load(null).imageInput).toBeNull();
    const s = chatReducer(load(null), {
      type: "daemon",
      msg: { type: "session.model_info", context_length: 8192, image_input: false, warnings: ["The endpoint rejected the image."] },
    });
    expect(s.imageInput).toBe(false);
    expect(s.items.at(-1)).toMatchObject({ kind: "notice", level: "warning", text: "The endpoint rejected the image." });
  });

  it("removes the unknown context warning when a later check finds the length", () => {
    const unknown = "The context length of glm-5.3-flash is unknown. The harness uses 8192 tokens. Set context_length in providers.json for this model.";
    const first = chatReducer(load(null), {
      type: "daemon",
      msg: { type: "session.model_info", context_length: 8192, context_source: "default", image_input: null, warnings: [unknown] },
    });
    expect(first.items.some((i) => i.kind === "notice" && i.text === unknown)).toBe(true);
    const found = chatReducer(first, {
      type: "daemon",
      msg: { type: "session.model_info", context_length: 202752, context_source: "model list", image_input: null, warnings: [] },
    });
    expect(found.items.some((i) => i.kind === "notice" && i.text === unknown)).toBe(false);
    expect(found.context).toBeNull(); // load() has no context meter.
  });

  it("changes after /model, and not after other commands", () => {
    const s = chatReducer(load(false), { type: "daemon", msg: { type: "command.result", name: "model", model: "box/llava", image_input: true } });
    expect(s.imageInput).toBe(true);
    const other = chatReducer(s, { type: "daemon", msg: { type: "command.result", name: "compact", text: "Done." } });
    expect(other.imageInput).toBe(true);
  });
});
