// The Cordis runtime of the plugin host: the real DeepSeek core services, the profile rows, and
// one shim agent for each Harness session.

import { pathToFileURL } from "node:url";
import { Context, Logger } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { createScope } from "@deepseek-ai/dsh-scope";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

/** The real DeepSeek services that the host loads before the plugins (phase 0, tests 1 and 2). */
export const CORE_SERVICES = [
  ["system-prompt", "@deepseek-ai/dsh-system-prompt"],
  ["tools", "@deepseek-ai/dsh-tools"],
  ["commands", "@deepseek-ai/dsh-commands"],
  ["skills", "@deepseek-ai/dsh-skill"],
  ["llm", "@deepseek-ai/dsh-llm"],
];
const PROFILE_ENTRY = "profile";
const LOG_LIMIT = 200;
// Fiber states of Cordis (Fiber._getState): 0 waiting for services, 2 active, 3 failed, 4 disposed.
const STATES = { 0: "pending", 1: "pending", 2: "active", 3: "failed", 4: "disposed", 5: "disposed" };
const CHANGE_EVENTS = ["tools/change", "commands/change", "skills/change", "system-prompt/change"];

export class Runtime {
  /**
   * @param {import("./profile.mjs").Profile} profile
   * @param {(method: string, params: object) => void} notify - sends a notification to the daemon.
   */
  constructor(profile, notify) {
    this.profile = profile;
    this.notify = notify;
    this.agents = new Map(); // Agent id -> { agent, scope, cwd }
    this.logs = [];
    this.warnings = [];
    this.baseSections = new Set();
    this._changeTimer = null;
  }

  async start() {
    this.profile.ensure();
    const root = (this.root = new Context());
    root.logger.exporter({
      colors: 0,
      export: (message) => {
        const text = Logger.format({ colors: 0 }, message);
        this.logs.push({ level: message.type, name: message.name, text });
        if (this.logs.length > LOG_LIMIT) this.logs.shift();
        this.notify("log", { level: message.type, name: message.name, text });
      },
    });
    await root.plugin(Loader, { baseUrl: import.meta.url });
    for (const [id, name] of CORE_SERVICES) await root.loader.create({ id, name, config: {} });
    await root.loader.await();
    for (const [id] of CORE_SERVICES) {
      const entry = root.loader.resolve(id);
      if (entry.fiber?.state !== 2) throw new Error(`The core service ${id} did not start.`);
    }
    // The sections of the system-prompt service itself. The daemon gets only plugin sections.
    const base = await root.systemPrompt.assemble({});
    this.baseSections = new Set(base.sections.map((s) => s.name));
    for (const event of CHANGE_EVENTS) root.on(event, () => this._changed(event));
    await this.loadRows();
  }

  /** Create or update the Include entry that holds the profile rows. */
  async loadRows() {
    this.profile.ensure(); // The root file is "[]" again: all rows come from the patches.
    const { patches, warnings } = this.profile.patches();
    this.warnings = warnings;
    const config = { path: pathToFileURL(this.profile.rootPath).href, patches };
    const exists = (() => {
      try {
        return this.root.loader.resolve(PROFILE_ENTRY);
      } catch {
        return null;
      }
    })();
    if (exists) this.root.loader.remove(PROFILE_ENTRY);
    await this.root.loader.await();
    await this.root.loader.create({ id: PROFILE_ENTRY, name: "@deepseek-ai/cordis-plugin-include", config });
    await this.root.loader.await();
    this._changed("rows");
  }

