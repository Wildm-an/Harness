// The task list and the end-of-turn box of the agent, as in Claude Code (lib/progress.ts).

import { CircleCheck, LoaderCircle } from "lucide-react";
import type { PlanStep, WrapUp } from "../lib/progress";

/** The plan of the agent: a check mark for a completed step, a spinner for the step in progress, a dashed circle for the rest. */
export function PlanBlock({ steps, running }: { steps: PlanStep[]; running: boolean }) {
  const done = steps.filter((s) => s.status === "completed").length;
  return (
    <div className="plan-block" role="list" aria-label={`Plan: ${done} of ${steps.length} steps completed`}>
      {steps.map((step, i) => (
        <div key={i} role="listitem" className={`plan-step ${step.status}`}>
          {step.status === "completed" ? (
            <CircleCheck size={16} aria-hidden className="plan-icon" />
          ) : step.status === "in_progress" && running ? (
            <LoaderCircle size={16} aria-hidden className="plan-icon spin" />
          ) : (
            <span className={`plan-icon plan-circle${step.status === "pending" ? " dashed" : ""}`} aria-hidden />
          )}
          <span className="plan-text">{step.content}</span>
          <span className="sr-only">
            {step.status === "completed" ? " (completed)" : step.status === "in_progress" ? " (in progress)" : " (pending)"}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The box at the end of a turn: the recap, and a question with answer buttons. A button sends its message as the next prompt. */
export function WrapUpBox({ wrap, disabled, onAction }: { wrap: WrapUp; disabled: boolean; onAction: (message: string) => void }) {
  return (
    <section className="wrapup-box" aria-label="Next step">
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
