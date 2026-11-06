// The text of tool calls in the chat, as in Claude: "Ran skill /review", "Read test.png", and for a
// group of calls "Ran 3 commands, read test.png, used a tool".

import { parseUnifiedDiff as parseDiffNow } from "../lib/diff";

// The chat renders the tool lines again for each new text of the model. A diff is parsed one time.
const parsedDiffs = new Map<string, ReturnType<typeof parseDiffNow>>();
function parseUnifiedDiff(diff: string): ReturnType<typeof parseDiffNow> {
  let parsed = parsedDiffs.get(diff);
  if (!parsed) {
    if (parsedDiffs.size >= 300) parsedDiffs.delete(parsedDiffs.keys().next().value as string);
    parsed = parseDiffNow(diff);
    parsedDiffs.set(diff, parsed);
  }
  return parsed;
}
import type { ToolItem } from "./state";

/** One call: a muted verb and a bright object, for example "Read" and "test.png". */
export interface ToolAction {
  verb: string;
  object: string;
  mono: boolean; // The object is code, for example a command.
}

type Kind = "command" | "read" | "edit" | "search" | "web" | "fetch" | "skill" | "tool";

const MAX_OBJECT = 90;

function args(item: ToolItem): Record<string, unknown> {
  return item.input && typeof item.input === "object" ? (item.input as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The file name of a path: "src/app.py" -> "app.py". */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** A URL with no scheme and no "www.": "https://www.example.com/docs" -> "example.com/docs". */
export function urlLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "") || "a page";
}

function short(value: string): string {
  const line = value.split("\n")[0];
  return line.length > MAX_OBJECT || value.includes("\n") ? `${line.slice(0, MAX_OBJECT).trimEnd()}…` : line;
}

export function toolKind(item: ToolItem): Kind {
  switch (item.name) {
    case "bash":
      return "command";
    case "read":
      return "read";
    case "edit":
    case "write":
    case "office_edit":
      return "edit";
    case "grep":
    case "glob":
      return "search";
    case "web_search":
      return "web";
    case "web_fetch":
      return "fetch";
    case "skill":
      return "skill";
    default:
      return "tool";
  }
}

