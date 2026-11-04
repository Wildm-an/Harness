// Chat state. The reducer turns daemon events into items for the message list.

import type { AskQuestion, Decision, DaemonMessage, HistoryMessage, PermissionMode, PermissionRequest, PlanDecision, StopReason, Usage } from "../daemon/protocol";

export type ToolStatus = "running" | "done" | "error";

export type ChatItem =
  // messageId: the daemon id, for rewind and fork. ts: epoch ms. origin "task": the notes of background tasks.
  | { kind: "user"; id: string; text: string; messageId?: string; ts?: number; origin?: "task"; images?: string[] }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      output?: string;
      status: ToolStatus;
      diff?: string; // The change that the tool made to a file.
      image?: string; // A data URL, for example a screenshot of preview_screenshot.
      agent?: string; // The forked skill that runs this tool in a subagent.
    }
  | {
      kind: "permission";
      id: string;
      tool: string;
      input: unknown;
      diff: string | null;
      rule: string | null;
      reason?: string | null;
      decision?: Decision;
      expired?: boolean; // The turn ended before a decision.
      background?: boolean; // A background subagent asks: the end of the turn does not expire the card.
      agent?: string;
    }
  // ask_user_question (daemon tools/interact.py). answers: null when the user skipped.
  | { kind: "question"; id: string; questions: AskQuestion[]; answers?: Record<string, string> | null; expired?: boolean }
  // exit_plan_mode: the plan of the agent in plan mode.
  | { kind: "plan"; id: string; plan: string; decision?: PlanDecision; mode?: PermissionMode; expired?: boolean }
  | { kind: "notice"; id: string; level: "error" | "warning" | "info"; text: string }
  | { kind: "summary"; id: string; text: string | null; removed: number; trimmed: number; reason: string };

export interface ContextUse {
  tokens: number;
  length: number;
  source?: string; // Where the daemon found the context length.
}

/** The running turn: its start time (epoch ms) and the output tokens that the endpoint counted. */
export interface TurnInfo {
  startedAt: number;
  tokens: number;
}

export interface ChatState {
  items: ChatItem[];
  running: boolean;
  usage: Usage | null;
  context: ContextUse | null;
  turn: TurnInfo | null;
}

export const emptyChat: ChatState = { items: [], running: false, usage: null, context: null, turn: null };

export type ChatAction =
  | { type: "daemon"; msg: DaemonMessage }
  | { type: "user"; text: string; startsTurn: boolean; messageId?: string; images?: string[] }
  | { type: "disconnected" }
  | { type: "decide"; requestId: string; decision: Decision }
  | { type: "answer"; requestId: string; answers: Record<string, string> | null }
  | { type: "plan"; requestId: string; decision: PlanDecision; mode?: PermissionMode }
  | { type: "notice"; level: "error" | "warning" | "info"; text: string }
  | {
      type: "load";
      history: HistoryMessage[];
      warnings: string[];
      summary: string | null;
      context: ContextUse | null;
      // A return to a session with a running turn.
      running?: boolean;
      partial?: string | null; // The reply text that streams now.
      requests?: PermissionRequest[]; // The permission requests that wait for a decision.
      turnStartedAt?: number | null; // Epoch seconds.
      turnTokens?: number;
    }
  | { type: "clear" };

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

const STOP_NOTICES: Partial<Record<StopReason, string>> = {
  interrupted: "The turn was interrupted.",
  denied: "The tool call was denied. The agent waits for your instructions.",
  max_tool_calls: "The turn stopped at the tool call limit.",
  blocked: "A plugin or a hook ended the turn.",
};

function endStreaming(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "assistant" && last.streaming) {
    return [...items.slice(0, -1), { ...last, streaming: false }];
  }
  return items;
}

/** Marks the permission cards with no decision as expired. */
function expirePermissions(items: ChatItem[]): ChatItem[] {
  return items.map((i) => {
    if (i.kind === "permission" && !i.decision && !i.expired && !i.background) return { ...i, expired: true };
    if (i.kind === "question" && i.answers === undefined && !i.expired) return { ...i, expired: true };
    if (i.kind === "plan" && !i.decision && !i.expired) return { ...i, expired: true };
    return i;
  });
}

