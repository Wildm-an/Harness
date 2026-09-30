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
  // image: a data URL, for example a screenshot of preview_screenshot.
  | { role: "tool"; tool_call_id: string; content: string; is_error?: boolean; diff?: string; image?: string };

/** A small screenshot of the agent browser page after an agent action (SPEC.md section 8.7). */
export interface AgentFrame {
  url: string;
  title: string;
  action: string; // For example "navigate" or "click e5".
  image: string; // A JPEG data URL.
}

/** A model endpoint of ~/.harness/providers.json on the daemon computer (the Providers screen). */
export type ProviderKind = "auto" | "ollama" | "openai";

export interface ProviderItem {
  name: string;
  base_url: string;
  kind: ProviderKind;
  kind_resolved: "ollama" | "openai";
  enabled: boolean;
  context_length: number | null;
  ssh: string | null;
  models: string[]; // The models with settings in providers.json.
  // Where the API key comes from. "client": the keychain of this app. "file": plain text in providers.json.
  key: { source: "client" | "env" | "file" | "none"; set: boolean; env?: string };
}

/** "keep" leaves the key setting as it is. "client" means that the client sends the key with providers.keys. */
export type KeyMode = "keep" | "client" | "env" | "none";

export interface ProviderFields {
  name: string;
  base_url: string;
  kind: ProviderKind;
  context_length?: number | null;
  ssh?: string | null;
  previous_name?: string; // The saved name of the provider that the form changes.
}

export interface ProviderTestResult {
  ref: string;
  name: string;
  ok: boolean;
  ms: number;
  models?: string[];
  truncated?: boolean;
  contexts?: Record<string, ModelContext>; // The models with a known context length.
  error?: string;
}

/** The context length of a model, and where the daemon found it (for example "llama-server"). */
export interface ModelContext {
  length: number;
  source: string;
  warning?: string;
}

/** Project settings that the client can change. */
import type { ContextUsage } from "../lib/context";

/** The permission mode of a project, as in Claude Code. See daemon/harness_daemon/permissions.py. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ClientSettings {
  auto_verify: boolean;
  permission_mode: PermissionMode;
}

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

export type ServerState = "stopped" | "starting" | "running" | "crashed";

export interface ServerConfigJson {
  name: string;
  command: string;
  cwd?: string;
  port?: number;
  ready_pattern?: string;
  health_url?: string;
  env?: Record<string, string>;
  default?: boolean;
}

export interface ServerItem {
  name: string;
  state: ServerState;
  port: number | null;
  url: string | null;
  error?: string;
  command: string;
  cwd: string;
  default: boolean;
  ready_pattern?: string | null;
  health_url?: string | null;
  last_lines?: { stream: "stdout" | "stderr"; text: string }[];
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

/** A saved project: a folder on the daemon computer. The agent keeps its files in this folder. */
export interface ProjectItem {
  id: string;
  name: string;
  path: string;
  exists: boolean; // The folder exists now.
  sessions: number;
  created_at: number;
  last_used: number;
}

// -- MCP servers (SPEC.md section 5.7) --

export type McpState = "starting" | "connected" | "failed" | "disabled" | "stopped";

export interface McpServerItem {
  name: string;
  scope: "plugin" | "user" | "project";
  transport: "stdio" | "http" | "sse";
  target: string; // The command, or the URL.
  state: McpState;
  error: string | null;
  server_name: string | null;
  tools: { name: string; agent_name: string; description: string }[];
  log?: string[]; // The last lines of the server output, for a failed server.
}

export interface McpStatus {
  items: McpServerItem[];
  problems: string[];
  paths: { user: string; project: string };
}

// -- plugins (docs/PLUGINS.md) --

/** A plugin row: one plugin module with its config. "idle": no session, so no plugin code ran. */
export interface PluginRow {
  id: string;
  name: string; // <bundle> or <bundle>/<module>
  bundle: string;
  state: "pending" | "active" | "disabled" | "failed" | "idle";
  error: string | null;
  disabled: boolean;
  config: unknown;
  layer: string; // The layer that added the row: "bundle:<name>", "user", or "project".
  overrides: string[]; // The layers that changed the row.
  inject: string[];
  provide: string[];
  tools: string[];
  commands: string[];
}

export interface PluginBundle {
  name: string;
  dir: string;
  enabled: boolean;
  source: string | null; // The folder or the git URL of the install.
  problem: string | null; // Why the bundle cannot load.
  version?: string;
  description?: string;
  icon?: string | null; // A data URL.
  rows: PluginRow[];
}

