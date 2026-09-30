// Tests of phase 2: the agent and tool events, the approval service, and steer.
//   node --test "test/*.test.mjs"

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** A test daemon: it calls the host, and it answers the approval requests of the host. */
class Daemon {
  constructor(home) {
    this.child = spawn(process.execPath, [MAIN, "--home", home], { stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map();
    this.notes = [];
    this.approvals = [];
    this.answer = "allowed-once";
    this.next = 1;
    this.stderr = "";
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (msg.method === "approval.request") {
          this.approvals.push(msg.params);
          this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: this.answer } }) + "\n");
        } else if (msg.method) {
          this.notes.push(msg);
        } else if (this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(Object.assign(new Error(msg.error.message), msg.error)) : resolve(msg.result);
        }
      }
    });
    this.child.stderr.on("data", (c) => (this.stderr += c));
    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`The host exited (${code}): ${this.stderr.slice(-2000)}`));
      this.pending.clear();
    });
  }

  call(method, params = {}) {
    const id = this.next++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  emit(name, payload, agentId = "s1") {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "event.emit", params: { agentId, name, payload } }) + "\n");
  }

  dispatch(name, payload, agentId = "s1") {
    return this.call("event.dispatch", { agentId, name, payload });
  }

  async events() {
    const run = await this.call("commands.execute", { agentId: "s1", line: "/events" });
    return JSON.parse(run.text);
  }

  async close() {
    this.child.stdin.end();
    await new Promise((resolve) => this.child.on("exit", resolve));
  }
}

describe("agent and tool events", () => {
  let home;
  let daemon;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "harness-dsh-events-"));
    daemon = new Daemon(home);
    await daemon.call("initialize");
    await daemon.call("plugins.install", { spec: join(FIXTURES, "events-dsh") });
    await daemon.close();
    daemon = new Daemon(home); // New package code needs a new process.
    await daemon.call("initialize");
    await daemon.call("agent.open", { agentId: "s1", cwd: home, source: "resume" });
  });

  after(async () => {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("reports the events that have listeners", async () => {
    const { listeners } = await daemon.call("snapshot", { agentId: "s1" });
    for (const name of ["agent/created", "agent/pre-step", "agent/request", "agent/turn-stopping", "tools/pre-execute", "tools/post-execute", "tools/result"]) {
      assert.ok(listeners.includes(name), name);
    }
    assert.ok(!listeners.includes("approval/request"));
  });

  it("sends agent/created through the real agents service, with the source", async () => {
    const created = (await daemon.events()).find((e) => e.name === "agent/created");
    assert.deepEqual(created, { name: "agent/created", agent: "s1", source: "resume" });
  });

  it("lets agent/pre-step change the new messages, or reject the step", async () => {
    const changed = await daemon.dispatch("agent/pre-step", { turn: 1, step: 1, messages: ["Hello"] });
    assert.deepEqual(changed, { kind: "enter", messages: ["[checked] Hello"] });
    const later = await daemon.dispatch("agent/pre-step", { turn: 1, step: 2, messages: [] });
    assert.deepEqual(later, { kind: "enter", messages: [] });
    assert.deepEqual(await daemon.dispatch("agent/pre-step", { turn: 2, step: 1, messages: ["please reject this"] }), { kind: "reject" });
  });

  it("lets agent/request change the call config", async () => {
    const { config } = await daemon.dispatch("agent/request", { turn: 1, step: 1, config: { provider: "fake", model: "m" } });
    assert.deepEqual(config, { provider: "fake", model: "m", temperature: 0.25, maxTokens: 77 });
  });

  it("lets agent/request-error ask for a retry", async () => {
    assert.deepEqual(await daemon.dispatch("agent/request-error", { turn: 1, step: 1, provider: "fake", message: "HTTP 500" }), { retry: true });
    assert.deepEqual(await daemon.dispatch("agent/request-error", { turn: 1, step: 1, provider: "fake", message: "HTTP 500" }), { retry: false });
  });

  it("returns the messages that agent/turn-stopping listeners steer, once for each turn", async () => {
    assert.deepEqual(await daemon.dispatch("agent/turn-stopping", { turn: 1 }), { steered: ["Also say goodbye."] });
    assert.deepEqual(await daemon.dispatch("agent/turn-stopping", { turn: 1 }), { steered: [] });
  });

  it("gives tools/pre-execute decisions for Harness tools", async () => {
    const deny = await daemon.dispatch("tools/pre-execute", { callId: "c1", name: "write", arguments: { path: "a" } });
    assert.deepEqual(deny.decision, { kind: "deny", reason: "events-dsh blocks write" });
    const ask = await daemon.dispatch("tools/pre-execute", { callId: "c2", name: "glob", arguments: {} });
    assert.deepEqual(ask.decision, { kind: "ask", reason: "events-dsh asks before glob" });
    assert.deepEqual((await daemon.dispatch("tools/pre-execute", { callId: "c3", name: "bash", arguments: {} })).decision, { kind: "allow" });
  });

  it("gives tools/post-execute decisions for Harness tools", async () => {
    const read = await daemon.dispatch("tools/post-execute", { callId: "c4", name: "read", arguments: {}, result: { isError: false, text: "line 1" } });
    assert.deepEqual(read.decision, { kind: "accept", text: "line 1\n[read checked]", contexts: ["Note from events-dsh."] });
    const other = await daemon.dispatch("tools/post-execute", { callId: "c5", name: "bash", arguments: {}, result: { isError: false, text: "ok" } });
    assert.deepEqual(other.decision, { kind: "accept", text: null, contexts: [] });
  });

  it("sends emit events to the listeners", async () => {
    daemon.emit("agent/status", { status: "running" });
    daemon.emit("agent/inbox/claimed", { text: "Hello", turn: 1 });
    daemon.emit("tools/result", { callId: "c6", name: "read", arguments: {}, result: { isError: false, text: "x" } });
    daemon.emit("agent/assistant-stream", { frame: { type: "start", attemptId: "a1", revision: 0, turn: 1, step: 1 } });
    const seen = await daemon.events();
    assert.ok(seen.some((e) => e.name === "agent/status" && e.status === "running"));
    assert.ok(seen.some((e) => e.name === "agent/inbox/claimed" && e.text === "Hello"));
    assert.ok(seen.some((e) => e.name === "tools/result" && e.tool === "read" && e.isError === false));
    assert.ok(seen.some((e) => e.name === "agent/assistant-stream" && e.type === "start"));
  });

  it("asks the daemon when a hook asks about a DeepSeek tool", async () => {
    daemon.answer = "allowed-once";
    const allowed = await daemon.call("tools.execute", { agentId: "s1", callId: "c7", name: "askme", arguments: {} });
    assert.deepEqual(allowed, { isError: false, text: "askme ran", error: null });
    assert.deepEqual(daemon.approvals.at(-1), { agentId: "s1", toolName: "askme", callId: "c7", reason: "events-dsh asks before askme" });
    daemon.answer = "rejected";
    const rejected = await daemon.call("tools.execute", { agentId: "s1", callId: "c8", name: "askme", arguments: {} });
    assert.equal(rejected.isError, true);
  });

  it("sends agent/disposed when a session closes", async () => {
    await daemon.call("agent.open", { agentId: "s2", cwd: home });
    await daemon.call("agent.close", { agentId: "s2" });
    const seen = await daemon.events();
    assert.ok(seen.some((e) => e.name === "agent/disposed" && e.agent === "s2"));
  });
});