/** The text of one call. A running call uses the present tense: "Running", "Reading". */
export function toolAction(item: ToolItem): ToolAction {
  const a = args(item);
  const running = item.status === "running";
  const pick = (done: string, now: string) => (running ? now : done);
  switch (item.name) {
    case "bash": {
      const description = text(a.description);
      if (description) return { verb: description.replace(/\.$/, ""), object: "", mono: false };
      return { verb: pick("Ran", "Running"), object: short(text(a.command) || "a command"), mono: true };
    }
    case "read":
      return { verb: pick("Read", "Reading"), object: baseName(text(a.path) || "a file"), mono: false };
    case "edit":
      return { verb: pick("Edited", "Editing"), object: baseName(text(a.path) || "a file"), mono: false };
    case "office_edit": {
      // A Word, PowerPoint, or Excel file (daemon tools/office.py).
      const made = a.create === true;
      return { verb: pick(made ? "Created" : "Edited", made ? "Creating" : "Editing"), object: baseName(text(a.path) || "a document"), mono: false };
    }
    case "write": {
      const created = !!item.diff && parseUnifiedDiff(item.diff).isNewFile;
      return { verb: pick(created ? "Created" : "Wrote", "Writing"), object: baseName(text(a.path) || "a file"), mono: false };
    }
    case "grep":
      return { verb: pick("Searched for", "Searching for"), object: short(text(a.pattern)), mono: true };
    case "glob":
      return { verb: pick("Found files", "Finding files"), object: short(text(a.pattern)), mono: true };
    case "web_search":
      return { verb: pick("Searched the web for", "Searching the web for"), object: short(text(a.query)), mono: false };
    case "tool_search": {
      // The agent loads MCP tools that the request had by name only (daemon tools/tool_search.py).
      const query = text(a.query).replace(/^select:/i, "").replace(/mcp__[^_]+(?:_[^_]+)*?__/g, "");
      return { verb: pick("Loaded tools", "Loading tools"), object: short(query), mono: false };
    }
    case "web_fetch":
      return { verb: pick("Fetched", "Fetching"), object: short(urlLabel(text(a.url))), mono: false };
    case "skill":
      return { verb: pick("Ran skill", "Running skill"), object: `/${text(a.name) || "skill"}`, mono: false };
    case "ask_user_question": {
      const n = Array.isArray(a.questions) ? a.questions.length : 1;
      return { verb: pick("Asked", "Asking"), object: n === 1 ? "a question" : `${n} questions`, mono: false };
    }
    case "exit_plan_mode":
      return { verb: pick("Proposed", "Proposing"), object: "a plan", mono: false };
    case "show_visual":
      // A visual in the chat (daemon tools/visual.py). It shows as a row only when it failed.
      return { verb: pick("Made", "Making"), object: "a visual", mono: false };
    case "send_file": {
      // Files for the user (daemon tools/share.py). The card shows them, so the row shows only on an error.
      const files = Array.isArray(a.files) ? a.files : [a.files];
      return { verb: pick("Sent", "Sending"), object: files.length === 1 ? baseName(text(files[0]) || "a file") : `${files.length} files`, mono: false };
    }
    case "artifact": {
      const action = text(a.action) || "publish";
      if (action === "list") return { verb: pick("Listed", "Listing"), object: "the artifacts", mono: false };
      if (action === "read") return { verb: pick("Read", "Reading"), object: "an artifact", mono: false };
      if (action === "delete") return { verb: pick("Deleted", "Deleting"), object: "an artifact", mono: false };
      return { verb: pick("Published", "Publishing"), object: text(a.title) || baseName(text(a.file_path) || "an artifact"), mono: false };
    }
    case "show_document":
      // The agent opened a PDF or Word file in the Preview pane (daemon tools/document.py).
      return { verb: pick("Opened preview of", "Opening preview of"), object: baseName(text(a.path) || "a document"), mono: false };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(item.name);
  if (mcp) return { verb: pick("Used", "Using"), object: `${mcp[1]}: ${mcp[2]}`, mono: false };
  if (item.name.startsWith("preview_")) {
    return { verb: pick("Used the browser", "Using the browser"), object: item.name.slice("preview_".length), mono: false };
  }
  return { verb: pick("Used", "Using"), object: item.name, mono: false };
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/**
 * The line of a group of calls, in the order of the first call of each kind:
 * "Ran 3 commands, read test.png, used a tool". The failed calls come at the end.
 */
export function groupSummary(items: ToolItem[]): string {
  const order: Kind[] = [];
  const byKind = new Map<Kind, ToolItem[]>();
  for (const item of items) {
    const kind = toolKind(item);
    if (!byKind.has(kind)) {
      byKind.set(kind, []);
      order.push(kind);
    }
    byKind.get(kind)!.push(item);
  }
  const parts = order.map((kind) => {
    const list = byKind.get(kind)!;
    const n = list.length;
    const single = n === 1 ? toolAction({ ...list[0], status: "done" }) : null;
    switch (kind) {
      case "command":
        return count(n, "ran a command", "commands").replace(/^(\d)/, "ran $1");
      case "read":
        return single ? `read ${single.object}` : `read ${n} files`;
      case "edit":
        return single ? `${single.verb.toLowerCase()} ${single.object}` : `changed ${n} files`;
      case "search":
        return n === 1 ? "searched the code" : `searched the code ${n} times`;
      case "web":
        return n === 1 ? "searched the web" : `searched the web ${n} times`;
      case "fetch":
        return single ? `fetched ${single.object}` : `fetched ${n} pages`;
      case "skill":
        return single ? `ran skill ${single.object}` : `ran ${n} skills`;
      case "tool":
        return count(n, "used a tool", "tools").replace(/^(\d)/, "used $1");
    }
  });
  const failed = items.filter((i) => i.status === "error").length;
  if (failed) parts.push(`${failed} failed`);
  const line = parts.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** The added and removed lines of all file changes in a group. Null if no call changed a file. */
export function diffTotals(items: ToolItem[]): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  let any = false;
  for (const item of items) {
    if (!item.diff) continue;
    const parsed = parseUnifiedDiff(item.diff);
    added += parsed.added;
    removed += parsed.removed;
    any = true;
  }
  return any ? { added, removed } : null;
}
