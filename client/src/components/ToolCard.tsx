import { memo, useState } from "react";
import {
  Check,
  ChevronRight,
  FileDiff,
  FilePlus,
  FileText,
  FolderSearch,
  LoaderCircle,
  Pencil,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { ToolItem } from "../chat/state";
import { DiffStats } from "./DiffStats";

const ICONS: Record<string, typeof Terminal> = {
  read: FileText,
  edit: Pencil,
  write: FilePlus,
  glob: FolderSearch,
  grep: Search,
  bash: Terminal,
  skill: Sparkles,
};

/** A one-line summary of the tool input: the path or the command. */
export function toolSummary(name: string, input: unknown): string {
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
  const Icon = ICONS[item.name] ?? Wrench;
  const summary = toolSummary(item.name, item.input);
  const statusLabel = item.status === "running" ? "Running" : item.status === "error" ? "Failed" : "Done";

  return (
    <div className={`tool-card tool-${item.status}`}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={open ? "Hide details" : "Show details"}
      >
        <ChevronRight className="tool-chevron" size={14} aria-hidden />
        <Icon size={15} aria-hidden className="tool-icon" />
        <span className="tool-name">{item.name}</span>
        {item.agent && (
          <span className="tool-agent" title={`The skill ${item.agent} runs this tool in a separate context`}>
            /{item.agent}
          </span>
        )}
        <span className="tool-summary">{summary}</span>
        {item.diff && <DiffStats diff={item.diff} />}
        <span className="tool-status" aria-label={statusLabel} title={statusLabel}>
          {item.status === "running" && <LoaderCircle size={15} className="spin" aria-hidden />}
          {item.status === "done" && <Check size={15} aria-hidden />}
          {item.status === "error" && <X size={15} aria-hidden />}
        </span>
      </button>
      {open && (
        <div className="tool-body">
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
          <div className="tool-section-label">Input</div>
          <pre className="tool-pre">{JSON.stringify(item.input, null, 2)}</pre>
          {item.output !== undefined && (
            <>
              <div className="tool-section-label">Output</div>
              <pre className="tool-pre">{item.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
});
