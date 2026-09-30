// The Cordis runtime of the plugin host: the real DeepSeek core services, the profile rows, and
// one shim agent for each Harness session.

import { pathToFileURL } from "node:url";
import { Context, Logger, Service } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createScope, scopeTarget } from "@deepseek-ai/dsh-scope";
import { renderPrompt } from "@deepseek-ai/dsh-system-prompt";

/** The real DeepSeek services that the host loads before the plugins (phase 0, tests 1 and 2). */
export const CORE_SERVICES = [
  ["system-prompt", "@deepseek-ai/dsh-system-prompt"],
  ["tools", "@deepseek-ai/dsh-tools"],
  ["commands", "@deepseek-ai/dsh-commands"],
  ["skills", "@deepseek-ai/dsh-skill"],
  ["llm", "@deepseek-ai/dsh-llm"],
  ["agents", "@deepseek-ai/dsh-agent"], // The live agents: one for each Harness session.
];

/**
 * The agent and tool events that the daemon sends (phase 2). The daemon sends an event only when a
 * plugin listens to it (decision D5), so the snapshot reports the events with listeners.
 */
export const EVENTS = [
  "agent/created", "agent/disposed", "agent/status", "agent/inbox/inserted", "agent/inbox/claimed",
  "agent/pre-step", "agent/request", "agent/request-error", "agent/assistant-stream", "agent/turn-stopping",
  "agent/error", "tools/pre-execute", "tools/post-execute", "tools/result", "approval/request",
];
const EMITTED = new Set(["agent/status", "agent/inbox/inserted", "agent/inbox/claimed", "agent/error", "agent/assistant-stream", "tools/result"]);
const OUTCOMES = new Set(["allowed-once", "rejected", "cancelled", "unavailable"]);
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
  constructor(profile, notify, request) {
    this.profile = profile;
    this.notify = notify;
    this.request = request; // Sends a request to the daemon: (method, params, signal) => Promise.
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
    await root.plugin(approvalService(this));
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

  /**
   * Open the shim agent of a session. The real `agents` service registers it and sends
   * `agent/created` to the listeners of the agent scope.
   * @returns a warning, if a creation listener failed.
   */
  async openAgent(id, cwd, source = "startup") {
    this.closeAgent(id);
    const events = [];
    const record = { steered: null };
    const agent = {
      id,
      cwd,
      session: {
        id,
        events,
        get seq() {
          return events.length;
        },
        append: (type, data) => (events.push({ type, data }), events.length),
        eventAt: (seq) => events[seq],
      },
      // A plugin adds a user message to the turn. In agent/turn-stopping, the daemon gets it with
      // the dispatch result. At other times, the daemon queues it for the next step.
      steer: (text) => this._steer(record, typeof text === "string" ? text : messageText(text)),
      inject: (message) => this._steer(record, messageText(message)),
    };
    const scope = createScope(this.root, agent);
    agent.ctx = scope.ctx;
    Object.assign(record, { agent, scope, cwd, events, detach: this.root.agents.enter(agent, undefined) });
    this.agents.set(id, record);
    try {
      await this.root.agents.announce(agent, source);
    } catch (error) {
      return { id, warning: `A DeepSeek plugin failed in agent/created: ${error?.message ?? error}` };
    }
    return { id };
  }

  closeAgent(id) {
    const record = this.agents.get(id);
    if (!record) return;
    this.agents.delete(id);
    try {
      record.detach?.(); // agent/disposed
    } finally {
      record.scope.dispose();
    }
  }

  _steer(record, text) {
    if (!text) return;
    if (record.steered) record.steered.push(text);
    else this.notify("agent.steer", { agentId: record.agent.id, text });
  }

  /** The events of EVENTS that have one or more listeners. */
  listeners() {
    const hooks = this.root.events?._hooks ?? {};
    return EVENTS.filter((name) => (hooks[name]?.length ?? 0) > 0);
  }

  /** Ask the daemon: the Harness permission card. */
  async askDaemon(req) {
    const result = await this.request("approval.request", {
      agentId: req.agent?.id ?? null,
      toolName: req.toolName,
      callId: req.callId ?? null,
      reason: req.reason ?? req.displayReason?.en ?? null,
    }, req.signal);
    return result?.outcome;
  }

  /**
   * Run one waterfall or serial event for a session, and return the result in a JSON form.
   * The payloads use the DeepSeek types; the daemon sends and gets plain texts.
   */
  async dispatch(agentId, name, payload, signal) {
    const record = this.agents.get(agentId);
    if (!record) throw new Error(`Unknown agent: ${agentId}`);
    const agent = record.agent;
    const target = scopeTarget(this.root, agent);
    const turn = payload.turn ?? 0;
    const step = payload.step ?? 0;
    switch (name) {
      case "agent/pre-step": {
        const messages = (payload.messages ?? []).map(userMessage);
        const decision = await this.root.waterfall(target, name, { agent, messages, turn, step, signal },
          () => Promise.resolve({ kind: "enter", messages }));
        if (decision?.kind === "reject") return { kind: "reject" };
        return { kind: "enter", messages: (decision?.messages ?? messages).map(messageText) };
      }
      case "agent/request": {
        const config = await this.root.waterfall(target, name, { agent, turn, step, signal },
          () => Promise.resolve({ ...payload.config }));
        return { config: plain(config ?? payload.config) };
      }
      case "agent/request-error": {
        const action = await this.root.waterfall(target, name, {
          agent, turn, step, provider: payload.provider ?? "", failure: { message: payload.message ?? "", code: payload.code ?? "TRANSPORT" },
          retryPolicy: undefined, signal,
        }, () => Promise.resolve(undefined));
        return { retry: action?.kind === "retry" };
      }
      case "agent/turn-stopping": {
        record.steered = [];
        try {
          await this.root.serial(target, name, { agent, turn, signal });
          return { steered: record.steered };
        } finally {
          record.steered = null;
        }
      }
      case "tools/pre-execute": {
        const exec = toolExecution(agent, payload, signal);
        const decision = await this.root.waterfall(target, name, exec, () => Promise.resolve({ kind: "allow" }));
        return { decision: plain(decision ?? { kind: "allow" }) };
      }
      case "tools/post-execute": {
        const exec = toolExecution(agent, payload, signal);
        const result = toolResult(payload.result);
        const decision = await this.root.waterfall(target, name, exec, result, () => Promise.resolve({ kind: "accept" }));
        const d = decision ?? { kind: "accept" };
        const text = d.kind === "block" ? blocksToText(d.feedback) : d.content !== undefined ? blocksToText(d.content) : d.value !== undefined ? JSON.stringify(d.value) : null;
        return { decision: { kind: d.kind === "block" ? "block" : "accept", text, contexts: (d.additionalContexts ?? []).map(messageText) } };
      }
      default:
        throw new Error(`Not a dispatch event: ${name}`);
    }
  }

  /** Send one emit event for a session. A listener error is logged. It does not stop the others. */
  emit(agentId, name, payload) {
    const record = this.agents.get(agentId);
    if (!record || !EMITTED.has(name)) return;
    const agent = record.agent;
    let args;
    if (name === "tools/result") {
      args = [scopeTarget(this.root, agent), name, toolExecution(agent, payload, undefined), toolResult(payload.result)];
    } else if (name === "agent/assistant-stream") {
      args = [scopeTarget(this.root, agent), name, { agent, frame: payload.frame }];
    } else if (name.startsWith("agent/inbox/")) {
      args = [scopeTarget(this.root, agent), name, { agent, message: userMessage(payload.text ?? ""), turn: payload.turn }];
    } else {
      args = [scopeTarget(this.root, agent), name, { agent, ...payload }];
    }
    for (const callback of this.root.events.dispatch("emit", args)) {
      try {
        Promise.resolve(callback(...args)).catch((error) => this._listenerFailed(name, error));
      } catch (error) {
        this._listenerFailed(name, error);
      }
    }
  }

  _listenerFailed(name, error) {
    this.notify("log", { level: "warn", name: "events", text: `A ${name} listener failed: ${error?.message ?? error}` });
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
    const listeners = this.listeners();
    const own = { ...assembly, sections: assembly.sections.filter((s) => !this.baseSections.has(s.name)) };
    let prompt = "";
    try {
      prompt = renderPrompt(own);
    } catch (error) {
      this.notify("log", { level: "warn", name: "system-prompt", text: `A plugin prompt section did not render: ${error.message}` });
    }
    return { tools, commands, skills, prompt, listeners };
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

/** A plain JSON copy of a decision or a config: no functions, no frozen proxies. */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function userMessage(text) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

/** The text of a DeepSeek message, or a text as it is. */
export function messageText(message) {
  if (typeof message === "string") return message;
  return (message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/** A ToolExecution for a Harness tool call, for the tools/* events. */
function toolExecution(agent, payload, signal) {
  const callId = payload.callId ?? "call";
  return {
    callId, rootCallId: callId, name: payload.name, arguments: payload.arguments ?? {}, agent,
    signal: signal ?? new AbortController().signal, token: {}, deferContext() {}, concludeTurn() {},
  };
}

/** A ToolExecutionResult from a Harness tool result text. */
function toolResult(result) {
  const text = String(result?.text ?? "");
  const content = [{ type: "text", text }];
  return result?.isError ? { isError: true, error: { message: text }, content } : { isError: false, value: text, content };
}

/**
 * The `approval` service: `tools/pre-execute` "ask" decisions come here. Plugins answer first
 * through the `approval/request` waterfall. With no answer, the daemon shows its permission card.
 */
function approvalService(runtime) {
  return class HarnessApproval extends Service {
    constructor(ctx) {
      super(ctx, "approval");
    }

    async request(req) {
      if (req?.signal?.aborted) return "cancelled";
      try {
        const target = req.agent ? scopeTarget(runtime.root, req.agent) : runtime.root;
        const outcome = await runtime.root.waterfall(target, "approval/request", req, () => runtime.askDaemon(req));
        return OUTCOMES.has(outcome) ? outcome : "unavailable";
      } catch {
        return req?.signal?.aborted ? "cancelled" : "unavailable";
      }
    }
  };
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
