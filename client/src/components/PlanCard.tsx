// The plan card of exit_plan_mode (daemon tools/interact.py, docs/UI_RULES.md M11-M13): "Claude proposed a
// plan", the plan, then at the left "Reject" and "Revise…" (Esc), and at the right "Accept"
// (Ctrl+Shift+Enter) and the primary "Accept and allow edits" (Ctrl+Enter) with a menu of the other modes.

import { memo, useContext, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Clock, ListChecks, PenLine, X } from "lucide-react";
import type { PermissionMode, PlanDecision } from "../daemon/protocol";
import type { PlanItem } from "../chat/state";
import { Markdown } from "./Markdown";
import { InSplitPane, keyForPane, usePromptInputId } from "../lib/split";

const MODE_NAMES: Partial<Record<PermissionMode, string>> = {
  acceptEdits: "Allow edits",
  default: "Ask permissions",
  auto: "Auto mode",
  bypassPermissions: "Bypass permissions",
};

/** The text of a decided plan card. */
export function planOutcome(item: PlanItem): string {
  if (item.decision === "accept") return `Accepted${item.mode && MODE_NAMES[item.mode] ? ` · ${MODE_NAMES[item.mode]}` : ""}`;
  if (item.decision === "revise") return "Changes asked";
  if (item.decision === "reject") return "Rejected";
  return "No decision";
}

export const PlanCard = memo(function PlanCard({
  item,
  onDecide,
}: {
  item: PlanItem;
  onDecide: (requestId: string, decision: PlanDecision, mode?: PermissionMode, feedback?: string) => void;
}) {
  const pending = !item.decision && !item.expired;
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [menu, setMenu] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const decideRef = useRef(onDecide);
  decideRef.current = onDecide;
  const inSplit = useContext(InSplitPane); // With a split view, the key is for the pane with the focus.
  const promptId = usePromptInputId();

  const decide = (decision: PlanDecision, mode?: PermissionMode, text?: string) => {
    setMenu(false);
    decideRef.current(item.id, decision, mode, text);
    document.getElementById(promptId)?.focus({ preventScroll: true });
  };

  // Ctrl+Enter accepts and allows edits, Ctrl+Shift+Enter accepts, from any place in the window.
  useEffect(() => {
    if (!pending || revising) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (!keyForPane(e.target, inSplit)) return;
      e.preventDefault();
      e.stopPropagation();
      decideRef.current(item.id, "accept", e.shiftKey ? "default" : "acceptEdits");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, revising, item.id, inSplit]);

  useEffect(() => {
    if (!pending) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest("input, textarea, select, [contenteditable='true']")) return;
    actions.current?.focus({ preventScroll: true });
  }, [pending]);

  return (
    <section className={`permission-card plan-card${pending ? "" : " decided"}`} aria-label="Plan">
      <header className="permission-head">
        <ListChecks size={16} aria-hidden />
        <span className="permission-head-title">Claude proposed a plan</span>
        {!pending && (
          <span className={`permission-outcome ${item.decision === "accept" ? "allowed" : item.decision === "reject" ? "denied" : "expired"}`}>
            {item.decision === "accept" ? <Check size={14} aria-hidden /> : item.decision === "reject" ? <X size={14} aria-hidden /> : item.decision === "revise" ? <PenLine size={14} aria-hidden /> : <Clock size={14} aria-hidden />}
            {planOutcome(item)}
          </span>
        )}
      </header>
      <div className="plan-body">
        <Markdown text={item.plan} />
      </div>
      {pending && revising && (
        <div className="plan-revise">
          <textarea
            className="setting-textarea"
            value={feedback}
            autoFocus
            rows={3}
            placeholder="What should change? (optional)"
            aria-label="What should change?"
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                decide("revise", undefined, feedback.trim());
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRevising(false);
              }
            }}
          />
          <div className="permission-actions">
            <button type="button" className="btn" onClick={() => setRevising(false)}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={() => decide("revise", undefined, feedback.trim())}>
              Revise
            </button>
          </div>
        </div>
      )}
      {pending && !revising && (
        <div
          className="permission-foot plan-foot"
          ref={actions}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              if (menu) setMenu(false);
              else setRevising(true);
            }
          }}
        >
          <div className="plan-actions-left">
            <button type="button" className="btn permission-deny" onClick={() => decide("reject")}>
              Reject
            </button>
            <button type="button" className="btn" onClick={() => setRevising(true)} title="Revise (Esc)">
              Revise… <kbd>Esc</kbd>
            </button>
          </div>
          <div className="permission-actions">
            <button type="button" className="btn" onClick={() => decide("accept", "default")} title="Accept (Ctrl+Shift+Enter)">
              Accept <kbd>Ctrl+Shift+Enter</kbd>
            </button>
            <span className="plan-split">
              <button type="button" className="btn btn-primary" onClick={() => decide("accept", "acceptEdits")} title="Accept and allow edits (Ctrl+Enter)">
                Accept and allow edits <kbd>Ctrl+Enter</kbd>
              </button>
              <button
                type="button"
                className="btn btn-primary plan-split-caret"
                aria-label="More ways to accept"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu(!menu)}
              >
                <ChevronDown size={14} aria-hidden />
              </button>
              {menu && (
                <div className="menu plan-menu" role="menu">
                  <button type="button" role="menuitem" className="menu-item" onClick={() => decide("accept", "auto")}>
                    Accept and auto mode
                  </button>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => decide("accept", "bypassPermissions")}>
                    Accept and bypass permissions
                  </button>
                </div>
              )}
            </span>
          </div>
        </div>
      )}
    </section>
  );
});
