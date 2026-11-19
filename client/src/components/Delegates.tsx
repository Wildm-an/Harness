// The subagents: the child agents that delegate_task starts (the user asked for them, and for the name "Subagents").
// A row has the logo of the agent with a state dot, the title, and the time of the work. The Subagents section of the
// session rail and the open Subagents card of the chat use the same row. The hover tip has the agent, the model, and
// the reasoning. A click opens the chat of the subagent in the split pane.

import { createContext, memo, useContext, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Square, Users } from "lucide-react";
import type { ToolItem } from "../chat/state";
import type { HarnessItem } from "../daemon/protocol";
import {
  delegateCallTitle,
  delegateElapsed,
  delegateSessionId,
  delegateTip,
  splitDelegates,
  subagentCount,
  subagentSummary,
  subagentsElapsed,
  type RailDelegate,
  type SubagentCallState,
} from "../lib/sessionRail";
import { AgentIcon } from "./AgentBits";
import { sessionAgent } from "./ThreadRow";

/** A clock in epoch seconds that ticks each second while ``live`` is true. */
function useSeconds(live: boolean): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now() / 1000);
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

const isLive = (d: Pick<RailDelegate, "state">) => d.state === "working" || d.state === "waiting";

/** The words of the state dot on the logo of a subagent. */
const DOT_LABELS: Partial<Record<RailDelegate["state"], string>> = { working: "Working", waiting: "Waiting for approval", failed: "Failed" };

/**
 * A subagent row: the logo of the agent with a state dot (blue: works, yellow: waits for an approval, red: failed), the
 * title, and the time. The time counts each second while it works. On hover or focus, a subagent that works shows a
 * stop button at the right, as in T3 Code.
 */
