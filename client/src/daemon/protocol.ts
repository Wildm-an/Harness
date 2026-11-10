// Message types of the client–daemon protocol. See docs/PROTOCOL.md.

export type Decision = "allow_once" | "allow_always" | "deny";

export type StopReason = "end" | "max_tool_calls" | "denied" | "interrupted" | "error" | "blocked"; // blocked: a plugin ended the turn.

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
  // ts: epoch seconds. display: the text that the user typed, for example "/review src".
  // origin "task": the notes of background tasks, not a message of the user.
  // origin "harness": a note of the loop guards to the model. The chat does not show it.
  | { role: "user"; content: string; display?: string; id?: string; ts?: number; origin?: "task" | "harness"; images?: string[] } // images: pasted images (data URLs).
  | { role: "assistant"; content: string | null; tool_calls?: HistoryToolCall[] }
  // image: a data URL, for example a screenshot of preview_screenshot.
  // created: the new PDF and Word files of the call. The chat shows a card with "Open" for each one.
  | { role: "tool"; tool_call_id: string; content: string; is_error?: boolean; diff?: string; image?: string; created?: string[]; ts?: number; card?: ToolCardData };

export interface PermissionRequest {
  request_id: string;
  tool: string;
  input: unknown;
  diff: string | null;
  rule: string | null; // The rule that "allow_always" adds. null: a plugin asks each time, so there is no "always".
  remember?: string | null; // An ACP harness keeps the "always" choice, not the project settings. Its name.
  reason?: string | null; // Why a plugin asks for approval.
  agent?: string; // A background subagent asks. Its card stays open after the turn ends.
  background?: boolean;
  // A request that is not a permission (daemon tools/interact.py): a question card or a plan card.
  kind?: "question" | "plan";
  questions?: AskQuestion[];
  plan?: string; // Markdown.
}

/** A file that the agent sent with send_file (daemon tools/share.py). */
export interface SentFile {
  path: string; // Relative to the project, or absolute for a file out of the project.
  name: string;
  size: number;
  project: boolean; // The file is in the project folder.
  abs: string; // The absolute path on the computer of the daemon.
}

/** The card of a tool result: files that the agent sent, or an artifact that it published. */
export type ToolCardData =
  | { type: "files"; files: SentFile[]; caption: string; display: "render" | "attach" | "auto"; status: "normal" | "proactive" }
  | { type: "artifact"; id: string; title: string; description: string; version: number; updated: number }
  // A page that the agent opened (preview_navigate). tab: its tab of the Browser pane, null for the headless browser.
  | { type: "browser"; url: string; title: string; tab: string | null; image: string | null };

/** A question of ask_user_question: 2 to 4 options. */
export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[]; // preview: a mockup or code, monospace.
  multiSelect: boolean;
}

/** The decision on a plan card. "accept" also sets the permission mode. */
export type PlanDecision = "accept" | "revise" | "reject";

/** A session with a running turn. waiting: the turn waits for a permission decision. */
export interface RunningSession {
  session_id: string;
  waiting: boolean;
}

/**
 * The changes of a folder against its base branch: the commits that the base does not have, the
 * uncommitted changes, and the new files. ``github``: the origin remote is on GitHub and gh is installed.
 */
/** The git state of a changed file (daemon prstatus.parse_status). */
export type GitFileState = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";

/** The line counts of a part of the work. */
export interface WorkPart {
  files: number;
  added: number;
  removed: number;
}

export interface GitChanges {
  repo: boolean;
  branch: string | null;
  base: string | null; // For example "origin/main". null: no remote base, only the uncommitted changes.
  added: number;
  removed: number;
  files: number;
  github: boolean;
  // The parts of the work (older daemons do not send them).
  remote?: boolean; // The repository has an "origin" remote.
  github_repo?: string | null; // "owner/name" of the GitHub "origin" remote.
  upstream?: string | null; // The remote branch, for example "origin/feature". null: the branch is not on the remote.
  behind?: number; // The commits of the remote branch that HEAD does not have.
  uncommitted?: WorkPart | null; // Not in a commit.
  unpushed?: (WorkPart & { commits: number }) | null; // Commits that the remote branch does not have. null: no remote.
  pushed?: (WorkPart & { commits: number }) | null; // On the remote branch, not in the base. null: not on the remote.
  pr?: PullRequest | null; // The pull request of the branch.
}

/** One file of the full change of a folder (git.diff): its unified diff text with the header lines. */
export interface GitDiffFile {
  path: string;
  old_path: string | null; // The old name of a renamed file.
  status: "A" | "D" | "R" | "M"; // Added, deleted, renamed, modified.
  binary: boolean;
  untracked?: boolean; // A new file that git does not know yet.
  too_large?: boolean; // The text is too large to show: patch is "".
  patch: string;
}

