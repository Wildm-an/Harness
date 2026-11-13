// Where an error of the daemon shows (docs/UI_RULES.md M18a).
//
// The daemon puts the type of the failed request in `ref`. An error of a turn (the model, a hook,
// the context summary) has no `ref`. Only an error that belongs to the conversation goes into the
// chat. All other errors show in the view that sent the request, or in a popup at the bottom of
// the window. An error of a background request must never go into the middle of a reply.

export type ErrorRoute =
  | "chat" // The conversation: a failed turn, or a request that the user sent from the chat.
  | "view" // A component shows the error next to its control.
  | "quiet" // A background request that repeats: the next one tries again. Only the console gets it.
  | "toast"; // All other requests: a popup at the bottom of the window.

/** Requests that the user sends from the chat. */
const CHAT = new Set([
  "prompt",
  "command",
  "steer",
  "interrupt",
  "permission.reply",
  "question.reply",
  "plan.reply",
  "session.rewind",
  "session.rewind_undo",
  "session.fork",
]);

/** Requests that repeat with no action of the user, and typing helpers. */
const QUIET = new Set([
  "git.status",
  "git.changes",
  "git.pr_info",
  "git.pr_status",
  "context.get",
  "tasks.list",
  "fs.find",
  "fs.unwatch",
  "editor.complete",
  "term.input",
  "term.resize",
  "term.running", // An older daemon has no answer: the tab closes with no question.
  "ping",
]);

/** Requests with a component that shows the error itself. */
const VIEW = new Set([
  "git.diff", // The Changes pane.
  "disk.usage", // The Storage dialog.
  "user_settings.set", // Settings > General.
  // Settings > Local models (cookbook/useCookbook.ts).
  "hf.token",
  "hf.search",
  "hf.model",
  "hf.download",
  "download.pause",
  "download.resume",
  "download.cancel",
  "models.installed",
  "models.delete",
]);

/** The same, by the start of the type. */
const VIEW_PREFIXES = [
  "fs.", // The editor, the file tree, the folder picker, and the Preview pane.
  "harnesses.", // Settings > Operating Harness.
  "memory.", // Settings > Your Harness.
  "project_instructions.", // Settings > Your Harness.
  "output_styles.", // Settings > Your Harness.
  "cookbook.",
  "serve.",
];

export function errorRoute(ref: string | undefined): ErrorRoute {
  if (!ref || CHAT.has(ref)) return "chat";
  if (QUIET.has(ref)) return "quiet";
  if (VIEW.has(ref) || VIEW_PREFIXES.some((p) => ref.startsWith(p))) return "view";
  return "toast";
}

export interface ErrorKind {
  title: string; // The titles of rule M18.
  retry: boolean; // "Try again" can help: the same prompt can get a reply.
}

/** The title of the error card of a failed turn, from the text of the daemon. */
export function errorKind(message: string): ErrorKind {
  if (/^The context summary failed/i.test(message)) return { title: "Compaction failed", retry: false };
  if (/hook blocked the prompt/i.test(message)) return { title: "Turn failed", retry: false };
  if (/rate.?limit|too many requests|\b429\b/i.test(message)) return { title: "Rate limited", retry: true };
  if (/context (window|length|size)|maximum context|too many tokens|prompt is too long|exceeds? the (available )?context/i.test(message)) {
    return { title: "Your context window is full", retry: false };
  }
  if (/overloaded|service unavailable|server is busy|\b(502|503|529)\b/i.test(message)) return { title: "Service is busy", retry: true };
  return { title: "Turn failed", retry: true };
}

export interface ErrorToastItem {
  id: number;
  text: string;
  count: number; // The times that this text came while the popup shows.
  undo?: () => void; // An info popup with "Undo" after an action that has no question first (rule R7a).
  open?: () => void; // A click on the popup opens the place of the problem, for example a failed MCP server.
}

/** Adds an error popup that opens the place of the problem on a click. The same text replaces the old popup. */
export function addOpenToast(list: ErrorToastItem[], text: string, open: () => void, id: number): ErrorToastItem[] {
  return [...list.filter((t) => t.text !== text), { id, text, count: 1, open }].slice(-MAX_ERROR_TOASTS);
}

/** The MCP servers that failed in `next` and did not fail in `previous` (the MCP states of the session). */
export function newlyFailedMcp(
  previous: { name: string; state: string }[] | null,
  next: { name: string; state: string; error: string | null }[],
): { name: string; error: string | null }[] {
  const before = new Map((previous ?? []).map((i) => [i.name, i.state]));
  return next.filter((i) => i.state === "failed" && before.get(i.name) !== "failed").map((i) => ({ name: i.name, error: i.error }));
}

/** The popup text of a failed MCP server: the name, and the first line of the error (at most 120 characters). */
export function mcpFailureText(name: string, error: string | null): string {
  const line = (error ?? "").split(/\r?\n/)[0].trim();
  const short = line.length > 120 ? `${line.slice(0, 119)}…` : line;
  return short ? `The MCP server ${name} did not connect: ${short}` : `The MCP server ${name} did not connect.`;
}

/** Adds the popup of an action that can be undone. A new one replaces an old undo popup: only the last action can be undone. */
export function addUndoToast(list: ErrorToastItem[], text: string, undo: () => void, id: number): ErrorToastItem[] {
  return [...list.filter((t) => !t.undo), { id, text, count: 1, undo }].slice(-MAX_ERROR_TOASTS);
}

/** The popups show the 3 newest texts. A text that shows already gets a count, not a second popup. */
export const MAX_ERROR_TOASTS = 3;

export function addErrorToast(list: ErrorToastItem[], text: string, id: number): ErrorToastItem[] {
  const same = list.find((t) => t.text === text);
  if (same) return list.map((t) => (t === same ? { ...t, count: t.count + 1 } : t));
  return [...list, { id, text, count: 1 }].slice(-MAX_ERROR_TOASTS);
}
