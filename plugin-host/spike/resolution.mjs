// Phase 0 spike, test 3: a plugin in a profile folder imports a peer that is only in the host.
//
//   <node.exe> --expose-internals resolution.mjs <profile folder> [hook]
//
// With "hook", a public Node resolve hook (module.registerHooks) resolves a missing
// @deepseek-ai/* import from the host folder, as the DeepSeek "interception layer" does.
// A package that the plugin installs itself still wins, because the hook tries the normal
// resolution first.

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const [profile, mode] = process.argv.slice(2);
const HOST = import.meta.url; // The host folder: its node_modules has the runtime packages.
const fromHost = [];

const PROFILE = pathToFileURL(profile + "/package.json").href;
const fromProfile = [];

if (mode === "hook" || mode === "hook-profile") {
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (error) {
        if (error?.code !== "ERR_MODULE_NOT_FOUND" || specifier.startsWith(".") || specifier.includes(":")) throw error;
        if (specifier.startsWith("@deepseek-ai/")) {
          try {
            fromHost.push(specifier);
            return next(specifier, { ...context, parentURL: HOST });
          } catch {
            // Not in the host: try the profile below.
          }
        }
        // "hook-profile": a bare plugin name that the Loader imports from its own folder
        // (no Node internals) resolves in the profile folder.
        if (mode !== "hook-profile") throw error;
        fromProfile.push(specifier);
        return next(specifier, { ...context, parentURL: PROFILE });
      }
    },
  });
}

const { Context } = await import("@deepseek-ai/cordis");
const Loader = (await import("@deepseek-ai/cordis-plugin-loader")).default;
const report = { mode: mode ?? "no hook", checks: {} };

const root = new Context();
await root.plugin(Loader, { baseUrl: pathToFileURL(profile + "/").href });
for (const [id, name] of [["system-prompt", "@deepseek-ai/dsh-system-prompt"], ["tools", "@deepseek-ai/dsh-tools"]]) {
  await root.loader.create({ id, name, config: {} });
}
await root.loader.create({ id: "community", name: "community-dsh", config: { suffix: "!" } });
await root.loader.await();

const entry = root.loader.resolve("community");
report.checks.state = entry?.fiber?.state === 2 ? "active" : `not active: ${String(entry?.fiber?.error ?? entry?.error ?? "unknown").split("\n")[0]}`;
report.checks.tools = root.tools.schemas().map((s) => s.name);
if (report.checks.tools.includes("shout")) {
  const result = await root.tools.execute({ callId: "c1", name: "shout", arguments: { word: "hi" }, signal: new AbortController().signal });
  report.checks.result = result.value;
}
report.checks.resolvedFromHost = [...new Set(fromHost)];
report.checks.resolvedFromProfile = [...new Set(fromProfile)];
report.checks.internals = Boolean(root.loader.internal);
console.log(JSON.stringify(report, null, 2));
process.exit(0);