/** The card of a request: a permission card, a question card, or a plan card. */
export function requestCard(r: PermissionRequest): ChatItem {
  if (r.kind === "question") return { kind: "question", id: r.request_id, questions: r.questions ?? [] };
  if (r.kind === "plan") return { kind: "plan", id: r.request_id, plan: r.plan ?? "" };
  return {
    kind: "permission",
    id: r.request_id,
    tool: r.tool,
    input: r.input,
    diff: r.diff,
    rule: r.rule,
    reason: r.reason ?? (r.background && r.agent ? `The background agent "${r.agent}" asks.` : r.reason),
    background: r.background,
    agent: r.agent,
  };
}

function updateItem(items: ChatItem[], id: string, kind: ChatItem["kind"], patch: Partial<ChatItem>): ChatItem[] {
  return items.map((item) => (item.id === id && item.kind === kind ? ({ ...item, ...patch } as ChatItem) : item));
}

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;
export type PermissionItem = Extract<ChatItem, { kind: "permission" }>;
export type QuestionItem = Extract<ChatItem, { kind: "question" }>;
export type PlanItem = Extract<ChatItem, { kind: "plan" }>;

/** The index of the newest running tool card for a call id, or -1. */
function lastRunningTool(items: ChatItem[], callId: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "tool" && item.id === callId && item.status === "running") return i;
  }
  return -1;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Converts stored OpenAI-format messages to chat items. */
export function historyToItems(history: HistoryMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const msg of history) {
    if (msg.role === "user") {
      items.push({ kind: "user", id: nextId("user"), text: msg.display ?? msg.content, messageId: msg.id, ts: msg.ts ? msg.ts * 1000 : undefined, origin: msg.origin, images: msg.images });
    } else if (msg.role === "assistant") {
      if (msg.content) items.push({ kind: "assistant", id: nextId("assistant"), text: msg.content, streaming: false });
      for (const call of msg.tool_calls ?? []) {
        items.push({
          kind: "tool",
          id: call.id,
          name: call.function.name,
          input: parseArgs(call.function.arguments),
          status: "running",
        });
      }
    } else if (msg.role === "tool") {
      const index = lastRunningTool(items, msg.tool_call_id);
      if (index >= 0) {
        const status: ToolStatus = msg.is_error ? "error" : "done";
        items[index] = { ...(items[index] as ToolItem), output: msg.content, status, diff: msg.diff, image: msg.image };
      }
    }
  }
  return items;
}

