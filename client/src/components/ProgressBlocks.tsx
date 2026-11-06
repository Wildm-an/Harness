// The task list and the end-of-turn box of the agent, as in Claude Code (lib/progress.ts).

import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, CircleCheck, CircleEllipsis, LoaderCircle } from "lucide-react";
import type { PlanStep, WrapUp } from "../lib/progress";
import { formatElapsed } from "./WorkingLine";

/**
 * The plan of the agent: a check mark for a completed step, a spinner for the step in progress, a
 * dashed circle for the rest. A completed step shows its time at the right. A finished plan folds
 * into one line with the total time. A click on the line opens it.
 */
export function PlanBlock({
  steps,
  running,
  finished,
  stale = false,
  times = [],
  total = null,
}: {
  steps: PlanStep[];
  running: boolean;
  finished: boolean;
  stale?: boolean;
  times?: (number | null)[];
  total?: number | null;
}) {
  const done = steps.filter((s) => s.status === "completed").length;
  const [open, setOpen] = useState(!finished);
  useEffect(() => setOpen(!finished), [finished]);
  if (finished && !open) {
    return (
      <button type="button" className="plan-folded" aria-expanded={false} onClick={() => setOpen(true)} title="Show the steps">
        <CircleCheck size={16} aria-hidden className="plan-icon" />
        <span className="plan-text">
          Plan finished · {steps.length} {steps.length === 1 ? "step" : "steps"}
        </span>
        {total !== null && <span className="plan-time">{formatElapsed(total)}</span>}
        <ChevronRight size={14} aria-hidden className="plan-chevron" />
      </button>
    );
  }
  return (
    <div className="plan-block" role="list" aria-label={`Plan: ${done} of ${steps.length} steps completed`}>
      {/* The user wrote after this plan: the agent can change it. As in Claude Code. */}
      {stale && !finished && <p className="plan-stale">Plan from before your last message</p>}
      {finished && (
        <button type="button" className="plan-fold" aria-expanded onClick={() => setOpen(false)} title="Hide the steps">
          <span>Plan finished</span>
          <ChevronRight size={14} aria-hidden className="plan-chevron open" />
          {total !== null && <span className="plan-time">{formatElapsed(total)}</span>}
        </button>
      )}
      {steps.map((step, i) => (
        <div key={i} role="listitem" className={`plan-step ${step.status}`}>
          {step.status === "completed" ? (
            <CircleCheck size={16} aria-hidden className="plan-icon" />
          ) : step.status === "in_progress" && stale ? (
            <CircleEllipsis size={16} aria-hidden className="plan-icon paused" />
          ) : step.status === "in_progress" && running ? (
            <LoaderCircle size={16} aria-hidden className="plan-icon spin" />
          ) : (
            <span className={`plan-icon plan-circle${step.status === "pending" ? " dashed" : ""}`} aria-hidden />
          )}
          <span className="plan-text">{step.content}</span>
          {times[i] != null && <span className="plan-time">{formatElapsed(times[i] as number)}</span>}
          <span className="sr-only">
            {step.status === "completed" ? " (completed)" : step.status === "in_progress" ? " (in progress)" : " (pending)"}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The box at the end of a turn: the recap, and a question with answer buttons. A button sends its
 * message as the next prompt. A finished plan of the turn shows at the top of the box, so the plan and
 * the recap are one card.
 */
export function WrapUpBox({ wrap, disabled, onAction, plan }: { wrap: WrapUp; disabled: boolean; onAction: (message: string) => void; plan?: ReactNode }) {
  return (
    <section className={`wrapup-box${plan ? " with-plan" : ""}`} aria-label="Next step">
      {plan && <div className="wrapup-plan">{plan}</div>}
      <p className="wrapup-recap">{wrap.recap}</p>
      {wrap.ask && <p className="wrapup-ask">{wrap.ask}</p>}
      {wrap.actions.length > 0 && (
        <div className="wrapup-actions">
          {wrap.actions.map((a, i) => (
            <button
              key={i}
              type="button"
              className={`btn btn-small${i === 0 ? " btn-primary" : ""}`}
              disabled={disabled}
              title={a.message !== a.label ? a.message : undefined}
              onClick={() => onAction(a.message)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
