// The peer import below is not installed next to this plugin. The host must supply it.
import { defineTool } from "@deepseek-ai/dsh-tools";

export const inject = ["tools"];

export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: "shout",
    description: "Say a word loudly.",
    parameters: { word: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute(args) { return args.word.toUpperCase() + (config.suffix ?? ""); },
  }));
}
