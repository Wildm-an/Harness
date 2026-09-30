// Module resolution for plugins (phase 0, test 3).
//
// DeepSeek installs plugins in a profile folder with `autoInstallPeers: false`. A plugin gets the
// host copy of each `@deepseek-ai/*` peer, so that all plugins share one instance of each
// service package. DeepSeek does this with Node internals. This hook uses the public
// `module.registerHooks` API (Node 22.15 and later):
//
// 1. The normal resolution runs first. A package that the plugin installs itself wins.
// 2. A missing `@deepseek-ai/*` import resolves from the host folder.
// 3. A missing bare name resolves from the profile folder. The Loader imports plugin names
//    from its own folder, because it runs without Node internals.

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const HOST = new URL("../package.json", import.meta.url).href;

export function installResolveHook(profileDir) {
  const profile = pathToFileURL(profileDir.replace(/[\\/]*$/, "/") + "package.json").href;
  return registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (error) {
        if (error?.code !== "ERR_MODULE_NOT_FOUND" || specifier.startsWith(".") || specifier.startsWith("/") || /^[a-z][\w+.-]*:/i.test(specifier)) {
          throw error;
        }
        if (specifier.startsWith("@deepseek-ai/")) {
          try {
            return next(specifier, { ...context, parentURL: HOST });
          } catch {
            // Not in the host: try the profile.
          }
        }
        try {
          return next(specifier, { ...context, parentURL: profile });
        } catch {
          throw error;
        }
      }
    },
  });
}
