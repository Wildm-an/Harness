import { memo, useState } from "react";
import { ChevronRight, CircleX, FileDiff, FileText, LoaderCircle } from "lucide-react";
import type { ToolItem } from "../chat/state";
import { toolAction } from "../chat/toolText";
import { DiffStats } from "./DiffStats";
import { InlineDiff } from "./InlineDiff";
import { useOpenPath } from "../lib/openPath";

// The names that Claude Code shows for its tools.
const LABELS: Record<string, string> = {
  read: "Read",
  edit: "Update",
  write: "Write",
  glob: "Glob",
  grep: "Search",
  bash: "Bash",
  skill: "Skill",
};

/** The display name of a tool: "Read", "Preview click", or "github: create_issue" for an MCP tool. */
export function toolLabel(name: string): string {
  if (LABELS[name]) return LABELS[name];
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}: ${mcp[2]}`;
  if (name.startsWith("preview_")) return `Preview ${name.slice("preview_".length)}`;
  return name;
}

/** A one-line summary of the tool input: the path or the command. */
export function toolSummary(name: string, input: unknown): string {
  if (name.startsWith("mcp__") && input && typeof input === "object") {
    // An MCP tool: the first short text argument, or the argument names.
    const values = Object.values(input as Record<string, unknown>);
    const text = values.find((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 120);
    if (text) return text;
    const keys = Object.keys(input as object);
    return keys.length ? keys.map((k) => `${k}=${JSON.stringify((input as Record<string, unknown>)[k])}`).join(" ").slice(0, 120) : "";
  }
  if (input && typeof input === "object") {
    const args = input as Record<string, unknown>;
    if (typeof args.command === "string") return args.command;
    if (name === "skill" && typeof args.name === "string") {
      return typeof args.arguments === "string" && args.arguments ? `${args.name} ${args.arguments}` : args.name;
    }
    if (typeof args.pattern === "string") {
      const where = [args.path, args.glob].filter((v) => typeof v === "string" && v).join(" ");
      return where ? `${args.pattern}  in ${where}` : args.pattern;
    }
    if (typeof args.path === "string") {
      const range = typeof args.offset === "number" ? `:${args.offset}` : "";
      return `${args.path}${range}`;
    }
    // The preview tools: a URL, an element reference, or a server name.
    if (typeof args.url === "string") return typeof args.server === "string" ? `${args.url}  on ${args.server}` : args.url;
    if (typeof args.ref === "string") return typeof args.text === "string" ? `${args.ref}  "${args.text}"` : args.ref;
    if (typeof args.name === "string") return args.name;
  }
  return typeof input === "string" ? input : name;
}

export const ToolCard = memo(function ToolCard({
  item,
  reviewing,
  onReview,
}: {
  item: ToolItem;
  reviewing: boolean;
  onReview: (toolId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const openPath = useOpenPath();
  const input = item.input as Record<string, unknown> | null;
  const filePath = input && typeof input === "object" && typeof input.path === "string" && item.name !== "glob" && item.name !== "grep"
    ? input.path
    : null;
  const summary = toolSummary(item.name, item.input);
  const action = toolAction(item);

  return (
    <div className={`tool-card tool-${item.status}`}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${toolLabel(item.name)}: ${summary}`}
      >
        {item.status === "running" && <LoaderCircle size={13} className="tool-state spin" role="img" aria-label="Running" />}
        {item.status === "error" && <CircleX size={13} className="tool-state failed" role="img" aria-label="Failed" />}
        <span className="tool-text">
          <span className="tool-verb">{action.verb}</span>
          {action.object && <span className={`tool-object${action.mono ? " mono" : ""}`}>{action.object}</span>}
        </span>
        {item.agent && (
          <span className="tool-agent" title={`The skill ${item.agent} runs this tool in a separate context`}>
            /{item.agent}
          </span>
        )}
        {item.diff && <DiffStats diff={item.diff} />}
        <ChevronRight className="tool-chevron" size={14} aria-hidden />
      </button>
      {open && (
        <div className="tool-body">
          {filePath && openPath && (
            <button type="button" className="btn btn-small tool-review" onClick={() => openPath(filePath, typeof input?.offset === "number" ? input.offset : undefined)}>
              <FileText size={14} aria-hidden />
              Open in Files
            </button>
          )}
          {item.diff && (
            <button
              type="button"
              className={`btn btn-small tool-review${reviewing ? " active" : ""}`}
              onClick={() => onReview(item.id)}
              aria-pressed={reviewing}
            >
              <FileDiff size={14} aria-hidden />
              {reviewing ? "In review" : "Review the change"}
            </button>
          )}
          {item.diff && (
            <>
              <div className="tool-section-label">Change</div>
              <InlineDiff diff={item.diff} />
            </>
          )}
          <div className="tool-section-label">Input</div>
          <pre className="tool-pre">{JSON.stringify(item.input, null, 2)}</pre>
          {item.output !== undefined && (
            <>
              <div className="tool-section-label">Output</div>
              <pre className="tool-pre">{item.output}</pre>
            </>
          )}
          {item.image && (
            <>
              <div className="tool-section-label">Image</div>
              <img className="tool-image" src={item.image} alt={`The image from ${item.name}`} />
            </>
          )}
        </div>
      )}
    </div>
  );
});
