// The working line at the bottom of the chat during a turn, as in the Claude app: animated dots, what the
// agent does now (the step of its task list in progress, or "Writing…"), and the time of the turn. The caret
// shows the details: "1.1k tokens · 1 running task · Waiting for qwen3…". It scrolls with the chat.

import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChatItem, TurnInfo } from "../chat/state";
import { latestPlan } from "../lib/progress";
import { toolLabel } from "./ToolCard";

/** "8s", "1m 11s", or "1h 2m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "950 tokens", "1.1k tokens", or "12k tokens". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n} ${n === 1 ? "token" : "tokens"}`;
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k tokens`;
}

import { modelName } from "../lib/modelName";

export { modelName };

/** The output tokens of the turn: the count of the endpoint, and an estimate for the reply that streams now. */
export function turnTokens(turn: TurnInfo | null, items: ChatItem[]): number {
  const last = items[items.length - 1];
  const streaming = last?.kind === "assistant" && last.streaming ? Math.ceil(last.text.length / 4) : 0;
  return (turn?.tokens ?? 0) + streaming;
}

/** The running tool calls, and the text for what the agent does now. */
export function workingStatus(items: ChatItem[], model: string): { tasks: number; text: string } {
  const running = items.filter((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool" && i.status === "running");
  const waiting = items.some((i) => i.kind === "permission" && !i.decision && !i.expired);
  const asking = items.some((i) => (i.kind === "question" && i.answers === undefined && !i.expired) || (i.kind === "plan" && !i.decision && !i.expired));
  const last = items[items.length - 1];
  let text: string;
  if (asking) text = "Waiting for your answer…";
  else if (waiting) text = "Waiting for your approval…";
  else if (running.length > 0) text = `Running ${toolLabel(running[running.length - 1].name)}…`;
  else if (last?.kind === "assistant" && last.streaming) text = "Writing…";
  else text = `Waiting for ${modelName(model)}…`;
  return { tasks: running.length, text };
}

/** The step of the task list of this turn that is in progress, or null. */
export function currentStep(items: ChatItem[]): string | null {
  const plan = latestPlan(items);
  if (!plan?.current) return null;
  return plan.steps.find((s) => s.status === "in_progress")?.content ?? null;
}

export function WorkingLine({ turn, items, model }: { turn: TurnInfo | null; items: ChatItem[]; model: string }) {
  const mounted = useRef(Date.now()); // A turn with no start time (for example a skill) counts from here.
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { tasks, text } = workingStatus(items, model);
  const step = currentStep(items);
  // A question or a permission is more important than the step: the user must act.
  const label = step && !text.startsWith("Waiting for your") ? step : text;
  const details = [formatTokens(turnTokens(turn, items))];
  if (tasks > 0) details.push(`${tasks} running ${tasks === 1 ? "task" : "tasks"}`);
  if (label !== text) details.push(text);

  return (
    <div className="working" title="Esc to interrupt">
      <span className="working-dots" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </span>
      <span className="working-text" aria-hidden>
        {label}
      </span>
      <span className="working-time" aria-hidden>
        {formatElapsed(now - (turn?.startedAt ?? mounted.current))}
      </span>
      <button
        type="button"
        className={`working-more${open ? " open" : ""}`}
        aria-expanded={open}
        aria-label={open ? "Hide the details" : "Show the details"}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={13} aria-hidden />
      </button>
      {open && (
        <span className="working-details" aria-hidden>
          {details.join(" · ")}
        </span>
      )}
      {/* Screen readers get the status only, not the time each second. */}
      <span className="sr-only" role="status">
        {label}
      </span>
    </div>
  );
}