/** The full change of a folder for the Changes pane (git.diff). */
export interface GitDiff {
  repo: boolean;
  branch: string | null;
  base: string | null; // For example "origin/main". null: against HEAD.
  scope: GitDiffScope;
  files: GitDiffFile[];
  truncated: boolean; // More files than the daemon sends, or too much text.
}

/** "branch": the folder against the base of the branch. "uncommitted": the folder against HEAD. */
export type GitDiffScope = "branch" | "uncommitted";

/** A small picture of the headless agent browser page (SPEC.md section 8.7): live, or after an action. */
export interface AgentFrame {
  url: string;
  title: string;
  action: string; // "live" (a live frame), or the action, for example "navigate" or "click e5".
  image: string; // A JPEG data URL.
}

/** A model endpoint of ~/.harness/providers.json on the daemon computer (the Providers screen). */
export type ProviderKind = "auto" | "ollama" | "openai" | "openrouter";

export interface ProviderItem {
  name: string;
  base_url: string;
  kind: ProviderKind;
  kind_resolved: "ollama" | "openai" | "openrouter";
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
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";

/** The effort level of the model menu. The daemon sends it to the model as reasoning_effort. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** "When you ask for an unrelated task": ask each time, always do it here, or always start a new session. */
export type NewTaskPrompt = "ask" | "here" | "new_session";

export interface ClientSettings {
  auto_verify: boolean;
  permission_mode: PermissionMode;
}

/** The user settings of the daemon (~/.harness/settings.json): the General page of the Settings dialog. */
export interface UserSettings {
  permission_mode: PermissionMode;
  prompt_suggestions: boolean;
  auto_verify: boolean;
  max_tool_calls: number;
  limit_tool_calls?: boolean; // false: no tool call limit.
  bash_timeout: number; // Seconds.
  terminal_shell: string | null;
  subagents?: boolean; // false: the agent cannot start subagents (the agent tool).
  auto_memory?: boolean; // false: no memory tool and no memory in the prompt (daemon memory.py).
  memory_sensitive?: boolean; // true: the memory can have sensitive topics, for example health conditions.
  chat_search?: boolean; // false: no conversation_search tool (the search of the past sessions of the project).
  // The model by network (Settings > Providers): on, a new session uses online_model, or offline_model with no connection.
  auto_model?: boolean;
  online_model?: string | null;
  offline_model?: string | null;
  effort?: Effort | null; // The effort level of the model menu. null: the model decides.
  new_task_prompt?: NewTaskPrompt; // "When you ask for an unrelated task" (offer_session). Default "ask".
  // Settings > Operating Harness: the id of the ACP harness for new sessions. null or "harness": the built-in loop.
  operating_harness?: string | null;
  auto_archive_days?: number; // "Archive inactive sessions": 0 (never), 1, 2, 7, 14, or 30 days.
  // The agent instructions of the user. The system prompt includes them. null: no instructions.
  instructions_thinking?: string | null;
  instructions_research?: string | null;
  instructions_speaking?: string | null;
  instructions_other?: string | null;
  // The search provider of the web_search tool (daemon web.py). "off": the agent has no web_search tool.
  web_search?: WebSearchProvider;
  web_search_url?: string | null; // The SearXNG server.
}

export type WebSearchProvider = "duckduckgo" | "brave" | "tavily" | "searxng" | "off";

/** A harness that can run the agent loop through ACP (daemon acp_harnesses.py). */
export interface HarnessItem {
  id: string;
  name: string;
  description: string;
  website: string;
  license: string;
  command: string; // The command line that starts it in ACP mode.
  // downloaded: Harness downloaded it (Download button). installed: the program is on the PATH.
  // npx or uvx: it downloads at the first start. missing: install it first.
  status: "downloaded" | "installed" | "npx" | "uvx" | "missing";
  detail: string;
  custom: boolean; // A harness that the user added.
  recommended: number | null; // The place in the Recommended group of the page, or null.
  reason: string; // Why the harness is recommended. Empty for the others.
  local_models: boolean; // It can use a local model server.
  download: { version: string; kind: "binary" | "npx" | "uvx" } | null; // The download of Harness (daemon acp_install.py).
  latest: string | null; // The newest version in the ACP registry.
  update: boolean; // The registry has a newer version than the download.
  can_download: boolean; // Harness can download it for the daemon computer.
  busy: HarnessProgress | null; // A download runs now.
  provider_models: boolean; // It can use a model of a Harness provider (daemon acp_models.py).
  provider_model: string | null; // The chosen "<provider>/<model>". null: the model settings of the harness.
  provider_note: string; // What the server of the provider must have, for example the Responses API.
}

/** The state of a harness download (harnesses.progress). total 0: the size is not known. */
export interface HarnessProgress {
  stage: string;
  received: number;
  total: number;
}

/** The harness of an ACP session. */
export interface SessionHarness {
  id: string;
  name: string;
  models?: { id: string; name: string; description: string }[]; // The model menu. Empty: the harness gives none.
  model?: string | null; // The current model id. On the start screen (user_settings): the model of a Harness provider, "<provider>/<model>".
  commands?: { name: string; description: string; hint: string }[]; // The / commands of the harness.
}

/** A background task: a command that the agent runs with bash and run_in_background. */
export type TaskKind = "shell" | "monitor" | "agent" | "wakeup" | "cron"; // cron: a scheduled prompt (cron_create).

export interface TaskItem {
  id: string;
  kind?: TaskKind; // A daemon before version 0.1.38 has only shell tasks.
  command: string; // shell, monitor: the command. agent: the prompt. wakeup: the prompt for the agent.
  description: string;
  status: "running" | "done" | "failed" | "stopped";
  started_at: number; // Epoch seconds.
  ended_at: number | null;
  returncode: number | null;
  wake_at?: number | null; // wakeup: the time of the end. cron: the next time. Epoch seconds.
  schedule?: string | null; // cron: the cron expression.
  recurring?: boolean; // cron: it fires more than one time.
}

export interface TaskDetail extends TaskItem {
  output: string; // The kept output: the end of a long output.
  dropped: number; // Characters of output that are not kept.
}

/** A / menu item: a built-in command or a skill. */
export interface CommandItem {
  name: string;
  description: string;
  "argument-hint": string;
  source: string;
  builtin: boolean;
  bundled?: boolean; // A skill that comes with Harness (the Built-in skills list of the Capabilities page).
  acp?: boolean; // A command of the ACP harness of the session. "source" is the harness name.
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
  by?: "agent" | "user"; // Who started the server. A close of the window asks to stop the servers of the agent.
}

/** A running server that an agent started (servers.agent). */
export interface AgentServer {
  session_id: string;
  name: string;
  port: number | null;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  pinned?: boolean; // The sidebar shows it in the Pinned list.
  archived?: boolean; // The sidebar shows it only with the "Archived" or "All" status filter.
  branch?: string | null; // The branch of a worktree session. null: the session works in its project folder.
  routine_id?: string | null; // The routine that started the session. null: the user started it.
  parent_id?: string | null; // The session that started it (a fork, or start_session). The sidebar shows it nested.
}

/** The branches of the repository of a folder, for the "Branch to start from" menu. */
export interface GitBranches {
  repo: boolean; // false: the folder is not in a git repository.
  current: string | null; // null: a detached HEAD.
  branches: string[]; // The local branches, the current first.
}

/** The git worktree of a session: its branch and its folder. */
export interface SessionWorktree {
  branch: string;
  base: string | null; // The branch that the session started from.
  path: string;
}

/** The pull request of the branch of a project folder. branch is null outside a git repository. */
export type PrState = "open" | "draft" | "merged" | "closed";

/** A pull request, as gh gives it (daemon prstatus.parse_pr). The details are null from an older daemon. */
export interface PullRequest {
  number: number;
  state: PrState;
  url: string | null;
  title: string | null;
  repo?: string | null; // "owner/name".
  additions?: number | null;
  deletions?: number | null;
  changed_files?: number | null;
  author?: string | null; // The GitHub login.
  updated_at?: string | null; // ISO time of the merge, the close, or the last update.
  head?: string | null;
  base?: string | null;
}

export interface PrStatus {
  path: string;
  branch: string | null;
  pr: PullRequest | null;
}

// -- Routines: prompts that the daemon runs in a new session at the times of a cron schedule --

export type RoutineRunStatus = "running" | "waiting" | "done" | "failed" | "skipped";

/** One run of a routine. "waiting": a permission request waits for an answer in the session. */
export interface RoutineRun {
  id: string;
  routine_id: string;
  session_id: string | null;
  fire_at: number; // The due time. Epoch seconds.
  started_at: number;
  ended_at: number | null;
  status: RoutineRunStatus;
  error: string | null;
}

/** The fields that the user sets. */
export interface RoutineFields {
  name: string;
  prompt: string;
  cwd: string; // The project folder.
  model: string | null; // "provider/model". null: the default model.
  permission_mode: PermissionMode;
  schedule: string; // A cron expression in the local time of the daemon computer.
  enabled: boolean;
}

export interface RoutineItem extends RoutineFields {
  id: string; // The file name in the routines folder, with no ".md".
  error: string | null; // A problem in the file. The routine does not run until the file is correct.
  provider: string | null;
  created_at: number;
  updated_at: number;
  last_fire_at: number | null;
  next_fire_at: number | null; // null: the routine is off.
  last_run: RoutineRun | null;
  running: boolean;
  queued: boolean; // It waits for a free place (at most 3 routines run at the same time).
  // The API trigger (POST /routines/{id}/fire): active when a token exists. hint: its last 4 characters.
  api?: { active: boolean; hint: string | null };
}

/** One folder or item of the Storage dialog, with its size in bytes. */
export interface DiskItem {
  name: string;
  size: number;
  path?: string;
}

/** The disk space of Harness on the daemon computer (daemon disk_usage.py). Sizes are bytes. */
export interface DiskUsage {
  checked_at: number; // Epoch seconds.
  home: string; // ~/.harness of the daemon computer.
  sessions: {
    size: number; // The database and the worktrees.
    database: number;
    count: number;
    stale_count: number; // Sessions with no activity in the last 30 days.
    stale_size: number;
    worktrees: (DiskItem & { project: string; path: string })[];
    largest: { title: string; project: string; size: number; updated_at: number }[];
  };
  models: { size: number; path: string; items: DiskItem[] }; // The model files of the Hugging Face cache.
  runtime: { size: number; path: string; items: DiskItem[] }; // The Chromium of the browser tools.
  memory: { size: number; items: DiskItem[] }; // ~/.harness without the database, the logs, and the browser profile.
  caches: { size: number; items: DiskItem[] }; // The logs and the browser connector profile.
}

export type MemoryType = "user" | "feedback" | "project" | "reference";

/** One memory of a project (daemon memory.py). */
export interface MemoryItem {
  name: string; // A kebab-case slug: the file name without ".md".
  description: string;
  type: MemoryType;
  content: string;
}

/** One fact of a memory import (Settings > Your Harness > "Start import"). */
export interface MemoryFact {
  type: MemoryType;
  content: string;
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

export type McpState = "starting" | "connected" | "failed" | "disabled" | "stopped" | "needs_auth" | "authenticating";

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
  oauth?: boolean; // The server uses OAuth (an http or sse server with no Authorization header).
  signed_in?: boolean; // Harness has OAuth tokens for the server.
  auth_url?: string; // The sign-in page, while the state is "authenticating".
  connector?: string | null; // The connector that gives the token (connectors.py), for example "github".
}

/** The options of a "device" connector (Outlook). */
export interface ConnectorOptions {
  account: "personal" | "work";
  read_only: boolean;
}

/** The tools of Outlook (classic): "read" only, also make "draft"s, or also "send" a draft. */
export type OutlookMode = "read" | "draft" | "send";

/** The options of a "desktop" connector (Outlook (classic)). */
export interface DesktopConnectOptions {
  mode: OutlookMode;
}

/**
 * A connector of the Connectors tab: an MCP server that Harness sets up in one step (connectors.py).
 * "token" (GitHub): a remote server and a bearer token. "device" (Outlook): a local npm server that signs in
 * with a Microsoft device code and keeps its own tokens. "mail" (Email) and "desktop" (Outlook (classic)):
 * servers that Harness has built in.
 */
export interface ConnectorItem {
  id: string;
  name: string;
  description: string;
  kind: "token" | "device" | "mail" | "desktop";
  url: string; // The MCP server ("token"), or the page of the server ("device").
  installed: boolean; // The server entry is in ~/.harness/mcp.json.
  source: "gh" | "token" | "device" | "mail" | "desktop" | null; // How it signed in. null: not connected.
  login: string | null; // The account.
  signing_in: boolean; // A device sign-in waits for the user.
  gh_available?: boolean; // "token": the GitHub CLI is signed in on the daemon computer.
  token_url?: string; // "token": the page where the user makes a token.
  token_help?: string;
  package?: string; // "device": the npm package, with its version.
  accounts?: ConnectorAccount[]; // "device" and "mail": the signed-in accounts.
  providers?: MailProvider[]; // "mail": the mail services with known settings, and "other".
  mode?: OutlookMode; // "desktop": the tools of the server.
  available?: boolean; // "desktop": false when the daemon computer is not Windows.
}

/** A mail service of the Email connector, with its IMAP and SMTP settings: [host, port, security]. */
export interface MailProvider {
  id: string;
  name: string;
  domains: string[];
  imap: [string, number, MailSecurity];
  smtp: [string, number, MailSecurity];
  password_url: string; // The page where the user makes an app password.
  help: string;
}

export type MailSecurity = "ssl" | "starttls" | "plain";

/** A new account of the Email connector. The host fields are for the provider "other". */
export interface MailConnectOptions {
  email: string;
  password: string;
  provider: string;
  read_only?: boolean;
  imap_host?: string;
  imap_port?: number;
  imap_security?: MailSecurity;
  smtp_host?: string;
  smtp_port?: number;
  smtp_security?: MailSecurity;
}

/** A signed-in account of a "device" connector. The accounts of one type share one MCP server. */
export interface ConnectorAccount {
  login: string;
  type: string; // "personal" or "work" (Outlook), or the mail service (Email): "gmail", "icloud", ..., "other".
  read_only: boolean; // For all the accounts of this type.
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
  removed?: string;
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
  | {
      type: "session.new";
      cwd: string;
      model: string;
      provider?: string;
      permission_mode?: PermissionMode;
      worktree?: boolean | { base?: string | null }; // Work in a new git worktree of the project.
    }
  | { type: "git.branches"; cwd: string }
  | { type: "session.resume"; session_id: string }
  // Take an open session of another connection (the split view) as a background session. Reply: session.adopted.
  | { type: "session.adopt"; session_id: string }
  | { type: "session.leave" } // The start screen. A running turn of the session continues.
  // Rename, pin, or archive. force: archive a worktree session with uncommitted changes.
  | { type: "session.update"; session_id: string; title?: string; pinned?: boolean; archived?: boolean; force?: boolean }
  // The branch and the pull request of project folders, for the sidebar. The reply is "pr_status".
  | { type: "git.pr_status"; paths: string[] }
  | { type: "git.changes"; cwd: string } // The changes of the folder against its base branch (the rail).
  | { type: "git.diff"; cwd: string; scope?: GitDiffScope } // The full change of the folder (the Changes pane).
  | { type: "git.pr_info"; url: string; fresh?: boolean } // A pull request from its URL (a chat link card, the PR list of the rail). fresh: a short daemon cache.
  | { type: "git.status" } // The git state of the changed files in the session folder (the file tree).
  | { type: "session.delete"; session_id: string }
  | { type: "session.move"; session_id: string; cwd: string } // Change the folder. The history stays.
  // The terminal pane: the shell of the session.
  // id: the shell of a tab. new: a new shell, for a new tab. since: the last output number that the tab has.
  // ref: the tab, which comes back in term.opened.
  | { type: "term.open"; cols: number; rows: number; id?: string; since?: number; new?: boolean; ref?: string }
  | { type: "term.close"; id: string } // The user closed the tab: the daemon stops its shell.
  | { type: "term.running"; id: string } // Before a close: the programs that run in the shell.
  // The side chat (Ctrl+;): a quick question that sees the session. Nothing is added to the session.
  // history: the earlier questions and answers of the side chat.
  | { type: "side.ask"; id: string; question: string; history?: { role: "user" | "assistant"; content: string }[] }
  | { type: "side.cancel"; id: string }
  | { type: "tasks.list" }
  | { type: "task.get"; id: string }
  | { type: "task.stop"; id: string }
  | { type: "session.keep_awake"; on: boolean } // Only for this session. The daemon does not save it.
  // The client can host the agent browser in a tab of its Browser pane (the desktop app, a local daemon).
  | { type: "browser.pane"; enabled: boolean }
  // The answer to browser.call: the DevTools result, or an error. "tab": the agent tab that ran it.
  | { type: "browser.result"; call_id: string; tab?: string; result?: Record<string, unknown>; error?: string }
  | { type: "user_settings.get" } // It needs no session.
  | { type: "user_settings.set"; values: Partial<UserSettings> } // null removes the terminal shell.
  | { type: "term.input"; id: string; data: string }
  | { type: "term.resize"; id: string; cols: number; rows: number }
  | { type: "session.list"; cwd?: string; limit?: number }
  | { type: "fs.find"; query: string; cwd?: string } // cwd: the start screen, which has no session.
  | { type: "context.get" }
  | { type: "projects.list" }
  | { type: "projects.save"; id?: string; name: string; path: string; create?: boolean }
  | { type: "projects.delete"; id: string }
  | { type: "routines.list" }
  | ({ type: "routines.save"; id?: string } & RoutineFields)
  | { type: "routines.delete"; id: string }
  | { type: "routines.run"; id: string } // "Run now".

