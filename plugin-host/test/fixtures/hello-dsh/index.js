// A fixture plugin in the DeepSeek Harness format (docs/user/develop/basic). It uses the
// real service APIs: tools, commands, systemPrompt, skills, llm, and agent/tool events.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";

export const name = "hello-dsh";
export const inject = ["tools", "commands", "systemPrompt", "skills", "llm"];
export const Config = Schema.object({ greeting: Schema.string().default("Hello") });

class FakeAdapter extends LlmAdapter {
  async *stream(options) {
    const last = options.messages.at(-1);
    const text = `echo: ${last?.content?.find((b) => b.type === "text")?.text ?? ""}`;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "block-start", index: 1, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: 1, id: "call_1", name: "greet", argumentsDelta: '{"name":' };
    yield { type: "tool-call-delta", index: 1, id: "call_1", argumentsDelta: '"Ada"}' };
    yield { type: "block-end", index: 1, block: { type: "tool-call", id: "call_1", name: "greet", arguments: '{"name":"Ada"}' } };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  }
}

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: "greet",
    description: "Greet a person by name.",
    parameters: { name: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args) {
      return `${config.greeting}, ${args.name}!`;
    },
  }));

  ctx.tools.register(defineTool({
    name: "danger",
    description: "A tool that a hook blocks.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute() {
      return "ran";
    },
  }));

  ctx.commands.register({
    name: "hello",
    description: "Greet someone.",
    input: { hint: "[name]" },
    handler: (inv) => ({ kind: "success", text: `${config.greeting}, ${inv.rawInput || "world"}!` }),
  });

  ctx.systemPrompt.section({ name: "hello-dsh", order: 5000, text: "When the user asks for a greeting, use the greet tool." });

  ctx.skills.register({
    name: "greeting-style",
    description: "Write a short greeting.",
    content: "Call the greet tool with the name.",
    source: "hello-dsh",
  });

  ctx.llm.registerAdapter(["fake"], new FakeAdapter());

  ctx.on("tools/pre-execute", (exec, next) => {
    if (exec.name === "danger") return Promise.resolve({ kind: "deny", reason: "hello-dsh blocks the danger tool" });
    return next();
  });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (exec.name === "greet" && !result.isError) return { kind: "accept", content: [{ type: "text", text: `${result.value} (checked)` }] };
    return decision;
  });

  ctx.on("agent/turn-stopping", ({ agent }) => {
    agent.steer?.("Please also say goodbye.");
  });
}
