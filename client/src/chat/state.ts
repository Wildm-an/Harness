// Chat state. The reducer turns daemon events into items for the message list.

import type { Decision, DaemonMessage, HistoryMessage, StopReason, Usage } from "../daemon/protocol";

export type ToolStatus = "running" | "done" | "error";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
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
      rule: string;
      decision?: Decision;
      expired?: boolean; // The turn ended before a decision.
    }
  | { kind: "notice"; id: string; level: "error" | "warning" | "info"; text: string }
  | { kind: "summary"; id: string; text: string | null; removed: number; trimmed: number; reason: string };

export interface ContextUse {
  tokens: number;
  length: number;
}

export interface ChatState {
  items: ChatItem[];
  running: boolean;
  usage: Usage | null;
  context: ContextUse | null;
}

export const emptyChat: ChatState = { items: [], running: false, usage: null, context: null };

export type ChatAction =
  | { type: "daemon"; msg: DaemonMessage }
  | { type: "user"; text: string; startsTurn: boolean }
  | { type: "disconnected" }
  | { type: "decide"; requestId: string; decision: Decision }
  | { type: "notice"; level: "error" | "warning" | "info"; text: string }
  | {
      type: "load";
      history: HistoryMessage[];
      warnings: string[];
      summary: string | null;
      context: ContextUse | null;
    }
  | { type: "clear" };

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

const STOP_NOTICES: Partial<Record<StopReason, string>> = {
  interrupted: "The turn was interrupted.",
  denied: "The tool call was denied. The agent waits for your instructions.",
  max_tool_calls: "The turn stopped at the tool call limit.",
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
  return items.map((i) => (i.kind === "permission" && !i.decision && !i.expired ? { ...i, expired: true } : i));
}

function updateItem(items: ChatItem[], id: string, kind: ChatItem["kind"], patch: Partial<ChatItem>): ChatItem[] {
  return items.map((item) => (item.id === id && item.kind === kind ? ({ ...item, ...patch } as ChatItem) : item));
}

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;
export type PermissionItem = Extract<ChatItem, { kind: "permission" }>;

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
      items.push({ kind: "user", id: nextId("user"), text: msg.display ?? msg.content });
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
    case "permission.request":
      return {
        ...state,
        items: [
          ...endStreaming(state.items),
          { kind: "permission", id: msg.request_id, tool: msg.tool, input: msg.input, diff: msg.diff, rule: msg.rule },
        ],
      };
    case "turn.end": {
      const items = expirePermissions(endStreaming(state.items));
      const text = STOP_NOTICES[msg.stop_reason];
      return {
        ...state,
        running: false,
        usage: msg.usage,
        context: { tokens: msg.usage.context_tokens, length: msg.usage.context_length },
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
        context: { tokens: msg.context_tokens, length: msg.context_length },
      };
    }
    case "error":
      return { ...state, items: [...endStreaming(state.items), { kind: "notice", id: nextId("notice"), level: "error", text: msg.message }] };
    case "command.result": {
      const notices: ChatItem[] = [];
      if (msg.text) notices.push({ kind: "notice", id: nextId("notice"), level: "info", text: msg.text });
      for (const w of msg.warnings ?? []) notices.push({ kind: "notice", id: nextId("notice"), level: "warning", text: w });
      if (msg.action === "open_panel" && msg.panel === "cookbook") {
        notices.push({ kind: "notice", id: nextId("notice"), level: "info", text: `The ${msg.panel} panel is not in this build yet.` });
      }
      const items = msg.name === "clear" ? notices : [...state.items, ...notices];
      const context =
        msg.name === "clear" && state.context ? { ...state.context, tokens: 0 }
        : msg.context_length && state.context ? { ...state.context, length: msg.context_length }
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
        items: [...state.items, { kind: "user", id: nextId("user"), text: action.text }],
      };
    case "disconnected":
      return {
        ...state,
        running: false,
        items: [
          ...expirePermissions(endStreaming(state.items)),
          { kind: "notice", id: nextId("notice"), level: "error", text: "The connection to the daemon closed." },
        ],
      };
    case "decide":
      return { ...state, items: updateItem(state.items, action.requestId, "permission", { decision: action.decision }) };
    case "notice":
      return { ...state, items: [...state.items, { kind: "notice", id: nextId("notice"), level: action.level, text: action.text }] };
    case "load": {
      const warnings: ChatItem[] = action.warnings.map((text) => ({ kind: "notice", id: nextId("notice"), level: "warning", text }));
      const summary: ChatItem[] = action.summary
        ? [{ kind: "summary", id: nextId("summary"), text: action.summary, removed: 0, trimmed: 0, reason: "earlier" }]
        : [];
      return {
        running: false,
        usage: null,
        context: action.context,
        items: [...summary, ...historyToItems(action.history), ...warnings],
      };
    }
    case "clear":
      return emptyChat;
  }
}
