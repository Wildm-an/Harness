// The Harness plugin host: it loads DeepSeek Harness plugins and serves them to the daemon.
//
//   node src/main.mjs --home <folder>
//
// The daemon talks to it with JSON-RPC 2.0 on stdin and stdout, one JSON message on each line.
// Plugin output on stdout would break the protocol, so console output goes to stderr.

import { parseArgs } from "node:util";
import { installResolveHook } from "./hook.mjs";

const { values } = parseArgs({ options: { home: { type: "string" } } });
if (!values.home) {
  process.stderr.write("usage: main.mjs --home <folder>\n");
  process.exit(2);
}

// Keep stdout for the protocol only.
const writeOut = process.stdout.write.bind(process.stdout);
for (const method of ["log", "info", "debug", "warn", "error", "trace"]) {
  console[method] = (...args) => process.stderr.write(args.map((a) => (typeof a === "string" ? a : String(a?.stack ?? JSON.stringify(a)))).join(" ") + "\n");
}
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);

installResolveHook(values.home);

const { RpcPeer, RpcError, INVALID_PARAMS } = await import("./rpc.mjs");
const { Profile, RUNTIME_VERSION, ProfileError } = await import("./profile.mjs");
const { Runtime } = await import("./runtime.mjs");
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const HOST_VERSION = require("../package.json").version;

const rpc = new RpcPeer(process.stdin, (line) => writeOut(line + "\n"));
const profile = new Profile(values.home);
const runtime = new Runtime(profile, (method, params) => rpc.notify(method, params), (method, params, signal) => rpc.request(method, params, signal));

function need(params, key, type = "string") {
  if (typeof params[key] !== type) throw new RpcError(INVALID_PARAMS, `'${key}' must be a ${type}.`);
  return params[key];
}

async function wrap(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProfileError) throw new RpcError(1, error.message, error.data);
    throw error;
  }
}

function state() {
  const rows = runtime.rows();
  const bundles = profile.bundles().map(({ patches, ...bundle }) => ({
    ...bundle,
    rows: rows.filter((row) => row.name === bundle.name || row.name?.startsWith(bundle.name + "/")),
  }));
  const known = new Set(bundles.flatMap((b) => b.rows.map((r) => r.id)));
  return {
    runtime: RUNTIME_VERSION,
    host: HOST_VERSION,
    node: process.version,
    home: profile.home,
    user_patch: profile.userPatchPath,
    bundles,
    orphans: rows.filter((row) => !known.has(row.id)),
    warnings: runtime.warnings,
  };
}

rpc.on("initialize", async () => {
  await runtime.start();
  return state();
});
rpc.on("state", () => state());
rpc.on("reload", async () => {
  await runtime.loadRows();
  return state();
});
rpc.on("logs", () => runtime.logs.slice(-100));

rpc.on("agent.open", (p) => runtime.openAgent(need(p, "agentId"), typeof p.cwd === "string" ? p.cwd : null, typeof p.source === "string" ? p.source : "startup"));
rpc.on("agent.close", (p) => {
  runtime.closeAgent(need(p, "agentId"));
  return { ok: true };
});
rpc.on("snapshot", (p, signal) => runtime.snapshot(need(p, "agentId"), signal));
rpc.on("tools.execute", (p, signal) => runtime.executeTool(need(p, "agentId"), { callId: need(p, "callId"), name: need(p, "name"), arguments: p.arguments }, signal));
rpc.on("commands.execute", (p, signal) => runtime.executeCommand(need(p, "agentId"), need(p, "line"), signal));
// Phase 2: the agent and tool events of the Harness loop. "event.emit" is a notification.
rpc.on("event.dispatch", (p, signal) => runtime.dispatch(need(p, "agentId"), need(p, "name"), p.payload ?? {}, signal));
rpc.on("event.emit", (p) => runtime.emit(need(p, "agentId"), need(p, "name"), p.payload ?? {}));

// Package operations. A changed package needs a new host process: the daemon restarts it.
rpc.on("plugins.install", (p, signal) =>
  wrap(() => profile.install(need(p, "spec"), { approvedBuilds: Array.isArray(p.approvedBuilds) ? p.approvedBuilds : [], useMirror: p.useMirror === true, signal })),
);
rpc.on("plugins.remove", (p, signal) => wrap(() => profile.remove(need(p, "name"), { signal })));
rpc.on("plugins.set_bundle", (p) =>
  wrap(async () => {
    profile.setBundleEnabled(need(p, "name"), need(p, "enabled", "boolean"));
    await runtime.loadRows();
    return state();
  }),
);
rpc.on("plugins.set_row", (p) =>
  wrap(async () => {
    profile.setRowDisabled(need(p, "id"), !need(p, "enabled", "boolean"));
    await runtime.loadRows();
    return state();
  }),
);
rpc.on("shutdown", async () => {
  setTimeout(() => process.exit(0), 10);
  await runtime.dispose();
  return { ok: true };
});

process.on("unhandledRejection", (error) => process.stderr.write(`unhandled rejection: ${error?.stack ?? error}\n`));
process.on("uncaughtException", (error) => process.stderr.write(`uncaught exception: ${error?.stack ?? error}\n`));

await rpc.closed; // The daemon closed stdin: stop.
await runtime.dispose().catch(() => {});
process.exit(0);