  _changed(what) {
    clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => this.notify("changed", { what }), 50);
  }

  /** The rows of the profile, with the state of each plugin. */
  rows() {
    let tree;
    try {
      tree = this.root.loader.resolve(PROFILE_ENTRY).subtree;
    } catch {
      return [];
    }
    if (!tree) return [];
    const rows = [];
    for (const entry of tree.entries()) {
      const options = entry.options ?? {};
      if (options.group) continue;
      const id = String(entry.id).replace(new RegExp(`^${PROFILE_ENTRY}:`), "");
      const fiber = entry.fiber;
      let state = entry.disabled ? "disabled" : fiber ? STATES[fiber.state] ?? "pending" : "failed";
      let error = null;
      if (fiber?._error) error = String(fiber._error?.message ?? fiber._error);
      else if (!entry.disabled && !fiber) error = this.lastError(options.name) ?? "The module did not load.";
      if (state === "pending") {
        const inject = fiber?.inject ?? {};
        const names = Object.entries(inject).filter(([n, c]) => c?.required !== false && this.root.get(n) === undefined).map(([n]) => n);
        error = names.length ? `Waiting for services that Harness does not have: ${names.join(", ")}.` : "Waiting for services.";
      }
      rows.push({ id, name: options.name, disabled: Boolean(entry.disabled), state, error });
    }
    return rows;
  }

  lastError(name) {
    for (let i = this.logs.length - 1; i >= 0; i--) {
      const log = this.logs[i];
      if (log.level === "error" && name && log.text.includes(name)) return log.text.split("\n")[0];
    }
    for (let i = this.logs.length - 1; i >= 0; i--) {
      const log = this.logs[i];
      if (log.level === "error" && log.name === "loader") return log.text.split("\n")[0];
    }
    return null;
  }

  // -- agents: one shim agent for each Harness session --------------------------------------------

  openAgent(id, cwd) {
    this.closeAgent(id);
    const events = [];
    const steered = [];
    const agent = {
      id,
      cwd,
      session: { id, append: (type, data) => (events.push({ type, data }), events.length) },
      steer: (text) => steered.push(text),
    };
    const scope = createScope(this.root, agent);
    agent.ctx = scope.ctx;
    this.agents.set(id, { agent, scope, cwd, events, steered });
    return { id };
  }

  closeAgent(id) {
    const record = this.agents.get(id);
    if (!record) return;
    this.agents.delete(id);
    record.scope.dispose();
  }

  agent(id) {
    const record = this.agents.get(id);
    if (!record) throw new Error(`Unknown agent: ${id}`);
    return record.agent;
  }

  /** What one session gets: tool schemas, commands, skills with content, and prompt text. */
  async snapshot(agentId, signal) {
    const agent = this.agent(agentId);
    const root = this.root;
    const tools = root.tools.schemas(agent).map(({ name, description, parameters }) => ({ name, description, parameters }));
    const commands = root.commands.list(agent).map((c) => ({ name: c.name, description: c.description, hint: c.input?.hint ?? "" }));
    const skills = [];
    for (const summary of await root.skills.list({ scope: agent, cwd: agent.cwd, signal })) {
      const definition = await root.skills.get(summary.name, { scope: agent, cwd: agent.cwd, signal });
      if (!definition) continue;
      skills.push({
        name: definition.name,
        description: definition.description,
        whenToUse: definition.whenToUse ?? null,
        modelInvocable: definition.invocation?.modelInvocable !== false,
        userInvocable: definition.invocation?.userInvocable !== false,
        source: definition.source ?? null,
        provider: definition.provider ?? null,
        resourceBase: typeof definition.resourceBase === "string" ? definition.resourceBase : null,
        content: definition.content,
      });
    }
    const assembly = await root.systemPrompt.assemble({ agent, scope: agent, signal });
    const own = { ...assembly, sections: assembly.sections.filter((s) => !this.baseSections.has(s.name)) };
    let prompt = "";
    try {
      prompt = renderPrompt(own);
    } catch (error) {
      this.notify("log", { level: "warn", name: "system-prompt", text: `A plugin prompt section did not render: ${error.message}` });
    }
    return { tools, commands, skills, prompt };
  }

  async executeTool(agentId, { callId, name, arguments: args }, signal) {
    const agent = this.agent(agentId);
    const result = await this.root.tools.execute({ callId, name, arguments: args ?? {}, agent, signal });
    return { isError: Boolean(result.isError), text: blocksToText(result.content), error: result.error?.message ?? null };
  }

  async executeCommand(agentId, line, signal) {
    const agent = this.agent(agentId);
    const run = await this.root.commands.execute(agent, line, [], signal);
    if (!run) return { found: false };
    return { found: true, kind: run.result.kind, text: run.result.text ?? "" };
  }

  async dispose() {
    for (const id of [...this.agents.keys()]) this.closeAgent(id);
    await this.root?.registry?.dispose?.();
  }
}

/** Tool result content blocks as text for the model of Harness. */
export function blocksToText(blocks) {
  const parts = [];
  for (const block of blocks ?? []) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push("[An image result. Harness does not send plugin images to the model yet.]");
    else if (block.type === "file") parts.push(`[A file result: ${block.attachment?.name ?? "file"}]`);
    else parts.push(JSON.stringify(block));
  }
  return parts.join("\n");
}
