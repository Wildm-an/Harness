// The question card of ask_user_question (daemon tools/interact.py, docs/UI_RULES.md M14): one question at a
// time, the options with number badges, "Something else" for an answer of the user's own, "Skip", and
// "Next" / "Submit" with "{current} of {total}".

import { memo, useEffect, useRef, useState } from "react";
import { Check, Clock, MessageCircleQuestion, SkipForward } from "lucide-react";
import type { AskQuestion } from "../daemon/protocol";
import type { QuestionItem } from "../chat/state";

/** The answer text of one question: the picked labels, then the text of "Something else". */
export function answerText(picked: string[], other: string): string {
  return [...picked, other.trim()].filter(Boolean).join(", ");
}

/** The answers of all questions, by question text. A question with no answer is not in the result. */
export function collectAnswers(questions: AskQuestion[], picks: Record<string, string[]>, others: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const text = answerText(picks[q.question] ?? [], others[q.question] ?? "");
    if (text) out[q.question] = text;
  }
  return out;
}

export const QuestionCard = memo(function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionItem;
  onAnswer: (requestId: string, answers: Record<string, string> | null) => void;
}) {
  const done = item.answers !== undefined || item.expired === true;
  const [at, setAt] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const box = useRef<HTMLDivElement>(null);
  const otherInput = useRef<HTMLInputElement>(null);
  const total = item.questions.length;
  const q = item.questions[Math.min(at, total - 1)];

  // A new card takes the focus, so that the number keys answer it. It never takes the focus from a text field.
  useEffect(() => {
    if (done) return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest("input, textarea, select, [contenteditable='true']")) return;
    box.current?.focus({ preventScroll: true });
  }, [done]);

  useEffect(() => {
    if (q && otherOpen[q.question]) otherInput.current?.focus();
  }, [at, q, otherOpen]);

  const finish = (answers: Record<string, string> | null) => {
    onAnswer(item.id, answers);
    document.getElementById("prompt-input")?.focus({ preventScroll: true });
  };

  const submit = (nextPicks = picks) => finish(collectAnswers(item.questions, nextPicks, others));

  const next = (nextPicks = picks) => {
    if (at < total - 1) {
      setAt(at + 1);
      box.current?.focus({ preventScroll: true });
    } else {
      submit(nextPicks);
    }
  };

  const pick = (label: string) => {
    if (!q) return;
    const current = picks[q.question] ?? [];
    if (q.multiSelect) {
      const chosen = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
      setPicks({ ...picks, [q.question]: chosen });
      return;
    }
    const nextPicks = { ...picks, [q.question]: [label] };
    setPicks(nextPicks);
    setOtherOpen({ ...otherOpen, [q.question]: false });
    setOthers({ ...others, [q.question]: "" });
    next(nextPicks); // One choice: go on at once.
  };

  const openOther = () => {
    if (!q) return;
    setOtherOpen({ ...otherOpen, [q.question]: true });
    if (!q.multiSelect) setPicks({ ...picks, [q.question]: [] });
  };

  if (done) {
    return (
      <section className="permission-card decided question-card" aria-label="Questions">
        <header className="permission-head">
          <MessageCircleQuestion size={16} aria-hidden />
          <span className="permission-head-title">{total === 1 ? item.questions[0]?.question : `${total} questions`}</span>
          {item.answers === null ? (
            <span className="permission-outcome expired">
              <SkipForward size={14} aria-hidden /> Skipped
            </span>
          ) : item.answers ? (
            <span className="permission-outcome allowed">
              <Check size={14} aria-hidden /> Answered
            </span>
          ) : (
            <span className="permission-outcome expired">
              <Clock size={14} aria-hidden /> No answer
            </span>
          )}
        </header>
        {item.answers && (
          <dl className="question-answers">
            {item.questions.map((x) => (
              <div key={x.question}>
                <dt>{x.header}</dt>
                <dd>{item.answers?.[x.question] ?? "Skipped"}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    );
  }

  if (!q) return null;
  const chosen = picks[q.question] ?? [];
  const other = others[q.question] ?? "";
  const hasAnswer = chosen.length > 0 || other.trim().length > 0;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).tagName === "INPUT") return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= q.options.length) {
      e.preventDefault();
      pick(q.options[n - 1].label);
    } else if (Number.isInteger(n) && n === q.options.length + 1) {
      e.preventDefault();
      openOther();
    } else if (e.key === "Enter" && hasAnswer) {
      e.preventDefault();
      next();
    }
  };

  return (
    <section className="permission-card question-card" aria-label="Questions">
      <header className="permission-head">
        <MessageCircleQuestion size={16} aria-hidden />
        <span className="question-chip">{q.header}</span>
        <span id={`question-${item.id}`} className="permission-head-title question-text">
          {q.question}
        </span>
      </header>
      <div className="question-body" ref={box} tabIndex={-1} onKeyDown={onKeyDown} role="group" aria-labelledby={`question-${item.id}`}>
        <ul className="question-options" role={q.multiSelect ? "group" : "radiogroup"}>
          {q.options.map((o, i) => {
            const on = chosen.includes(o.label);
            return (
              <li key={o.label}>
                <button
                  type="button"
                  className={`question-option${on ? " selected" : ""}`}
                  role={q.multiSelect ? "checkbox" : "radio"}
                  aria-checked={on}
                  onClick={() => pick(o.label)}
                >
                  <span className="question-number" aria-hidden>
                    {on && q.multiSelect ? <Check size={12} /> : i + 1}
                  </span>
                  <span className="question-option-text">
                    <span className="question-label">{o.label}</span>
                    {o.description && <span className="question-description">{o.description}</span>}
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            {otherOpen[q.question] ? (
              <div className="question-option question-other selected">
                <span className="question-number" aria-hidden>
                  {q.options.length + 1}
                </span>
                <input
                  ref={otherInput}
                  className="question-other-input"
                  value={other}
                  placeholder="Something else"
                  aria-label="Something else"
                  onChange={(e) => setOthers({ ...others, [q.question]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && hasAnswer) {
                      e.preventDefault();
                      next();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setOtherOpen({ ...otherOpen, [q.question]: false });
                      setOthers({ ...others, [q.question]: "" });
                      box.current?.focus();
                    }
                  }}
                />
              </div>
            ) : (
              <button type="button" className="question-option" onClick={openOther}>
                <span className="question-number" aria-hidden>
                  {q.options.length + 1}
                </span>
                <span className="question-option-text">
                  <span className="question-label muted">Something else</span>
                </span>
              </button>
            )}
          </li>
        </ul>
        <div className="permission-foot">
          {total > 1 && (
            <span className="permission-scope">
              {at + 1} of {total}
            </span>
          )}
          <div className="permission-actions">
            {at > 0 && (
              <button type="button" className="btn" onClick={() => setAt(at - 1)}>
                Back
              </button>
            )}
            <button type="button" className="btn" onClick={() => finish(null)}>
              Skip
            </button>
            <button type="button" className="btn btn-primary" disabled={!hasAnswer} onClick={() => next()}>
              {at < total - 1 ? "Next" : "Submit"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
});
