// The DeepSeek profile of Harness: installed bundles, their on/off state, the patch layers, and
// the package operations with pnpm. The layout follows DeepSeek Harness (app-boot profile.ts):
//
//   <home>/package.json         dependencies = the installed packages; dsh.profile.bundles = the
//                               bundles that are on, in load order
//   <home>/pnpm-workspace.yaml  nodeLinker: hoisted, autoInstallPeers: false, allowBuilds
//   <home>/cordis.yml           the root entry list. It is always "[]": all rows come from patches.
//   <home>/cordis.patch.yml     the user layer: row overrides, for example `disabled`
//
// Layer order (a later layer wins for each row): the patch of each bundle that is on, in the
// bundle order, then the user layer.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import semver from "semver";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";

const require = createRequire(import.meta.url);
// The pnpm package does not export its package.json: find it on disk.
const PNPM = findPnpm();
const OUTPUT_LIMIT = 16384;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ICON_BYTES = 256 * 1024;
const ICON_TYPES = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
// The mirror registry, when the npm registry cannot be reached. A third party runs it, so the
// install uses it only after the user agrees (install with useMirror).
export const FALLBACK_REGISTRY = "https://registry.npmmirror.com/";

/** The runtime version that the DeepSeek peer gate uses: the version of the bundled service packages. */
export const RUNTIME_VERSION = require("@deepseek-ai/dsh-tools/package.json").version;

export class ProfileError extends Error {
  constructor(message, data) {
    super(message);
    this.data = data;
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new ProfileError(`${path} is not valid JSON: ${error.message}`);
  }
}

function writeAtomic(path, text) {
  writeFileSync(path + ".tmp", text);
  renameSync(path + ".tmp", path);
}

/**
 * The DeepSeek peer gate (app-boot plugin-compatibility.ts): only peers named `@deepseek-ai/dsh` or
 * `@deepseek-ai/dsh-*` are checked, with prereleases included. `workspace:` ranges pass.
 * @returns the failed peers, as "name@range" texts.
 */
