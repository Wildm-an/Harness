// A test plugin for phase 2: it listens to the agent and tool events, and changes, blocks, asks,
// and steers. The /events command returns what it saw.

import { defineTool } from "@deepseek-ai/dsh-tools";

export const inject = ["commands", "agents", "tools"];

export function apply(ctx) {
  const seen = [];
  const stopped = new Set();
  const note = (name, extra = {}) => seen.push({ name, ...extra });

  ctx.on("agent/created", ({ agent, source }) => note("agent/created", { agent: agent.id, source }));
  ctx.on("agent/disposed", ({ agent }) => note("agent/disposed", { agent: agent.id }));
  ctx.on("agent/status", ({ status }) => note("agent/status", { status }));
  ctx.on("agent/inbox/claimed", ({ message }) => note("agent/inbox/claimed", { text: message.content[0].text }));
  ctx.on("agent/error", () => note("agent/error"));
  ctx.on("tools/result", (exec, result) => note("tools/result", { tool: exec.name, isError: result.isError }));
  ctx.on("agent/assistant-stream", ({ frame }) => {
    if (frame.type !== "chunk") note("agent/assistant-stream", { type: frame.type });
  });

  ctx.on("agent/pre-step", async ({ messages, step }, next) => {
    const decision = await next();
    if (step !== 1 || decision.kind !== "enter") return decision;
    const text = decision.messages[0]?.content?.[0]?.text ?? "";
    if (text.includes("please reject")) return { kind: "reject" };
    const changed = { ...decision.messages[0], content: [{ type: "text", text: `[checked] ${text}` }] };
    return { kind: "enter", messages: [changed, ...decision.messages.slice(1)] };
  });

  ctx.on("agent/request", async (_payload, next) => ({ ...(await next()), temperature: 0.25, maxTokens: 77 }));

  ctx.on("agent/request-error", async ({ failure }, next) => {
    note("agent/request-error", { message: failure.message.slice(0, 40) });
    return seen.filter((e) => e.name === "agent/request-error").length === 1 ? { kind: "retry" } : next();
  });

  ctx.on("agent/turn-stopping", ({ agent, turn }) => {
    if (stopped.has(turn)) return;
    stopped.add(turn);
    agent.steer("Also say goodbye.");
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name === "write") return { kind: "deny", reason: "events-dsh blocks write" };
    if (exec.name === "glob" || exec.name === "askme") return { kind: "ask", reason: `events-dsh asks before ${exec.name}` };
    return next();
  });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (exec.name !== "read" || result.isError) return decision;
    return {
      kind: "accept",
      content: [{ type: "text", text: `${result.content[0].text}\n[read checked]` }],
      additionalContexts: [{ id: "ctx1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Note from events-dsh." }] }],
    };
  });

  ctx.tools.register(defineTool({
    name: "askme",
    description: "A DeepSeek tool that needs approval through the approval service.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute() {
      return "askme ran";
    },
  }));

  ctx.commands.register({
    name: "events",
    description: "The events that events-dsh saw.",
    handler: () => ({ kind: "success", text: JSON.stringify(seen) }),
  });
}
