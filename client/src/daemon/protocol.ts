// Message types of the client–daemon protocol. See docs/PROTOCOL.md.

export type Decision = "allow_once" | "allow_always" | "deny";

export type StopReason = "end" | "max_tool_calls" | "denied" | "interrupted" | "error";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  last_prompt_tokens: number;
  context_tokens: number; // The size of the next request (estimate).
  context_length: number;
}

// Messages in the OpenAI chat format, as the daemon stores them.
export interface HistoryToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type HistoryMessage =
  | { role: "user"; content: string; display?: string } // display: the text that the user typed, for example "/review src".
  | { role: "assistant"; content: string | null; tool_calls?: HistoryToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string; is_error?: boolean; diff?: string };

/** A / menu item: a built-in command or a skill. */
export interface CommandItem {
  name: string;
  description: string;
  "argument-hint": string;
  source: string;
  builtin: boolean;
  path?: string;
  "user-invocable"?: boolean;
  "model-invocable"?: boolean;
  context?: string | null;
}

export interface SkillDetail extends CommandItem {
  "allowed-tools": string[];
  content: string;
  files: string[];
}

/** The computer that the daemon runs on. */
export interface HostInfo {
  hostname: string;
  platform: string;
  user: string;
  home: string;
  sep: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  items: { name: string; path: string }[];
  roots: string[];
  is_project: boolean;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "session.new"; cwd: string; model: string; provider?: string }
  | { type: "session.resume"; session_id: string }
  | { type: "session.list"; cwd?: string }
  | { type: "prompt"; text: string }
  | { type: "command"; name: string; args: string }
  | { type: "permission.reply"; request_id: string; decision: Decision }
  | { type: "interrupt" }
  | { type: "skills.list" }
  | { type: "skills.get"; name: string }
  | { type: "fs.dirs"; path?: string; hidden?: boolean }
  | { type: "permissions.get" }
  | { type: "permissions.set"; allow: string[]; deny: string[] };

export type DaemonMessage =
  | { type: "auth.ok"; version: string; host: HostInfo }
  | ({ type: "fs.dirs" } & DirListing)
  | {
      type: "session.ready";
      session_id: string;
      cwd: string;
      model: string;
      title: string | null;
      warnings: string[];
      history: HistoryMessage[];
      summary: string | null; // Replaces the messages before the history.
      context_length: number;
      context_tokens: number;
      instructions: string | null; // HARNESS.md or CLAUDE.md, if the project has one.
    }
  | {
      type: "context.compacted";
      reason: "auto" | "manual";
      removed_messages: number;
      trimmed_outputs: number;
      summary: string | null;
      context_tokens: number;
      context_length: number;
    }
  | { type: "sessions"; items: SessionSummary[] }
  | { type: "token"; text: string }
  // agent: the skill name when a forked skill runs the tool in a subagent.
  | { type: "tool.start"; id: string; name: string; input: unknown; agent?: string }
  | { type: "tool.result"; id: string; output: string; is_error: boolean; diff?: string; agent?: string }
  | {
      type: "permission.request";
      request_id: string;
      tool: string;
      input: unknown;
      diff: string | null;
      rule: string; // The rule that "allow_always" adds.
    }
  | { type: "permissions"; path: string; allow: string[]; deny: string[] }
  | { type: "turn.end"; usage: Usage; stop_reason: StopReason }
  | { type: "fs.changed"; path: string; hash: string | null; by: "agent" | "external" }
  | {
      type: "command.result";
      name: string;
      text?: string;
      model?: string;
      warnings?: string[];
      context_length?: number;
      items?: CommandItem[];
      action?: string;
      panel?: string;
    }
  | { type: "skills"; items: CommandItem[] }
  | ({ type: "skill" } & SkillDetail)
  | { type: "error"; message: string; ref?: string };