export function gateFailures(peers, runtime = RUNTIME_VERSION) {
  return Object.entries(peers ?? {})
    .filter(([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"))
    .filter(([, range]) => typeof range !== "string" || (!range.startsWith("workspace:") && !safeSatisfies(runtime, range)))
    .map(([name, range]) => `${name}@${range}`);
}

function safeSatisfies(version, range) {
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

/** The "Ignored build scripts" keys that pnpm prints. Each key goes to `allowBuilds` as it is. */
export function ignoredBuilds(output) {
  const keys = [];
  for (const match of output.matchAll(/Ignored build scripts:\s*([^\n]+)/g)) {
    for (const key of match[1].split(",")) if (key.trim()) keys.push(key.trim().replace(/\.$/, ""));
  }
  return [...new Set(keys)];
}

/** How an install source is fetched: a local folder or file, a git address, a URL, or a registry name. */
export function specKind(spec) {
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|ssh:\/\/|git@)/.test(spec) || /\.git(#.*)?$/.test(spec)) return "git";
  if (/^https?:\/\//.test(spec)) return spec.endsWith(".tgz") ? "tarball" : "git";
  if (spec.startsWith("file:") || isAbsolute(spec) || /^\.\.?[\\/]/.test(spec) || /^[a-zA-Z]:[\\/]/.test(spec)) return "local";
  return "registry";
}

/**
 * The full path of a folder, also when the folder does not exist yet. On Windows, a path can have a
 * short 8.3 name (C:\Users\RUNNER~1), and pnpm uses the long name. pnpm then sees two projects:
 * a build script stays pending, with no question and no run.
 */
export function fullPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(fullPath(parent), basename(absolute));
  }
}

export class Profile {
  constructor(home) {
    home = fullPath(home);
    this.home = home;
    this.manifestPath = join(home, "package.json");
    this.workspacePath = join(home, "pnpm-workspace.yaml");
    this.rootPath = join(home, "cordis.yml");
    this.userPatchPath = join(home, "cordis.patch.yml");
    this.logDir = join(home, "logs");
  }

  /** Create the profile files that do not exist. The root entry list is always "[]". */
  ensure() {
    mkdirSync(this.home, { recursive: true });
    if (!existsSync(this.manifestPath)) {
      writeAtomic(this.manifestPath, JSON.stringify({ name: "harness-dsh-profile", private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + "\n");
    }
    if (!existsSync(this.workspacePath)) {
      writeAtomic(this.workspacePath, "nodeLinker: hoisted\nautoInstallPeers: false\n");
    }
    writeAtomic(this.rootPath, "[]\n");
  }

  manifest() {
    return readJson(this.manifestPath, { dependencies: {}, dsh: { profile: { bundles: [] } } });
  }

  writeManifest(manifest) {
    writeAtomic(this.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }

  enabledBundles() {
    const bundles = this.manifest().dsh?.profile?.bundles;
    return Array.isArray(bundles) ? bundles.filter((b) => typeof b === "string") : [];
  }

  setEnabledBundles(names) {
    const manifest = this.manifest();
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: names } };
    this.writeManifest(manifest);
  }

  packageDir(name) {
    return join(this.home, "node_modules", ...name.split("/"));
  }

  /** The installed packages with their bundle data. A package with no `dsh.bundle` has a problem. */
  bundles() {
    const enabled = this.enabledBundles();
    const names = Object.keys(this.manifest().dependencies ?? {});
    const order = (name) => (enabled.includes(name) ? enabled.indexOf(name) : enabled.length);
    return names.sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((name) => {
      const dir = this.packageDir(name);
      const pkg = readJson(join(dir, "package.json"), null);
      if (pkg === null) return { name, dir, enabled: enabled.includes(name), problem: "The package is not installed. Install it again." };
      const bundle = pkg.dsh?.bundle;
      const patches = bundle ? [bundle.patch].flat().filter((p) => typeof p === "string") : [];
      const failures = gateFailures(pkg.peerDependencies);
      let problem = null;
      if (!bundle || patches.length === 0) problem = "The package is not a DeepSeek Harness bundle: its package.json has no dsh.bundle.patch.";
      else if (failures.length) problem = `The bundle needs another DeepSeek Harness version: ${failures.join(", ")}. This host has ${RUNTIME_VERSION}.`;
      return {
        name,
        version: pkg.version ?? null,
        description: typeof pkg.description === "string" ? pkg.description : "",
        dir,
        enabled: enabled.includes(name),
        problem,
        patches: patches.map((p) => resolve(dir, p)),
        client: pkg.dsh?.client !== undefined,
        icon: iconData(dir, pkg.icon),
      };
    });
  }

  readPatchFile(path) {
    const text = readFileSync(path, "utf8");
    const data = yaml.load(text, { schema: entryListSchema });
    if (data == null) return [];
    if (!Array.isArray(data)) throw new ProfileError(`${path} must be a YAML list of patches.`);
    return data;
  }

  /** The patch layers: each bundle that is on and passes the gate, in the bundle order, then the user layer. */
  patches() {
    const warnings = [];
    const layers = [];
    for (const bundle of this.bundles()) {
      if (!bundle.enabled || bundle.problem) continue;
      for (const path of bundle.patches) {
        try {
          layers.push(...this.readPatchFile(path));
        } catch (error) {
          warnings.push(`${bundle.name}: ${error.message}`);
        }
      }
    }
    if (existsSync(this.userPatchPath)) {
      try {
        layers.push(...this.readPatchFile(this.userPatchPath));
      } catch (error) {
        warnings.push(error.message);
      }
    }
    return { patches: layers, warnings };
  }

  /** Write `disabled` for a row into the user layer: change the last override of the row, or add one. */
  setRowDisabled(id, disabled) {
    const patches = existsSync(this.userPatchPath) ? this.readPatchFile(this.userPatchPath) : [];
    const own = [...patches].reverse().find((p) => p && typeof p === "object" && !("insert" in p) && p.id === id);
    if (own) own.disabled = disabled;
    else patches.push({ id, disabled });
    writeAtomic(this.userPatchPath, yaml.dump(patches, { schema: entryListSchema }));
  }

  /** Add the build-script keys that the user approved to `allowBuilds`. */
  allowBuilds(keys) {
    if (!keys?.length) return;
    const workspace = yaml.load(readFileSync(this.workspacePath, "utf8")) ?? {};
    workspace.allowBuilds = { ...(workspace.allowBuilds ?? {}) };
    for (const key of keys) workspace.allowBuilds[key] = true;
    writeAtomic(this.workspacePath, yaml.dump(workspace));
  }

  /** Run pnpm in the profile. Returns the exit code and the output (stdout and stderr). */
  pnpm(args, { signal, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [PNPM, ...args, "--config.update-notifier=false"], {
        cwd: this.home,
        env: {
          ...process.env,
          CI: "1",
          npm_config_fund: "false",
          // The user approves each build script (allowBuilds). A pnpm setting of the computer, for
          // example of a CI runner, must not run or skip the scripts without the approval. With
          // ignore-scripts, pnpm skips all scripts with no message, and the plugin misses its build.
          pnpm_config_strict_dep_builds: "true",
          pnpm_config_dangerously_allow_all_builds: "false",
          pnpm_config_ignore_scripts: "false",
        },
        windowsHide: true,
      });
      let output = "";
      const collect = (chunk) => {
        output += chunk;
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const stop = () => child.kill();
      const timer = setTimeout(stop, timeoutMs);
      signal?.addEventListener("abort", stop, { once: true });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new ProfileError(`pnpm did not start: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        mkdirSync(this.logDir, { recursive: true });
        writeFileSync(join(this.logDir, "pnpm-last.log"), `$ pnpm ${args.join(" ")}\n${output}`);
        if (signal?.aborted) reject(new ProfileError("The operation was cancelled."));
        else resolvePromise({ code: code ?? 1, output });
      });
    });
  }

  /**
   * Read the manifest of a package before the install, when possible. If the registry cannot be
   * reached, throws ProfileError with data.mirror. With useMirror, the lookup uses the mirror.
   */
  async inspect(spec, signal, useMirror = false) {
    const kind = specKind(spec);
    if (kind === "local") {
      const path = resolve(spec.replace(/^file:/, ""));
      if (!existsSync(path)) throw new ProfileError(`The path does not exist: ${path}`);
      if (statSync(path).isDirectory()) return { kind, spec: `file:${path}`, pkg: readJson(join(path, "package.json"), null) };
      return { kind, spec: `file:${path}`, pkg: null }; // A .tgz file: the check runs after the install.
    }
    if (kind !== "registry") return { kind, spec, pkg: null };
    const registry = useMirror ? FALLBACK_REGISTRY : null;
    const args = ["view", spec, "name", "version", "description", "peerDependencies", "dsh", "--json", ...(registry ? ["--registry", registry] : [])];
    const { code, output } = await this.pnpm(args, { signal, timeoutMs: 60_000 });
    if (code === 0) {
      const text = output.slice(output.indexOf("{"));
      try {
        return { kind, spec, pkg: JSON.parse(text), registry };
      } catch {
        throw new ProfileError(`pnpm view gave output that is not JSON for ${spec}.`);
      }
    }
    if (!registry && /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network/i.test(output)) {
      throw new ProfileError(
        `The npm registry cannot be reached for ${spec}. You can install from the mirror ${FALLBACK_REGISTRY} instead. A third party runs the mirror.`,
        { mirror: FALLBACK_REGISTRY },
      );
    }
    throw new ProfileError(`The package ${spec} is not in the registry, or the lookup failed: ${lastLines(output)}`);
  }

  /**
   * Install a bundle: a registry name, a git address, a tarball URL, or a local folder or .tgz file.
   * Checks the bundle and the peer gate. A failure restores package.json and pnpm-lock.yaml.
   * useMirror: install from FALLBACK_REGISTRY. Use it only after the user agrees (data.mirror).
   * @returns {{name, version}} or throws ProfileError with data.pendingBuilds or data.mirror.
   */
  async install(spec, { approvedBuilds = [], useMirror = false, signal } = {}) {
    this.ensure();
    const inspected = await this.inspect(spec.trim(), signal, useMirror);
    if (inspected.pkg) checkBundle(inspected.pkg);
    this.allowBuilds(approvedBuilds);
    const lockPath = join(this.home, "pnpm-lock.yaml");
    const before = { manifest: readFileSync(this.manifestPath, "utf8"), lock: existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null };
    const restore = () => {
      writeAtomic(this.manifestPath, before.manifest);
      if (before.lock !== null) writeAtomic(lockPath, before.lock);
    };
    const oldDeps = Object.keys(JSON.parse(before.manifest).dependencies ?? {});
    const registryArgs = inspected.registry ? ["--registry", inspected.registry] : [];
    const { code, output } = await this.pnpm(["add", inspected.spec, ...registryArgs], { signal });
    // pnpm exits with an error when it ignores a build script. Also check the output after a success.
    const pendingBuilds = ignoredBuilds(output);
    if (code !== 0 || pendingBuilds.length) {
      restore();
      if (pendingBuilds.length) {
        throw new ProfileError(`The install needs to run build scripts of these packages: ${pendingBuilds.join(", ")}. Allow them to continue.`, { pendingBuilds });
      }
      throw new ProfileError(`pnpm add failed: ${lastLines(output)}`);
    }
    const added = Object.keys(this.manifest().dependencies ?? {}).filter((n) => !oldDeps.includes(n));
    const name = added[0] ?? (inspected.pkg?.name && oldDeps.includes(inspected.pkg.name) ? inspected.pkg.name : undefined);
    if (!name) {
      restore();
      throw new ProfileError("pnpm finished, but no package was added.");
    }
    const pkg = readJson(join(this.packageDir(name), "package.json"), null);
    try {
      checkBundle(pkg);
    } catch (error) {
      await this.pnpm(["remove", name], { signal });
      restore();
      throw error;
    }
    const enabled = this.enabledBundles();
    if (!enabled.includes(name)) this.setEnabledBundles([...enabled, name]);
    return { name, version: pkg.version };
  }

  /** Uninstall a bundle and remove it from the bundle list. */
  async remove(name, { signal } = {}) {
    if (!(name in (this.manifest().dependencies ?? {}))) throw new ProfileError(`The bundle ${name} is not installed.`);
    this.setEnabledBundles(this.enabledBundles().filter((n) => n !== name));
    const { code, output } = await this.pnpm(["remove", name], { signal });
    if (code !== 0) throw new ProfileError(`pnpm remove failed: ${lastLines(output)}`);
  }

  setBundleEnabled(name, enabled) {
    if (!(name in (this.manifest().dependencies ?? {}))) throw new ProfileError(`The bundle ${name} is not installed.`);
    const names = this.enabledBundles().filter((n) => n !== name);
    this.setEnabledBundles(enabled ? [...names, name] : names);
  }
}

function findPnpm() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "pnpm", "bin", "pnpm.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pnpm is not installed next to the plugin host.");
    dir = parent;
  }
}

function checkBundle(pkg) {
  if (!pkg || typeof pkg.name !== "string") throw new ProfileError("The package has no package.json with a name.");
  if (!pkg.dsh?.bundle?.patch) {
    throw new ProfileError(`${pkg.name} is not a DeepSeek Harness bundle: its package.json has no dsh.bundle.patch.`);
  }
  const failures = gateFailures(pkg.peerDependencies);
  if (failures.length) {
    throw new ProfileError(`${pkg.name} needs another DeepSeek Harness version: ${failures.join(", ")}. This host has ${RUNTIME_VERSION}.`);
  }
}

function iconData(dir, icon) {
  if (typeof icon !== "string") return null;
  const path = resolve(dir, icon);
  const type = ICON_TYPES[extname(path).toLowerCase()];
  if (!type || !path.startsWith(resolve(dir))) return null;
  try {
    if (statSync(path).size > MAX_ICON_BYTES) return null;
    return `data:${type};base64,${readFileSync(path).toString("base64")}`;
  } catch {
    return null;
  }
}

function lastLines(output) {
  const text = output.slice(-OUTPUT_LIMIT).trim();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^Progress:/.test(l));
  return lines.slice(-6).join(" | ") || "no output";
}
