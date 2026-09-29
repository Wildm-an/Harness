// Phase 0 spike, test 2: call the real services the way the bridge will.
//
//   <node.exe> --expose-internals services.mjs
//
// It loads the core services and the fixture plugin, makes one shim agent, and runs each call.
// It prints one JSON report. Each check is "ok" or has the error text.

import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { createScope, scopeTarget } from "@deepseek-ai/dsh-scope";

const report = { node: process.version, checks: {} };

async function check(name, fn) {
  const started = performance.now();
  try {
    const value = await fn();
    report.checks[name] = { ok: true, ms: Math.round(performance.now() - started), value };
  } catch (e) {
    report.checks[name] = { ok: false, error: String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ") };
  }
}

const root = new Context();
await root.plugin(Loader, { baseUrl: import.meta.url });
for (const [id, name] of [
  ["system-prompt", "@deepseek-ai/dsh-system-prompt"],
  ["tools", "@deepseek-ai/dsh-tools"],
  ["commands", "@deepseek-ai/dsh-commands"],
  ["skills", "@deepseek-ai/dsh-skill"],
  ["llm", "@deepseek-ai/dsh-llm"],
]) await root.loader.create({ id, name, config: {} });
await root.loader.create({ id: "hello", name: "./fixtures/hello-dsh/index.js", config: { greeting: "Hi" } });
await root.loader.await();

await check("plugin loaded", () => {
  const entry = root.loader.resolve("hello");
  if (entry?.fiber?.state !== 2) throw new Error(`fiber state ${entry?.fiber?.state}: ${entry?.fiber?.error ?? ""}`);
  return "active";
});

// A shim agent: one Harness session. The scope key is the agent object.
const events = [];
const steered = [];
const agent = {
  id: "session-1",
  session: { id: "session-1", append: (type, data) => { events.push({ type, data }); return events.length; } },
  steer: (text) => steered.push(text),
};
const scope = createScope(root, agent);
agent.ctx = scope.ctx;
const signal = new AbortController().signal;

await check("tools.schemas", () => root.tools.schemas(agent).map((s) => ({ name: s.name, parameters: s.parameters })));
await check("tools.execute greet", async () => {
  const result = await root.tools.execute({ callId: "call_1", name: "greet", arguments: { name: "Ada" }, agent, signal });
  return { isError: result.isError, value: result.value, content: result.content };
});
await check("tools.execute danger (pre-execute deny)", async () => {
  const result = await root.tools.execute({ callId: "call_2", name: "danger", arguments: {}, agent, signal });
  return { isError: result.isError, error: result.error, content: result.content };
});
await check("commands.list", () => root.commands.list(agent).map((c) => c.name ?? c.definition?.name));
await check("commands.execute /hello Ada", async () => {
  const run = await root.commands.execute(agent, "/hello Ada", [], signal);
  return { result: run?.result, sessionEvents: events.map((e) => e.type) };
});
await check("systemPrompt.assemble", async () => {
  const assembly = await root.systemPrompt.assemble({});
  return { sections: assembly.sections.map((s) => s.name), tools: assembly.tools.map((t) => t.name) };
});
await check("skills.list", async () => (await root.skills.list({})).map((s) => ({ name: s.name, provider: s.provider })));
await check("skills.get", async () => (await root.skills.get("greeting-style", {}))?.content);
await check("llm.listProviders", () => root.llm.listProviders());
await check("llm.stream", async () => {
  const chunks = [];
  for await (const chunk of root.llm.stream({
    provider: "fake", model: "m1", signal,
    messages: [{ id: "m1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }],
  })) chunks.push(chunk.type);
  return chunks;
});
await check("agent/turn-stopping (scoped serial)", async () => {
  await root.serial(scopeTarget(root, agent), "agent/turn-stopping", { agent, turn: 1, signal });
  return steered;
});
await check("unload removes registrations", async () => {
  root.loader.remove("hello");
  await root.loader.await();
  return { tools: root.tools.schemas(agent).map((s) => s.name), commands: root.commands.list(agent).length };
});

console.log(JSON.stringify(report, null, 2));
process.exit(0);
