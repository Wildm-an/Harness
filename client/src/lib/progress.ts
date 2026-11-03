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

/**
 * The plan to show: the newest update_plan of the conversation, if it is from the current turn
 * or still has steps that are not completed. A finished plan of an older turn does not show.
 */
export function latestPlan(items: ChatItem[]): PlanStep[] | null {
  const turnStart = lastUserIndex(items);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "tool" || item.name !== "update_plan" || item.status === "error") continue;
    const steps = planSteps(item.input);
    if (!steps) continue;
    if (i > turnStart || steps.some((s) => s.status !== "completed")) return steps;
    return null;
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
