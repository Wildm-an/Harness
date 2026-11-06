// The task list and the end-of-turn box of the agent, as in Claude Code (daemon tools/progress.py).
// The agent calls update_plan with its steps, and wrap_up at the end of a turn. The chat does not
// show these calls as tool rows. It draws the latest plan under the messages, and the box of the
// last turn with its answer buttons.

import type { ChatItem } from "../chat/state";

export const PROGRESS_TOOLS = new Set(["update_plan", "wrap_up"]);

export type StepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  content: string;
  status: StepStatus;
}

export interface WrapUp {
  id: string;
  recap: string;
  ask: string | null;
  actions: { label: string; message: string }[];
}

/** True for the tools that the chat draws as blocks, not as tool rows. */
export function isProgressTool(name: string): boolean {
  return PROGRESS_TOOLS.has(name);
}

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The steps of an update_plan call, or null if its input is bad. */
export function planSteps(input: unknown): PlanStep[] | null {
  const items = record(input)?.items;
  if (!Array.isArray(items)) return null;
  const steps = items
    .map((i) => {
      const r = record(i);
      const status = r?.status;
      const content = text(r?.content);
      if (!content || (status !== "pending" && status !== "in_progress" && status !== "completed")) return null;
      return { content, status } as PlanStep;
    })
    .filter((s): s is PlanStep => s !== null);
  return steps.length ? steps : null;
}

/** The index of the last user message, or -1. */
function lastUserIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === "user") return i;
  return -1;
}

// The texts that show an interrupted turn: the notice of the chat, and the result of a tool call
// that the interrupt stopped (daemon agent.py INTERRUPTED). The tool result stays after a reload.
const INTERRUPT_NOTICE = "The turn was interrupted.";
const INTERRUPT_OUTPUT = "The user interrupted the turn.";

function isInterrupt(item: ChatItem): boolean {
  if (item.kind === "notice") return item.text === INTERRUPT_NOTICE;
  return item.kind === "tool" && item.status === "error" && (item.output ?? "").startsWith(INTERRUPT_OUTPUT);
}

/** The plan to show, and if it is from the current turn. */
export interface ShownPlan {
  steps: PlanStep[];
  current: boolean; // False: the plan of an older turn. Its step in progress shows no spinner.
  // All steps are completed, or the agent called wrap_up after the plan (wrap_up checks off the
  // task list, as in Claude Code). The chat folds the list into one line.
  finished: boolean;
  times: (number | null)[]; // The time of each completed step (ms). null: not completed, or no time.
  total: number | null; // A finished plan: the time from the first plan of the turn to the end (ms).
}

/** The end time of a tool call (epoch ms), or null for a call with no time (an old session). */
const endTime = (item: ChatItem): number | null => (item.kind === "tool" && typeof item.ts === "number" ? item.ts : null);

/**
 * The time of each step of the plan at items[at], and the total time of a finished plan.
 * The calls of update_plan in the turn give the times. A step starts at the first call that shows it
 * in progress, or else at the call before the one that completes it. It ends at the first call that
 * completes it. A step in progress at a wrap_up ends at the wrap_up. Steps are matched by their text.
 */
export function stepTimes(items: ChatItem[], at: number, turnStart: number, finished: boolean): { times: (number | null)[]; total: number | null } {
  const steps = planSteps((items[at] as Extract<ChatItem, { kind: "tool" }>).input) ?? [];
  const start = new Map<string, number>();
  const end = new Map<string, number>();
  let first: number | null = null;
  let previous: number | null = null;
  for (let i = turnStart + 1; i <= at; i++) {
    const item = items[i];
    if (item.kind !== "tool" || item.name !== "update_plan" || item.status === "error") continue;
    const t = endTime(item);
    const calls = planSteps(item.input);
    if (t === null || !calls) continue;
    first ??= t;
    for (const s of calls) {
      if (s.status === "in_progress" && !start.has(s.content)) start.set(s.content, t);
      if (s.status === "completed" && !end.has(s.content)) {
        end.set(s.content, t);
        if (!start.has(s.content) && previous !== null) start.set(s.content, previous);
      }
    }
    previous = t;
  }
  let finish: number | null = null;
  if (finished) {
    const wrap = items.slice(at + 1).find((t) => t.kind === "tool" && t.name === "wrap_up" && t.status !== "error");
    finish = wrap ? endTime(wrap) : endTime(items[at]);
    if (wrap && finish !== null) for (const s of steps) if (s.status === "in_progress" && !end.has(s.content)) end.set(s.content, finish);
  }
  const times = steps.map((s) => {
    const a = start.get(s.content);
    const b = end.get(s.content);
    return a !== undefined && b !== undefined && (s.status === "completed" || finished) ? Math.max(0, b - a) : null;
  });
  const total = finish !== null && first !== null ? Math.max(0, finish - first) : null;
  return { times, total };
}

/**
 * The plan to show: the newest update_plan of the conversation.
 * - A plan of the current turn always shows.
 * - A plan of an older turn shows only if it has steps that are not completed and its turn was not
 *   interrupted. It shows with no spinner, because the current turn did not continue it yet.
 */
export function latestPlan(items: ChatItem[]): ShownPlan | null {
  const turnStart = lastUserIndex(items);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "tool" || item.name !== "update_plan" || item.status === "error") continue;
    const steps = planSteps(item.input);
    if (!steps) continue;
    if (i > turnStart) {
      const wrapped = items.slice(i + 1).some((t) => t.kind === "tool" && t.name === "wrap_up" && t.status !== "error");
      const finished = wrapped || steps.every((s) => s.status === "completed");
      return { steps, current: true, finished, ...stepTimes(items, i, turnStart, finished) };
    }
    if (steps.every((s) => s.status === "completed")) return null;
    if (items.slice(i + 1, turnStart).some(isInterrupt)) return null;
    let planTurn = i - 1;
    while (planTurn >= 0 && items[planTurn].kind !== "user") planTurn--;
    return { steps, current: false, finished: false, ...stepTimes(items, i, planTurn, false) };
  }
  return null;
}

/** The box of the current turn: its last wrap_up call. None from an older turn. */
export function latestWrapUp(items: ChatItem[]): WrapUp | null {
  const turnStart = lastUserIndex(items);
  for (let i = items.length - 1; i > turnStart; i--) {
    const item = items[i];
    if (item.kind !== "tool" || item.name !== "wrap_up" || item.status === "error") continue;
    const input = record(item.input);
    const recap = text(input?.recap);
    if (!recap) return null;
    const ask = text(input?.ask) || null;
    const actions = (Array.isArray(input?.actions) ? input.actions : [])
      .map((a) => {
        const r = record(a);
        const label = text(r?.label);
        return label ? { label, message: text(r?.message) || label } : null;
      })
      .filter((a): a is { label: string; message: string } => a !== null)
      .slice(0, 2);
    return { id: item.id, recap, ask, actions: ask ? actions : [] };
  }
  return null;
}