function onDaemon(state: ChatState, msg: DaemonMessage): ChatState {
  switch (msg.type) {
    case "token": {
      const last = state.items[state.items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        return { ...state, items: [...state.items.slice(0, -1), { ...last, text: last.text + msg.text }] };
      }
      const item: ChatItem = { kind: "assistant", id: nextId("assistant"), text: msg.text, streaming: true };
      return { ...state, items: [...state.items, item] };
    }
    case "tool.start":
      // After a return to a running turn, the history already shows the tool call as running.
      if (lastRunningTool(state.items, msg.id) >= 0) return state;
      return {
        ...state,
        items: [
          ...endStreaming(state.items),
          { kind: "tool", id: msg.id, name: msg.name, input: msg.input, status: "running", agent: msg.agent },
        ],
      };
    case "tool.result": {
      const index = lastRunningTool(state.items, msg.id);
      if (index < 0) return state;
      const items = [...state.items];
      items[index] = {
        ...(items[index] as ToolItem),
        output: msg.output,
        status: msg.is_error ? "error" : "done",
        diff: msg.diff,
        image: msg.image,
      };
      return { ...state, items };
    }
    case "permission.request": {
      const card = requestCard(msg);
      const last = state.items[state.items.length - 1];
      // A background agent asks while the main agent writes: the card goes before the reply, so the reply stays one message.
      if (msg.background && last?.kind === "assistant" && last.streaming) {
        return { ...state, items: [...state.items.slice(0, -1), card, last] };
      }
      return { ...state, items: [...endStreaming(state.items), card] };
    }
    case "turn.started":
      // The notes of background tasks started a turn. The client sent no prompt.
      return {
        ...state,
        running: true,
        turn: state.turn ?? { startedAt: Date.now(), tokens: 0 },
        items: [...endStreaming(state.items), { kind: "user", id: nextId("user"), text: msg.text, messageId: msg.id, ts: Date.now(), origin: msg.origin }],
      };
    case "turn.usage":
      return state.turn ? { ...state, turn: { ...state.turn, tokens: msg.completion_tokens } } : state;
    case "turn.end": {
      const items = expirePermissions(endStreaming(state.items));
      const text = STOP_NOTICES[msg.stop_reason];
      return {
        ...state,
        running: false,
        turn: null,
        usage: msg.usage,
        context: { ...state.context, tokens: msg.usage.context_tokens, length: msg.usage.context_length },
        items: text ? [...items, { kind: "notice", id: nextId("notice"), level: "info", text }] : items,
      };
    }
    case "context.compacted": {
      const item: ChatItem = {
        kind: "summary",
        id: nextId("summary"),
        text: msg.summary,
        removed: msg.removed_messages,
        trimmed: msg.trimmed_outputs,
        reason: msg.reason,
      };
      return {
        ...state,
        items: [...endStreaming(state.items), item],
        context: { ...state.context, tokens: msg.context_tokens, length: msg.context_length },
      };
    }
    case "steer.taken":
      return { ...state, items: [...endStreaming(state.items), { kind: "user", id: nextId("user"), text: msg.text, messageId: msg.id, ts: Date.now(), origin: msg.origin }] };
    case "error":
      return { ...state, items: [...endStreaming(state.items), { kind: "notice", id: nextId("notice"), level: "error", text: msg.message }] };
    case "notice":
      return { ...state, items: [...endStreaming(state.items), { kind: "notice", id: nextId("notice"), level: msg.level, text: msg.text }] };
    case "command.result": {
      const notices: ChatItem[] = [];
      if (msg.text) notices.push({ kind: "notice", id: nextId("notice"), level: "info", text: msg.text });
      for (const w of msg.warnings ?? []) notices.push({ kind: "notice", id: nextId("notice"), level: "warning", text: w });
      const items = msg.name === "clear" ? notices : [...state.items, ...notices];
      const context =
        msg.name === "clear" && state.context ? { ...state.context, tokens: 0 }
        : msg.context_length && state.context ? { ...state.context, length: msg.context_length, source: msg.context_source }
        : state.context;
      return { ...state, items, context };
    }
    default:
      return state;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "daemon":
      return onDaemon(state, action.msg);
    case "user":
      return {
        ...state,
        running: state.running || action.startsTurn,
        turn: state.turn ?? (action.startsTurn ? { startedAt: Date.now(), tokens: 0 } : null),
        items: [...state.items, { kind: "user", id: nextId("user"), text: action.text, messageId: action.messageId, ts: Date.now(), images: action.images }],
      };
    case "disconnected":
      return {
        ...state,
        running: false,
        turn: null,
        items: [
          ...expirePermissions(endStreaming(state.items)),
          { kind: "notice", id: nextId("notice"), level: "error", text: "The connection to the daemon closed." },
        ],
      };
    case "decide":
      return { ...state, items: updateItem(state.items, action.requestId, "permission", { decision: action.decision }) };
    case "answer":
      return { ...state, items: updateItem(state.items, action.requestId, "question", { answers: action.answers }) };
    case "plan":
      return { ...state, items: updateItem(state.items, action.requestId, "plan", { decision: action.decision, mode: action.mode }) };
    case "notice":
      return { ...state, items: [...state.items, { kind: "notice", id: nextId("notice"), level: action.level, text: action.text }] };
    case "load": {
      const warnings: ChatItem[] = action.warnings.map((text) => ({ kind: "notice", id: nextId("notice"), level: "warning", text }));
      const summary: ChatItem[] = action.summary
        ? [{ kind: "summary", id: nextId("summary"), text: action.summary, removed: 0, trimmed: 0, reason: "earlier" }]
        : [];
      const live: ChatItem[] = [];
      if (action.running && action.partial) {
        live.push({ kind: "assistant", id: nextId("assistant"), text: action.partial, streaming: true });
      }
      for (const r of action.requests ?? []) { // A background subagent can ask when no turn runs.
        live.push(requestCard(r));
      }
      return {
        running: action.running ?? false,
        turn: action.running
          ? { startedAt: action.turnStartedAt ? action.turnStartedAt * 1000 : Date.now(), tokens: action.turnTokens ?? 0 }
          : null,
        usage: null,
        context: action.context,
        items: [...summary, ...historyToItems(action.history), ...warnings, ...live],
      };
    }
    case "clear":
      return emptyChat;
  }
}