export interface PluginsStatus {
  loaded: boolean; // True: the plugins of the session are loaded.
  bundles: PluginBundle[];
  orphans: PluginRow[]; // Rows of bundles that are not installed.
  warnings: string[];
  paths: { plugins: string; user_patch: string; project_patch: string | null };
  counts: Record<string, number>;
  installed?: string;
  installed_kind?: PluginKind;
  removed?: string;
  deepseek?: DshStatus;
}

/** "harness": a Python plugin. "deepseek": a DeepSeek Harness plugin in the Node plugin host. */
export type PluginKind = "harness" | "deepseek";

/** A row of a DeepSeek bundle. "pending": the plugin waits for services that Harness does not have. */
export interface DshRow {
  id: string;
  name: string;
  disabled: boolean;
  state: "active" | "disabled" | "pending" | "failed" | "disposed";
  error: string | null;
}

export interface DshBundle {
  name: string;
  version?: string | null;
  description?: string;
  dir: string;
  enabled: boolean;
  problem: string | null;
  client?: boolean; // The bundle has a UI half. Harness does not load it yet.
  icon?: string | null;
  rows: DshRow[];
}

/** The DeepSeek part of the Plugins screen. */
export interface DshStatus {
  available: boolean;
  reason?: string; // Why DeepSeek plugins cannot run on the daemon computer.
  running?: boolean;
  error?: string;
  runtime?: string; // The DeepSeek Harness version of the plugin host.
  node?: string;
  home?: string;
  user_patch?: string; // The user layer: row overrides.
  bundles: DshBundle[];
  orphans: DshRow[];
  warnings: string[];
}

// -- the Cookbook (SPEC.md section 7) --

export interface CookbookHost {
  name: string;
  ssh: string | null;
  remote: boolean;
  python: string;
  llama_server: string | null;
  label: string;
}

export interface HardwareInfo {
  hostname: string;
  platform: string;
  gpus: { name: string; vendor: string; vram_total: number; vram_used: number }[];
  ram_total: number;
  cpu_cores: number;
  python: string;
  huggingface_hub: string | null;
  llama_server: string | null;
  tmux: boolean;
  hf_cache: string;
}

export type FitResult = "fits" | "offload" | "no";

export interface HfItem {
  repo_id: string;
  author: string;
  name: string;
  params: number | null;
  license: string | null;
  downloads: number;
  likes: number;
  last_modified: string | null;
  gated: boolean;
  library: string | null;
  architecture: string | null;
  context_length: number | null;
  fit?: FitResult | null; // An estimate from the parameter count.
}

export interface FitDetail {
  result: FitResult;
  context: number;
  weights: number;
  kv_cache: number;
  total: number;
  estimate: boolean;
  max_context_vram: number;
  gpu_layers?: number;
}

export interface HfFileGroup {
  name: string; // The first file.
  label: string;
  files: string[];
  size: number;
  quant: string | null;
  format: "gguf" | "safetensors";
  parts: number;
  fit: FitDetail | null;
}

export interface HfDetail {
  repo_id: string;
  url: string;
  item: HfItem;
  card: string;
  gated: boolean;
  access: boolean;
  shape: { architecture: string; layers: number; heads: number; kv_heads: number; embedding: number; head_dim: number; context_length: number | null } | null;
  shape_error: string | null;
  files: HfFileGroup[];
  recommended: string | null;
  host: string;
  hardware: boolean;
}

export type DownloadState = "queued" | "running" | "paused" | "done" | "error" | "cancelled";

export interface DownloadItem {
  id: string;
  host: string;
  repo_id: string;
  files: string[];
  state: DownloadState;
  bytes_done: number;
  bytes_total: number;
  file: string | null;
  error: string | null;
  started: number;
}

export interface InstalledRepo {
  repo_id: string;
  files: { name: string; size: number; path: string }[];
  size: number;
}

/** The models of the Ollama server on the host. running: false if the server did not answer. */
export interface OllamaInstalled {
  url: string;
  running: boolean;
  installed: boolean; // The ollama command is on the host.
  models: { name: string; size: number; modified: string | null; parameters: string | null; quantization: string | null }[];
  error?: string;
}

/** The models in the LM Studio models folder of the host. folder: null if LM Studio has no folder there. */
export interface LmStudioInstalled {
  folder: string | null;
  models: { id: string; path: string; files: { name: string; size: number }[]; size: number }[];
}

