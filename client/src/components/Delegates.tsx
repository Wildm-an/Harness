// The child agents that delegate_task starts (the user asked for them): a row with the logo of the agent, the title,
// and the time of the work. The Delegates section of the session rail and the Delegates card of the chat use the
// same row. The hover tip has the agent, the model, and the reasoning. A click opens the chat of the delegate in the
// split pane.

import { createContext, memo, useContext, useEffect, useState } from "react";
import { ChevronRight, Square, Users } from "lucide-react";
import type { ToolItem } from "../chat/state";
import type { HarnessItem } from "../daemon/protocol";
import { delegateCallTitle, delegateElapsed, delegateSessionId, delegateTip, splitDelegates, type RailDelegate } from "../lib/sessionRail";
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

/**
 * A delegate row: the logo of the agent, the title, and the time. The time counts each second while it works. On
 * hover or focus, a delegate that works shows a stop button at the right, as in T3 Code.
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
  const live = d.state === "working" || d.state === "waiting";
  const now = useSeconds(live);
  const agent = sessionAgent({ provider: d.provider, model: d.model }, agents);
  const tip = `${delegateTip(d, agent.name, now)}\nClick to open in split view`;
  return (
    <div className={`rail-delegate-row${live && onStop ? " can-stop" : ""}`}>
      <button type="button" className={`rail-item rail-delegate rail-delegate-${d.state}`} onClick={() => onOpen?.(d.id)} title={tip} aria-label={tip.replace(/\n/g, ". ")}>
        <span className="rail-delegate-logo" aria-hidden>
          <AgentIcon id={agent.id} name={agent.name} icon={agent.icon} size={15} />
        </span>
        <span className="rail-item-text">
          <span className="rail-item-title">{d.title}</span>
        </span>
        {d.state === "waiting" && <span className="rail-dot waiting" aria-hidden />}
        {d.state === "failed" && <span className="rail-dot crashed" aria-hidden />}
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

/** The Delegates section of the rail: the delegates that work, then the ended ones in a folded "Previous agents" group
 * with a count and "{n} failed", as in T3 Code. */
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
              <span className="rail-item-title">Previous agents</span>
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

/** What the Delegates card of the chat needs from the app: the delegates by session id, the agents, and the clicks. */
export interface DelegatesValue {
  find: (sessionId: string) => RailDelegate | null;
  agents: HarnessItem[] | null;
  onOpen: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}

export const DelegatesContext = createContext<DelegatesValue | null>(null);

/**
 * The Delegates card of the chat: one card for the delegate_task calls in a row. Each started delegate has a row, as
 * in the Delegates section of the session rail, and a click opens its chat in the split pane. A call that did not
 * start a delegate yet, or that failed, shows its title with its state.
 */
export const DelegatesCard = memo(function DelegatesCard({ items }: { items: ToolItem[] }) {
  const value = useContext(DelegatesContext);
  const rows = items.map((item) => {
    const id = delegateSessionId(item);
    return { item, id, delegate: id && value ? value.find(id) : null };
  });
  const working = rows.filter((r) => r.delegate && (r.delegate.state === "working" || r.delegate.state === "waiting")).length;
  const count = rows.filter((r) => r.id).length;
  return (
    <section className="delegates-card" aria-label="Delegates">
      <header className="delegates-card-head">
        <Users size={14} aria-hidden />
        <span className="delegates-card-title">Delegates</span>
        <span className="delegates-card-count">{working > 0 ? `${working} working · ${count}` : count}</span>
      </header>
      <ul className="rail-list delegates-card-list">
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
    </section>
  );
});
