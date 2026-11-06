// The question card of ask_user_question (daemon tools/interact.py, docs/UI_RULES.md M14): one question at a
// time, the options with number badges, "Something else" for an answer of the user's own, "Skip", and
// "Next" / "Submit" with "{current} of {total}". An option can have a preview (a mockup or code): the card then
// shows the preview of the option under the pointer or the focus next to the options, and a notes field.

import { memo, useEffect, useRef, useState } from "react";
import { Check, Clock, MessageCircleQuestion, SkipForward } from "lucide-react";
import type { AskQuestion } from "../daemon/protocol";
import type { QuestionItem } from "../chat/state";
import { Markdown } from "./Markdown";
import { usePromptInputId } from "../lib/split";

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

/** The notes of the questions that have an answer. A note of a skipped question does not go to the agent. */
export function collectNotes(answers: Record<string, string>, notes: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [q, note] of Object.entries(notes)) if (answers[q] && note.trim()) out[q] = note.trim();
  return out;
}

/** The option whose preview shows: the option under the pointer or the focus, else the first picked option, else the first option. */
export function previewOption(options: AskQuestion["options"], looking: string | null, picked: string[]): AskQuestion["options"][number] | undefined {
  return options.find((o) => o.label === looking) ?? options.find((o) => picked.includes(o.label)) ?? options[0];
}

/** A preview with a Markdown code fence shows as Markdown. Other text shows as it is, in monospace. */
function Preview({ text }: { text: string }) {
  if (text.includes("```")) return <Markdown text={text} />;
  return <pre>{text}</pre>;
}

export const QuestionCard = memo(function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionItem;
  onAnswer: (requestId: string, answers: Record<string, string> | null, notes?: Record<string, string>) => void;
}) {
  const done = item.answers !== undefined || item.expired === true;
  const [at, setAt] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [looking, setLooking] = useState<string | null>(null); // The option under the pointer or the focus.
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

  const promptId = usePromptInputId();
  const finish = (answers: Record<string, string> | null) => {
    const kept = answers ? collectNotes(answers, notes) : {};
    onAnswer(item.id, answers, Object.keys(kept).length ? kept : undefined);
    document.getElementById(promptId)?.focus({ preventScroll: true });
  };

  const submit = (nextPicks = picks) => finish(collectAnswers(item.questions, nextPicks, others));

  const next = (nextPicks = picks) => {
    if (at < total - 1) {
      setAt(at + 1);
      setLooking(null);
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
    // One choice: go on at once. With previews the user can compare and add a note first, so Next goes on.
    if (!q.options.some((o) => o.preview)) next(nextPicks);
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
                <dd>
                  {item.answers?.[x.question] ?? "Skipped"}
                  {item.notes?.[x.question] && <span className="question-note">Note: {item.notes[x.question]}</span>}
                </dd>
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
  const hasPreview = q.options.some((o) => o.preview);
  const shown = hasPreview ? previewOption(q.options, looking, chosen) : undefined;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (e.ctrlKey || e.metaKey || e.altKey || tag === "INPUT" || tag === "TEXTAREA") return;
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
        <div className={hasPreview ? "question-split" : undefined}>
        <ul className="question-options" role={q.multiSelect ? "group" : "radiogroup"} onMouseLeave={() => setLooking(null)}>
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
                  onMouseEnter={() => setLooking(o.label)}
                  onFocus={() => setLooking(o.label)}
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
        {hasPreview && (
          <div className="question-preview-side">
            <div className="question-preview" aria-live="polite" aria-label={shown ? `Preview: ${shown.label}` : "Preview"}>
              {shown?.preview ? <Preview text={shown.preview} /> : <p className="question-preview-empty">No preview for this option.</p>}
            </div>
            <textarea
              className="setting-textarea question-notes"
              rows={2}
              value={notes[q.question] ?? ""}
              placeholder="Add notes (optional)"
              aria-label="Notes for this answer"
              onChange={(e) => setNotes({ ...notes, [q.question]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && hasAnswer) {
                  e.preventDefault();
                  next();
                }
              }}
            />
          </div>
        )}
        </div>
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
