// Tests of the plugin host through its JSON-RPC interface, as the daemon uses it.
//   node --test test/

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

class Host {
  constructor(home) {
    this.child = spawn(process.execPath, [MAIN, "--home", home], { stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.notes = [];
    this.stderr = "";
    this.nextId = 1;
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (message.id !== undefined && this.pending.has(message.id)) {
          const { resolve, reject } = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) reject(Object.assign(new Error(message.error.message), message.error));
          else resolve(message.result);
        } else this.notes.push(message);
      }
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`The host exited (${code}): ${this.stderr.slice(-2000)}`));
      this.pending.clear();
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => this.child.on("exit", resolve));
  }
}

describe("plugin host", () => {
  let home;
  let host;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "harness-dsh-"));
    host = new Host(home);
    const state = await host.call("initialize");
    assert.equal(state.runtime, "0.2.0-rc.2");
    assert.deepEqual(state.bundles, []);
  });

  after(async () => {
    await host.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("installs a bundle from a folder as a copy and loads its rows", async () => {
    const installed = await host.call("plugins.install", { spec: join(FIXTURES, "hello-dsh") });
    assert.deepEqual(installed, { name: "hello-dsh", version: "1.0.0" });
    assert.ok(existsSync(join(home, "node_modules", "hello-dsh", "index.js")));
    const state = await host.call("reload");
    const bundle = state.bundles.find((b) => b.name === "hello-dsh");
    assert.equal(bundle.enabled, true);
    assert.equal(bundle.problem, null);
    const rows = Object.fromEntries(bundle.rows.map((r) => [r.id, r]));
    assert.equal(rows.hello.state, "active");
    assert.equal(rows["hello-guard"].state, "disabled");
  });

  it("gives a session the tools, commands, skills, and prompt text of the plugins", async () => {
    await host.call("agent.open", { agentId: "s1", cwd: home });
    const snap = await host.call("snapshot", { agentId: "s1" });
    assert.deepEqual(snap.tools.map((t) => t.name).sort(), ["danger", "greet"]);
    assert.deepEqual(snap.tools.find((t) => t.name === "greet").parameters.required, ["name"]);
    assert.deepEqual(snap.commands, [{ name: "hello", description: "Greet someone.", hint: "[name]" }]);
    assert.equal(snap.skills[0].name, "greeting-style");
    assert.equal(snap.skills[0].content, "Call the greet tool with the name.");
    assert.match(snap.prompt, /use the greet tool/);
    assert.doesNotMatch(snap.prompt, /harness:identity/);
  });

  it("runs tools through the full DeepSeek tool pipeline", async () => {
    const greet = await host.call("tools.execute", { agentId: "s1", callId: "c1", name: "greet", arguments: { name: "Ada" } });
    assert.deepEqual(greet, { isError: false, text: "Hi, Ada! (checked)", error: null });
    const danger = await host.call("tools.execute", { agentId: "s1", callId: "c2", name: "danger", arguments: {} });
    assert.equal(danger.isError, true);
    assert.equal(danger.error, "hello-dsh blocks the danger tool");
  });

  it("runs commands", async () => {
    const run = await host.call("commands.execute", { agentId: "s1", line: "/hello Ada" });
    assert.equal(run.found, true);
    assert.equal(run.kind, "success");
    assert.match(run.text, /Hi, +Ada!/);
    assert.deepEqual(await host.call("commands.execute", { agentId: "s1", line: "/nothing" }), { found: false });
  });

  it("reports a row that waits for a service that Harness does not have", async () => {
    const state = await host.call("plugins.set_row", { id: "hello-guard", enabled: true });
    const guard = state.bundles[0].rows.find((r) => r.id === "hello-guard");
    assert.equal(guard.state, "pending");
    assert.match(guard.error, /webServer/);
    assert.match(readFileSync(join(home, "cordis.patch.yml"), "utf8"), /hello-guard/);
  });

  it("turns a row and a bundle off", async () => {
    let state = await host.call("plugins.set_row", { id: "hello", enabled: false });
    assert.equal(state.bundles[0].rows.find((r) => r.id === "hello").state, "disabled");
    await host.call("agent.open", { agentId: "s2", cwd: home });
    assert.deepEqual((await host.call("snapshot", { agentId: "s2" })).tools, []);
    await host.call("plugins.set_row", { id: "hello", enabled: true });
    state = await host.call("plugins.set_bundle", { name: "hello-dsh", enabled: false });
    assert.equal(state.bundles[0].enabled, false);
    assert.deepEqual(state.bundles[0].rows, []);
    state = await host.call("plugins.set_bundle", { name: "hello-dsh", enabled: true });
    assert.equal(state.bundles[0].rows.find((r) => r.id === "hello").state, "active");
  });

  it("refuses a bundle that fails the DeepSeek peer gate", async () => {
    await assert.rejects(host.call("plugins.install", { spec: join(FIXTURES, "old-dsh") }), /needs another DeepSeek Harness version/);
    const manifest = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.dependencies), ["hello-dsh"]);
  });

  it("asks before it runs the build scripts of a package", async () => {
    const error = await host.call("plugins.install", { spec: join(FIXTURES, "script-dsh") }).catch((e) => e);
    // On a failure, show the result and the pnpm output: the cause can depend on the computer.
    const log = join(home, "logs", "pnpm-last.log");
    if (error.code !== 1) {
      // TEMPORARY diagnostic for the CI failure: the pnpm settings and the environment of this computer.
      const pnpm = fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.mjs", import.meta.url));
      const env = { ...process.env, CI: "1", pnpm_config_ignore_scripts: "false", pnpm_config_strict_dep_builds: "true" };
      const config = spawnSync(process.execPath, [pnpm, "config", "list"], { cwd: home, env, encoding: "utf8" });
      const vars = Object.keys(process.env).filter((k) => /pnpm|npm_config|ignore|script/i.test(k)).map((k) => `${k}=${process.env[k]}`);
      const ran = existsSync(join(home, "node_modules", "script-dsh", "ran.txt"));
      const pnpmLog = existsSync(log) ? readFileSync(log, "utf8") : "(no pnpm log)";
      assert.fail(
        [`The install did not ask. Result: ${JSON.stringify(error)}`, `ran.txt: ${ran}`, pnpmLog,
          "--- pnpm config list:", config.stdout + config.stderr, "--- env:", ...vars].join("\n"),
      );
    }
    assert.equal(error.code, 1);
    assert.equal(error.data.pendingBuilds.length, 1);
    assert.match(error.data.pendingBuilds[0], /^script-dsh@file:/);
    const manifest = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.dependencies), ["hello-dsh"]); // Restored.
    const installed = await host.call("plugins.install", { spec: join(FIXTURES, "script-dsh"), approvedBuilds: error.data.pendingBuilds });
    assert.equal(installed.name, "script-dsh");
    assert.ok(existsSync(join(home, "node_modules", "script-dsh", "ran.txt")));
  });

  it("removes a bundle", async () => {
    await host.call("plugins.remove", { name: "script-dsh" });
    const state = await host.call("reload");
    assert.deepEqual(state.bundles.map((b) => b.name), ["hello-dsh"]);
  });

  it("keeps stdout for the protocol when a plugin writes to the console", async () => {
    assert.ok(host.notes.every((n) => n.jsonrpc === "2.0"));
  });
});
