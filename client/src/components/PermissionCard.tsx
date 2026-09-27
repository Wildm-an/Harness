import { memo } from "react";
import { Check, Clock, FileDiff, ShieldAlert, X } from "lucide-react";
import type { PermissionItem } from "../chat/state";
import type { Decision } from "../daemon/protocol";
import { parseUnifiedDiff } from "../lib/diff";
import { DiffStats } from "./DiffStats";
import { toolSummary } from "./ToolCard";

const DECIDED: Record<Decision, string> = {
  allow_once: "Allowed once",
  allow_always: "Always allowed",
  deny: "Denied",
};

function title(item: PermissionItem): string {
  if (item.tool === "bash") return "Run this command?";
  if (item.tool === "server") return "Start this server?";
  const path = toolSummary(item.tool, item.input);
  if (item.tool === "write" && item.diff && parseUnifiedDiff(item.diff).isNewFile) return `Create ${path}?`;
  if (item.tool === "write") return `Replace ${path}?`;
  if (item.tool === "edit") return `Change ${path}?`;
  return `Allow the ${item.tool} tool?`;
}

export const PermissionCard = memo(function PermissionCard({
  item,
  reviewing,
  onDecide,
  onReview,
}: {
  item: PermissionItem;
  reviewing: boolean; // The diff review pane shows this request.
  onDecide: (requestId: string, decision: Decision) => void;
  onReview: (requestId: string) => void;
}) {
  const decided = item.decision !== undefined || item.expired === true;
  return (
    <section className={`permission-card${decided ? " decided" : ""}`} aria-label="Permission request">
      <header className="permission-head">
        <ShieldAlert size={16} aria-hidden />
        <span>{title(item)}</span>
        {item.diff && <DiffStats diff={item.diff} />}
        {item.diff && (
          <button
            type="button"
            className={`btn btn-small${reviewing ? " active" : ""}`}
            onClick={() => onReview(item.id)}
            aria-pressed={reviewing}
          >
            <FileDiff size={14} aria-hidden />
            {reviewing ? "In review" : "Review"}
          </button>
        )}
        {item.decision !== undefined && (
          <span className={`permission-outcome ${item.decision === "deny" ? "denied" : "allowed"}`}>
            {item.decision === "deny" ? <X size={14} aria-hidden /> : <Check size={14} aria-hidden />}
            {DECIDED[item.decision]}
          </span>
        )}
        {item.decision === undefined && item.expired && (
          <span className="permission-outcome expired">
            <Clock size={14} aria-hidden />
            No decision
          </span>
        )}
      </header>
      {!decided && (
        <>
          {!item.diff && <pre className="permission-command">{toolSummary(item.tool, item.input)}</pre>}
          <div className="permission-actions">
            <button type="button" className="btn btn-primary" onClick={() => onDecide(item.id, "allow_once")}>
              Allow once
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => onDecide(item.id, "allow_always")}
              title={`Adds ${item.rule} to the project permission rules`}
            >
              Always allow
            </button>
            <button type="button" className="btn btn-danger" onClick={() => onDecide(item.id, "deny")}>
              Deny
            </button>
            <span className="permission-rule">
              Always adds <code>{item.rule}</code>
            </span>
          </div>
        </>
      )}
    </section>
  );
});