export interface InstalledModels {
  repos: InstalledRepo[];
  cache: string;
  ollama?: OllamaInstalled; // An older daemon does not send these.
  lmstudio?: LmStudioInstalled;
}

export type ServeState = "starting" | "running" | "crashed" | "stopped";

export interface ServeItem {
  name: string;
  port: number;
  model_path: string;
  alias: string;
  context: number;
  gpu_layers: number;
  repo_id?: string;
  file?: string;
  state: ServeState;
  provider: string;
  started: number;
}

export interface HfSearchFilters {
  library: "gguf" | "safetensors";
  task: string | null;
  params: string | null;
  fit_only: boolean;
}

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "session.new"; cwd: string; model: string; provider?: string }
  | { type: "session.resume"; session_id: string }
  | { type: "session.list"; cwd?: string; limit?: number }
  | { type: "fs.find"; query: string }
  | { type: "context.get" }
  | { type: "projects.list" }
  | { type: "projects.save"; id?: string; name: string; path: string; create?: boolean }
  | { type: "projects.delete"; id: string }
  | { type: "prompt"; text: string; display?: string } // display: the text that the user sees.
  | { type: "command"; name: string; args: string }
  | { type: "permission.reply"; request_id: string; decision: Decision }
  | { type: "interrupt" }
  | { type: "skills.list" }
  | { type: "skills.get"; name: string }
  | { type: "fs.dirs"; path?: string; hidden?: boolean }
  | { type: "fs.list"; path: string }
  | { type: "fs.read"; path: string }
  | { type: "fs.write"; path: string; content: string; base_hash: string | null }
  | { type: "fs.unwatch"; path: string }
  | { type: "fs.search"; query: string; regex?: boolean; case?: boolean; glob?: string }
  | { type: "server.list" }
  | { type: "server.save"; servers: ServerConfigJson[] }
  | { type: "server.start"; name: string }
  | { type: "server.stop"; name?: string; all?: boolean }
  | { type: "server.restart"; name: string }
  | { type: "server.logs"; name: string }
  | { type: "permissions.get" }
  | { type: "permissions.set"; allow: string[]; deny: string[] }
  | { type: "providers.list" }
  | ({ type: "providers.save"; key: KeyMode; api_key_env?: string } & ProviderFields)
  | { type: "providers.delete"; name: string }
  | { type: "providers.enable"; name: string; enabled: boolean }
  | { type: "providers.keys"; keys: Record<string, string | null> }
  | ({ type: "providers.test"; ref: string; api_key?: string } & ProviderFields)
  | { type: "models.list" }
  | { type: "mcp.list" }
  | { type: "mcp.restart"; name?: string }
  | { type: "mcp.init" }
  | { type: "plugins.list" }
  | { type: "plugins.reload" }
  | { type: "plugins.install"; source: string; replace?: boolean; kind?: PluginKind; approved_builds?: string[] }
  | { type: "plugins.remove"; name: string; kind?: PluginKind }
  | { type: "plugins.set_bundle"; name: string; enabled: boolean; kind?: PluginKind }
  | { type: "plugins.set_plugin"; id: string; enabled: boolean; kind?: PluginKind }
  | { type: "cookbook.hosts" }
  | { type: "cookbook.host.save"; name: string; ssh?: string | null; python?: string | null; llama_server?: string | null; previous?: string }
  | { type: "cookbook.host.delete"; name: string }
  | { type: "cookbook.ssh_key" }
  | { type: "cookbook.hardware"; host: string; refresh?: boolean }
  | { type: "hf.token"; token: string | null }
  | { type: "hf.search"; query: string; filters: HfSearchFilters; sort: string; page: number; host: string }
  | { type: "hf.model"; repo_id: string; host: string }
  | { type: "hf.download"; repo_id: string; files: string[]; host: string }
  | { type: "downloads.list" }
  | { type: "download.pause" | "download.resume" | "download.cancel"; id: string }
  | { type: "models.installed"; host: string }
  | { type: "models.delete"; host: string; source?: "hf"; repo_id: string; files: string[] }
  | { type: "models.delete"; host: string; source: "ollama" | "lmstudio"; name: string }
  | { type: "serve.list"; host: string }
  | { type: "serve.start"; host: string; repo_id: string; file: string; context?: number; port?: number }
  | { type: "serve.stop"; host: string; name: string }
  | { type: "serve.output"; host: string; name: string }
  | { type: "settings.get" }
  | ({ type: "settings.set" } & Partial<ClientSettings>);