  | { type: "routines.token"; id: string; action: "generate" | "delete" } // The API trigger token of a routine.
  | { type: "disk.usage" } // Settings > General > Storage.
  // Settings > Your Harness > Memory. cwd: the project folder. Each project has its own memory.
  | { type: "acp.model"; model: string } // The model menu of an ACP session. The reply is acp.state.
  | { type: "harnesses.list"; refresh?: boolean } // refresh: read the ACP registry again ("Check again").
  | { type: "harnesses.install"; id: string } // Download the harness, or its update.
  | { type: "harnesses.uninstall"; id: string } // Delete the download.
  | { type: "harnesses.model"; id: string; model: string | null } // A model of a Harness provider. null: the harness settings.
  | { type: "harnesses.save"; name: string; command: string; id?: string }
  | { type: "harnesses.delete"; id: string }
  | { type: "memory.list"; cwd: string }
  | { type: "memory.save"; cwd: string; name: string; old_name?: string; description: string; memory_type: MemoryType; content: string }
  | { type: "memory.delete"; cwd: string; name: string }
  | { type: "memory.parse"; text: string } // The reply of another AI assistant, for the import preview.
  | { type: "memory.import"; cwd: string; items: MemoryFact[] }
  | { type: "memory.export"; cwd: string }
  | { type: "routines.runs"; id: string } // The run history.
  | { type: "prompt"; text: string; display?: string; id?: string; images?: string[] } // display: the text that the user sees. id: for rewind and fork. images: data URLs.
  // Go back to the time before a user message: remove it and all after it, and/or restore the files that the agent changed.
  | { type: "session.rewind"; id: string; conversation: boolean; code: boolean }
  | { type: "session.rewind_undo" } // Undo the last rewind. Only before the next turn.
  // A new session with the conversation before a user message.
  | { type: "session.fork"; id: string }
  | { type: "command"; name: string; args: string }
  | { type: "permission.reply"; request_id: string; decision: Decision }
  // The answers of a question card, by question text. null: the user skipped the questions.
  | { type: "question.reply"; request_id: string; answers: Record<string, string> | null; notes?: Record<string, string> }
  | { type: "plan.reply"; request_id: string; decision: PlanDecision; mode?: PermissionMode; feedback?: string }
  | { type: "interrupt" }
  | { type: "ping" } // The reply is "pong". The client checks that the connection is alive.
  // Install the wheel of the daemon of the app (base64), then restart. Only for a remote daemon.
  | { type: "daemon.update"; filename: string; data: string }
  // A message for the running turn. The agent reads it at its next step. id: the queue item of the client.
  | { type: "steer"; id: string; text: string; display?: string }
  | { type: "skills.list"; cwd?: string } // cwd: the start screen, which has no session.
  | { type: "skills.get"; name: string; cwd?: string }
  | { type: "capabilities.list"; cwd?: string }
  | { type: "fs.dirs"; path?: string; hidden?: boolean }
  | { type: "fs.list"; path: string }
  | { type: "fs.read"; path: string }
  | { type: "fs.read_bytes"; path: string } // A .pdf or .docx file for the Preview pane. The reply is "fs.bytes".
  | { type: "fs.write"; path: string; content: string; base_hash: string | null }
  | { type: "fs.unwatch"; path: string }
  | { type: "fs.create"; path: string; kind: "file" | "dir" } // New file or New folder of the editor.
  | { type: "fs.delete"; path: string } // Delete of the file tree. A folder goes with its contents.
  | { type: "fs.rename"; path: string; name: string } // Rename of the file tree: a new name in the same folder.
  | { type: "fs.search"; query: string; regex?: boolean; case?: boolean; glob?: string }
  // Editor autocomplete: the model writes the text at the cursor (daemon completions.py).
  | { type: "editor.complete"; id: string; path: string; prefix: string; suffix: string }
  | { type: "server.list" }
  | { type: "server.save"; servers: ServerConfigJson[] }
  | { type: "server.start"; name: string }
  | { type: "server.stop"; name?: string; all?: boolean }
  | { type: "server.stop_agent" } // Stop the servers that an agent started, in all sessions of the window.
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
  | { type: "mcp.auth"; name: string }
  | { type: "mcp.auth_code"; name: string; url: string }
  | { type: "mcp.auth_cancel"; name: string }
  | { type: "mcp.logout"; name: string }
  | { type: "connectors.list" }
  | {
      type: "connectors.connect";
      id: string;
      source: "gh" | "token" | "device" | "mail" | "desktop";
      token?: string;
      options?: ConnectorOptions | MailConnectOptions | DesktopConnectOptions;
    }
  | { type: "connectors.cancel"; id: string }
  | { type: "connectors.remove_account"; id: string; login: string }
  | { type: "connectors.disconnect"; id: string }
  | { type: "plugins.list" }
  | { type: "plugins.reload" }
  | { type: "plugins.install"; source: string; replace?: boolean }
  | { type: "plugins.remove"; name: string }
  | { type: "plugins.set_bundle"; name: string; enabled: boolean }
  | { type: "plugins.set_plugin"; id: string; enabled: boolean }
  | { type: "cookbook.hosts" }
  | { type: "cookbook.host.save"; name: string; ssh?: string | null; python?: string | null; llama_server?: string | null; previous?: string }
  | { type: "cookbook.host.delete"; name: string }
  | { type: "cookbook.ssh_key" }
  | { type: "cookbook.hardware"; host: string; refresh?: boolean }
  | { type: "hf.token"; token: string | null }
  | { type: "web.key"; provider: "brave" | "tavily"; key: string | null }
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
  | { type: "auth.ok"; version: string; host: HostInfo; updatable?: boolean } // updatable: "daemon.update" works.
  // The progress of "daemon.update". After "restarting", the connection closes, and the app connects again.
  | { type: "daemon.update"; state: "installing" | "restarting" | "error"; message?: string }
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
  | { type: "editor.completion"; id: string; text: string | null } // null: no completion.
  | { type: "fs.content"; path: string; content: string; hash: string }
  | { type: "fs.bytes"; path: string; data: string; size: number } // data: the file bytes in base64.
  | { type: "fs.saved"; path: string; hash: string }
  | { type: "fs.created"; path: string; kind: "file" | "dir" }
  // trash: the item is in the Recycle Bin of the daemon computer. false: the delete is permanent.
  | { type: "fs.deleted"; path: string; kind: "file" | "dir"; trash: boolean }
  | { type: "fs.renamed"; path: string; new_path: string; kind: "file" | "dir" }
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
      model_unavailable?: string | null; // Why the stored model cannot run: its provider is gone or off.
      harness?: SessionHarness | null; // Another harness runs the agent loop through ACP. null: the built-in loop.
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
      worktree?: SessionWorktree | null; // The session works in this git worktree. cwd is in it.
      auto_verify: boolean; // The agent checks the app after each UI change.
      permission_mode?: PermissionMode;
      image_input: boolean; // The model accepts images: the agent has preview_screenshot.
      keep_awake?: boolean; // The "Keep computer awake" switch of this session.
      // A return to a session with a running turn: the reply text that streams now,
      // and the permission requests that wait for a decision.
      running?: boolean;
      partial?: string | null;
      requests?: PermissionRequest[];
      turn_started_at?: number | null; // Epoch seconds.
      turn_tokens?: number; // The output tokens of the running turn so far.
      steering?: string[]; // The ids of the steer messages that the agent holds for its next step.
    }
  | { type: "session.title"; id: string; title: string } // The model made the title from the first prompt.
  | { type: "session.adopted"; id: string; moved: boolean } // The reply to session.adopt.
  | { type: "session.updated"; id: string; title: string | null; pinned: boolean; archived?: boolean }
  | { type: "pr_status"; items: PrStatus[] }
  | { type: "session.deleted"; id: string }
  | ({ type: "git.branches"; cwd: string } & GitBranches)
  | ({ type: "git.changes"; cwd: string } & GitChanges)
  | ({ type: "git.diff"; cwd: string } & GitDiff)
  | { type: "git.pr_info"; url: string; pr: PullRequest | null }
  | { type: "git.status"; files: Record<string, GitFileState> } // Path in the session folder -> state.
  // The worktree of the session has uncommitted changes. Ask, then send session.update with force.
  | { type: "session.archive_confirm"; id: string; branch: string }
  | { type: "sessions.running"; items: RunningSession[] } // The sessions with a running turn (the sidebar).
  // The sessions with no window that work or wait: routine runs and nested sessions. All windows get it.
  | { type: "sessions.background"; items: RunningSession[] }
  // replay: the last output of a running shell. seq: the number of its last output.
  | { type: "term.opened"; id: string; new: boolean; replay: string; seq: number; reset: boolean; ref?: string }
  | { type: "term.output"; id: string; data: string; seq: number }
  | { type: "term.exit"; id: string; code: number | null }
  | { type: "term.running"; id: string; names: string[] } // Empty: the shell waits at its prompt.
  | { type: "side.token"; id: string; text: string; session_id?: string } // A part of a side chat answer.
  | { type: "side.done"; id: string; text: string; session_id?: string }
  | { type: "side.error"; id: string; message: string; session_id?: string }
  | { type: "tasks"; items: TaskItem[] } // The background tasks of the session, after each start and end.
  | ({ type: "task" } & TaskDetail)
  | { type: "keep_awake"; on: boolean; active: boolean } // active: the computer stays awake now.
  // harness: the operating harness of new sessions (Settings > Operating Harness). null: the built-in loop.
  | { type: "user_settings"; values: UserSettings; path: string; version: string; harness?: SessionHarness | null }
  | ({ type: "settings" } & ClientSettings)
  | { type: "providers"; items: ProviderItem[]; path: string; exists: boolean }
  | ({ type: "providers.test" } & ProviderTestResult)
  // default: the model that a new session with no model uses now, or null. An older daemon does not send it.
  | { type: "models"; items: { provider: string; model: string }[]; errors: { provider: string; message: string }[]; default?: string | null }
  | ({ type: "mcp" } & McpStatus)
  | { type: "mcp.init"; path: string; created: boolean }
  | { type: "mcp.auth_url"; name: string; url: string }
  | { type: "connectors"; items: ConnectorItem[] }
  | { type: "connectors.device_code"; id: string; url: string; code: string }
  | { type: "capabilities"; cwd: string | null; live: boolean; skills: CommandItem[]; mcp: McpStatus }
  | ({ type: "plugins" } & PluginsStatus)
  | { type: "cookbook.hosts"; items: CookbookHost[]; public_key: string | null; key_path: string }
  | { type: "hardware"; host: string; info: HardwareInfo }
  | { type: "hf.token"; set: boolean }
  | { type: "web.key"; provider: "brave" | "tavily"; set: boolean }
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
  // A DevTools protocol call for the agent tab of the Browser pane. The client answers with browser.result.
  | { type: "browser.call"; call_id: string; method: string; params: Record<string, unknown>; timeout_ms: number; session_id?: string }
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
  // The memories of a project. saved: the name after memory.save. imported: the count after memory.import.
  | { type: "memory"; cwd: string; path: string; items: MemoryItem[]; import_prompt: string; saved?: string; imported?: number }
  | { type: "harnesses"; items: HarnessItem[]; current: string; path: string } // Settings > Operating Harness.
  | ({ type: "harnesses.progress"; id: string } & HarnessProgress) // A harness download runs.
  | { type: "acp.state"; session_id?: string; harness: SessionHarness } // The models and the commands of an ACP harness.
  | { type: "memory.parsed"; items: MemoryFact[] }
  | ({ type: "disk.usage" } & DiskUsage)
  | { type: "memory.export"; cwd: string; name: string; data: string; count: number } // data: the .zip as base64.
  | { type: "routines"; items: RoutineItem[]; saved?: string; folder?: string } // To all clients. saved: the id after routines.save. folder: the routine files.
  | { type: "routine.runs"; routine_id: string; items: RoutineRun[] }
  // The running servers that an agent started, in the sessions of this window.
  | { type: "servers.agent"; items: AgentServer[] }
  // "Archive inactive sessions" archived these sessions. All windows get it.
  | { type: "sessions.archived"; ids: string[] }
  // The reply to routines.token: the new token, shown one time. null: the token was deleted.
  | { type: "routine.token"; id: string; token: string | null }
  // A turn ended, also in a session in the background: the client shows a notification if the user does not see it.
  | { type: "turn.done"; session_id: string; title: string | null; summary: string; stop_reason: string }
  | {
      // To all clients: a run started, waits for a permission answer, or ended.
      type: "routine.run";
      routine_id: string;
      run_id: string;
      name: string;
      session_id: string | null;
      status: RoutineRunStatus;
      error: string | null;
    }
  | { type: "token"; text: string }
  | { type: "thinking" } // The model thinks (its reasoning streams). The working line shows "Thinking…".
  // agent: the skill name when a forked skill runs the tool in a subagent.
  | { type: "tool.start"; id: string; name: string; input: unknown; agent?: string }
  | { type: "tool.result"; id: string; output: string; is_error: boolean; diff?: string; image?: string; agent?: string; created?: string[]; card?: ToolCardData }
  | ({ type: "permission.request" } & PermissionRequest)
  | { type: "permissions"; path: string; allow: string[]; deny: string[] }
  | { type: "turn.end"; usage: Usage; stop_reason: StopReason }
  // A steer message went into the history. text: the text that the user sees.
  | { type: "steer.taken"; id: string; text: string; origin?: "task" }
  // A turn that the daemon started, with no prompt: the notes of background tasks (origin "task").
  | { type: "turn.started"; id: string; text: string; origin: "task" }
  // The turn ended before the next step, or no turn ran: the client sends these messages as prompts.
  | { type: "steer.returned"; ids: string[] }
  // After a turn: the next prompt that the model predicts. The prompt box shows it. Tab puts it in the box.
  | { type: "prompt.suggestion"; text: string }
  // After a rewind or a fork: the text of the user message. It replaces the text in the prompt box.
  | { type: "prompt.fill"; text: string }
  // A rewind is done: the chat shows the text with "Undo rewind". After session.rewind_undo: rewind.undone.
  | { type: "rewind.done"; text: string }
  | { type: "rewind.undone"; text: string }
  | { type: "pong" }
  | { type: "notice"; level: "error" | "warning" | "info"; text: string } // For example, a plugin added a message.
  // The checks of the model endpoint after a session open: the context length, the image input, and new warnings.
  | { type: "session.model_info"; context_length: number; context_source?: string; image_input: boolean; warnings: string[] }
  // The token counts of the turn so far, after each model reply.
  | { type: "turn.usage"; prompt_tokens: number; completion_tokens: number; last_prompt_tokens: number }
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
  | { type: "error"; message: string; ref?: string };