export function DelegateRow({
  delegate: d,
  agents,
  onOpen,
  onStop,
}: {
  delegate: RailDelegate;
  agents: HarnessItem[] | null;
  onOpen?: (id: string) => void;
  onStop?: (id: string) => void;
}) {
  const live = isLive(d);
  const now = useSeconds(live);
  const agent = sessionAgent({ provider: d.provider, model: d.model }, agents);
  const tip = `${delegateTip(d, agent.name, now)}\nClick to open in split view`;
  const dot = DOT_LABELS[d.state];
  return (
    <div className={`rail-delegate-row${live && onStop ? " can-stop" : ""}`}>
      <button type="button" className={`rail-item rail-delegate rail-delegate-${d.state}`} onClick={() => onOpen?.(d.id)} title={tip} aria-label={tip.replace(/\n/g, ". ")}>
        <span className="rail-delegate-logo" aria-hidden>
          <AgentIcon id={agent.id} name={agent.name} icon={agent.icon} size={16} />
          {dot && <span className={`rail-delegate-dot ${d.state}`} />}
        </span>
        <span className="rail-item-text">
          <span className="rail-item-title">{d.title}</span>
        </span>
        <span className="rail-item-end rail-delegate-time">{delegateElapsed(d, now)}</span>
      </button>
      {live && onStop && (
        <button type="button" className="rail-server-stop rail-delegate-stop" onClick={() => onStop(d.id)} aria-label={`Stop ${d.title}`} title="Stop">
          <Square size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** The Subagents section of the rail: the subagents that work, then the ended ones in a folded "Previous subagents"
 * group with a count and "{n} failed", as in T3 Code. */
export function DelegateList({
  delegates,
  agents,
  onOpen,
  onStop,
}: {
  delegates: RailDelegate[];
  agents: HarnessItem[] | null;
  onOpen?: (id: string) => void;
  onStop?: (id: string) => void;
}) {
  const [showPrevious, setShowPrevious] = useState(false);
  const { active, previous } = splitDelegates(delegates);
  const failed = previous.filter((d) => d.state === "failed").length;
  const row = (d: RailDelegate) => (
    <li key={d.id}>
      <DelegateRow delegate={d} agents={agents} onOpen={onOpen} onStop={onStop} />
    </li>
  );
  return (
    <ul className="rail-list">
      {active.map(row)}
      {previous.length > 0 && (
        <li>
          <button type="button" className="rail-item rail-delegate-previous" aria-expanded={showPrevious} onClick={() => setShowPrevious((v) => !v)}>
            <ChevronRight size={13} aria-hidden className="rail-chevron" />
            <span className="rail-item-text">
              <span className="rail-item-title">Previous subagents</span>
            </span>
            <span className="rail-item-end">
              {previous.length}
              {failed > 0 && <span className="rail-delegate-failed"> · {failed} failed</span>}
            </span>
          </button>
        </li>
      )}
      {showPrevious && previous.map(row)}
    </ul>
  );
}

/** What the Subagents card of the chat needs from the app: the subagents by session id, the agents, and the clicks. */
export interface DelegatesValue {
  find: (sessionId: string) => RailDelegate | null;
  agents: HarnessItem[] | null;
  onOpen: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}

export const DelegatesContext = createContext<DelegatesValue | null>(null);

const MAX_LOGOS = 3; // The logos in the stack of the card, at most.

/**
 * The Subagents card of the chat: one row for the delegate_task calls in a row (the user asked for this look). The
 * row has the logos of the agents in a stack, "{n} subagents" over the state line ("2 working"), the time of the
 * group, and an arrow. The arrow opens the list: one row for each subagent, as in the Subagents section of the rail.
 * A call that did not start its subagent yet, or that failed, shows its title with its state.
 */
export const DelegatesCard = memo(function DelegatesCard({ items }: { items: ToolItem[] }) {
  const value = useContext(DelegatesContext);
  const [open, setOpen] = useState(false);
  const rows = items.map((item) => {
    const id = delegateSessionId(item);
    return { item, id, delegate: id && value ? value.find(id) : null };
  });
  const started = rows.flatMap((r) => (r.delegate ? [r.delegate] : []));
  const states: SubagentCallState[] = rows.map((r) => r.delegate?.state ?? (r.item.status === "error" ? "notStarted" : "starting"));
  const live = states.some((s) => s === "working" || s === "waiting" || s === "starting");
  const now = useSeconds(live);
  // One logo for each agent, in the order of the calls.
  const agentsOf = started.map((d) => sessionAgent({ provider: d.provider, model: d.model }, value?.agents ?? null));
  const shownLogos = [...new Map(agentsOf.map((a) => [a.id, a])).values()].slice(0, MAX_LOGOS);
  const title = subagentCount(rows.length);
  const summary = subagentSummary(states);
  const listId = `subagents-${items[0]?.id ?? "card"}`;
  return (
    <section className="subagents-card" aria-label="Subagents">
      <button type="button" className="subagents-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <span className="subagents-logos" aria-hidden>
          {shownLogos.length > 0 ? (
            shownLogos.map((a) => (
              <span key={a.id} className="subagents-logo">
                <AgentIcon id={a.id} name={a.name} icon={a.icon} size={14} />
              </span>
            ))
          ) : (
            <span className="subagents-logo">
              <Users size={13} />
            </span>
          )}
        </span>
        <span className="subagents-text">
          <span className="subagents-title">{title}</span>
          <span className={`subagents-summary${live ?" working" : ""}`}>{summary}</span>
        </span>
        <span className="subagents-time">{subagentsElapsed(started, now)}</span>
        <ChevronDown size={14} aria-hidden className="subagents-chevron" />
      </button>
      {open && (
        <ul id={listId} className="rail-list subagents-list">
          {rows.map(({ item, id, delegate }) => (
            <li key={item.id}>
              {delegate ? (
                <DelegateRow delegate={delegate} agents={value?.agents ?? null} onOpen={value?.onOpen} onStop={value?.onStop} />
              ) : (
                <button
                  type="button"
                  className="rail-item rail-delegate rail-delegate-pending"
                  disabled={!id || !value}
                  onClick={() => id && value?.onOpen(id)}
                  title={id ? "Click to open in split view" : undefined}
                >
                  <span className="rail-delegate-logo" aria-hidden>
                    <Users size={14} />
                  </span>
                  <span className="rail-item-text">
                    <span className="rail-item-title">{delegateCallTitle(item)}</span>
                  </span>
                  <span className="rail-item-end rail-delegate-time">{item.status === "error" ? "Did not start" : id ? "" : "Starting…"}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});
