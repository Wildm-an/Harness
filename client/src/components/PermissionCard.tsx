import { memo, useEffect, useRef } from "react";
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

// The choices in the order of Claude Code: the keys 1, 2, and 3 select them.
const CHOICES: Decision[] = ["allow_once", "allow_always", "deny"];

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
  const options = useRef<HTMLDivElement>(null);

  // A new request gets the keyboard focus, so that 1, 2, 3, or Esc answers it at once. The focus goes to
  // the list, not to a button: Enter and Space do not answer. The request never takes the focus from a
  // text field, so that a key that the user types for the prompt never answers it.
  useEffect(() => {
    if (decided) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest("input, textarea, select, [contenteditable='true']")) return;
    options.current?.focus({ preventScroll: true });
  }, [decided]);

  const decide = (decision: Decision) => {
    onDecide(item.id, decision);
    // The choices go away. Give the focus back to the prompt.
    document.getElementById("prompt-input")?.focus({ preventScroll: true });
  };

  // A plugin that asks for approval gets no "always" choice: the keys are 1 (yes) and 2 (no).
  const choices = item.rule ? CHOICES : CHOICES.filter((c) => c !== "allow_always");

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const index = ["1", "2", "3"].indexOf(e.key);
    if (index >= 0 && index < choices.length) {
      e.preventDefault();
      decide(choices[index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      decide("deny");
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const buttons = [...(options.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

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
          {item.reason && <p className="permission-reason">{item.reason}</p>}
          <p className="permission-question" id={`perm-q-${item.id}`}>
            Do you want to proceed?
          </p>
          <div
            className="permission-options"
            role="group"
            aria-labelledby={`perm-q-${item.id}`}
            tabIndex={-1}
            ref={options}
            onKeyDown={onKeyDown}
          >
            <button type="button" className="permission-option" onClick={() => decide("allow_once")}>
              <kbd>1</kbd>
              <span>Yes</span>
            </button>
            {item.rule && (
              <button
                type="button"
                className="permission-option"
                onClick={() => decide("allow_always")}
                title={`Adds ${item.rule} to the project permission rules`}
              >
                <kbd>2</kbd>
                <span>
                  Yes, and do not ask again for <code>{item.rule}</code>
                </span>
              </button>
            )}
            <button type="button" className="permission-option deny" onClick={() => decide("deny")}>
              <kbd>{choices.length}</kbd>
              <span>No</span>
              <span className="permission-key-hint">Esc</span>
            </button>
          </div>
        </>
      )}
    </section>
  );
});
