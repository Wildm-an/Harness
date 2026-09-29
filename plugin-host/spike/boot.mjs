// Phase 0 spike, test 1: start a Cordis Loader and load the real DeepSeek core services.
//
// Run with the Node of the sidecar (the Playwright driver):
//   <node.exe> --expose-internals boot.mjs
// It prints one JSON report: the Node version, the loader mode, and the state of each entry.

import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";

const SERVICES = [
  ["system-prompt", "@deepseek-ai/dsh-system-prompt", "systemPrompt"],
  ["tools", "@deepseek-ai/dsh-tools", "tools"],
  ["commands", "@deepseek-ai/dsh-commands", "commands"],
  ["skills", "@deepseek-ai/dsh-skill", "skills"],
  ["llm", "@deepseek-ai/dsh-llm", "llm"],
];

const report = { node: process.version, internals: process.execArgv.includes("--expose-internals"), entries: {}, errors: [] };
const started = performance.now();

const root = new Context();
await root.plugin(Loader, { baseUrl: import.meta.url });
report.loaderInternal = Boolean(root.loader.internal);

for (const [id, name] of SERVICES) {
  try {
    await root.loader.create({ id, name, config: {} });
  } catch (e) {
    report.errors.push(`${id}: ${e?.stack ?? e}`);
  }
}
await root.loader.await();

for (const [id, name, service] of SERVICES) {
  const entry = root.loader.resolve(id);
  report.entries[id] = {
    module: name,
    service,
    provided: root.get(service) !== undefined,
    fiber: entry?.fiber?.state ?? null,
    error: entry?.fiber?.error ? String(entry.fiber.error) : null,
  };
}
report.ms = Math.round(performance.now() - started);
console.log(JSON.stringify(report, null, 2));
await root.registry?.dispose?.();
process.exit(0);