export type DaemonMessage =
  | { type: "auth.ok"; version: string; host: HostInfo }
  | ({ type: "fs.dirs" } & DirListing)
  | {
      type: "servers";
      items: ServerItem[];
      path: string;
      config: "exists" | "missing" | "invalid";
      error?: string;
      proposal?: ServerConfigJson[];
    }
  | {
      type: "server.status";
      name: string;
      state: ServerState;
      port: number | null;
      url: string | null;
      error?: string;
      last_lines?: { stream: "stdout" | "stderr"; text: string }[];
    }
  | { type: "server.log"; name: string; stream: "stdout" | "stderr"; text: string }
  | { type: "server.logs"; name: string; lines: { stream: "stdout" | "stderr"; text: string }[] }
  | { type: "fs.tree"; path: string; items: { name: string; path: string; type: "file" | "dir" }[] }
  | { type: "fs.content"; path: string; content: string; hash: string }
  | { type: "fs.saved"; path: string; hash: string }
  | { type: "fs.conflict"; path: string; disk_hash: string | null }
  | {
      type: "fs.results";
      query: string;
      items: { path: string; line: number; text: string }[];
      truncated: boolean;
    }
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
      context_source?: string; // Where the context length came from, for example "Ollama num_ctx".
      context_tokens: number;
      instructions: string | null; // HARNESS.md or CLAUDE.md, if the project has one.
      files_token: string | null; // Project files for the Browser pane: /files/<token>/<path>.
      project: { id: string; name: string } | null; // The saved project of the session folder.
      auto_verify: boolean; // The agent checks the app after each UI change.
      permission_mode?: PermissionMode;
      image_input: boolean; // The model accepts images: the agent has preview_screenshot.
    }
  | ({ type: "settings" } & ClientSettings)
  | { type: "providers"; items: ProviderItem[]; path: string; exists: boolean }
  | ({ type: "providers.test" } & ProviderTestResult)
  | { type: "models"; items: { provider: string; model: string }[]; errors: { provider: string; message: string }[] }
  | ({ type: "mcp" } & McpStatus)
  | { type: "mcp.init"; path: string; created: boolean }
  | ({ type: "plugins" } & PluginsStatus)
  | { type: "cookbook.hosts"; items: CookbookHost[]; public_key: string | null; key_path: string }
  | { type: "hardware"; host: string; info: HardwareInfo }
  | { type: "hf.token"; set: boolean }
  | { type: "hf.results"; items: HfItem[]; page: number; has_more: boolean; query: string; hardware: boolean }
  | ({ type: "hf.detail" } & HfDetail)
  | { type: "downloads"; items: DownloadItem[] }
  | ({ type: "download.progress" } & DownloadItem)
  | ({ type: "installed"; host: string } & InstalledModels)
  | { type: "serves"; host: string; items: ServeItem[] }
  | {
      type: "serve.status";
      host: string;
      name: string;
      state: ServeState;
      port?: number;
      context?: number;
      provider?: string;
      model?: string; // provider/alias, when the state is "running".
      error?: string;
      fit?: FitResult;
    }
  | { type: "serve.output"; host: string; name: string; text: string }
  | ({ type: "preview.frame" } & AgentFrame)
  | {
      type: "context.compacted";
      reason: "auto" | "manual";
      removed_messages: number;
      trimmed_outputs: number;
      summary: string | null;
      context_tokens: number;
      context_length: number;
    }
  | { type: "sessions"; items: SessionSummary[]; cwd?: string | null }
  | { type: "fs.found"; query: string; items: string[] } // Paths for the "@" menu. A folder ends with "/".
  | ({ type: "context.usage" } & ContextUsage) // The context breakdown, the reply to context.get.
  | { type: "projects"; items: ProjectItem[]; saved?: string } // saved: the id after projects.save.
  | { type: "token"; text: string }
  // agent: the skill name when a forked skill runs the tool in a subagent.
  | { type: "tool.start"; id: string; name: string; input: unknown; agent?: string }
  | { type: "tool.result"; id: string; output: string; is_error: boolean; diff?: string; image?: string; agent?: string }
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
      context_source?: string;
      image_input?: boolean; // After /model: the new model accepts images.
      items?: CommandItem[];
      server?: string; // /preview: the default server.
      url?: string | null;
      action?: string;
      panel?: string;
    }
  | { type: "skills"; items: CommandItem[] }
  | ({ type: "skill" } & SkillDetail)
  | { type: "error"; message: string; ref?: string; data?: { pending_builds?: string[]; source?: string } };
