// The popup at the bottom right while "Update agents automatically" downloads new versions of agents
// (Settings > Agents, the user asked for this popup). Each agent of the update has its own row: its logo,
// its name, the versions, the stage, and a progress bar. The rows stack in one popup when more than one agent
// updates at the same time. The daemon sends harnesses.updating to each window when a stage changes.
//
// The popup hides 6 seconds after all the updates are done, but not while the pointer or the focus is on it.
// A failed update stays until the user closes the popup. The X (or Esc) hides the popup: the updates go on.

import { useEffect, useRef, useState } from "react";
import { ArrowRight, CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import type { DaemonConnection } from "../daemon/connection";
import type { AgentUpdateItem } from "../daemon/protocol";
import { AgentIcon } from "./AgentBits";
import { CloseButton } from "./VersionWarning";

const DONE_MS = 6000;

/** The title of the popup: "Updating 3 agents", "Claude Agent updated", "1 agent update failed". */
export function agentUpdatesTitle(items: AgentUpdateItem[]): string {
  const active = items.some((i) => i.state === "waiting" || i.state === "running");
  const failed = items.filter((i) => i.state === "failed").length;
  if (active) return items.length === 1 ? `Updating ${items[0].name}` : `Updating ${items.length} agents`;
  if (failed > 0) return failed === 1 ? (items.length === 1 ? `${items[0].name} did not update` : "1 agent update failed") : `${failed} agent updates failed`;
  return items.length === 1 ? `${items[0].name} updated` : "Agents updated";
}

/** The percent of a download, or null when the size is not known or no download runs (npm, unpacking). */
export function agentUpdatePercent(item: AgentUpdateItem): number | null {
  if (item.state !== "running" || item.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((item.received / item.total) * 100)));
}

/** The status line of a row: "Waiting", "Downloading 45%", "Installing with npm", "Updated", or the error. */
export function agentUpdateStage(item: AgentUpdateItem): string {
  if (item.state === "done") return item.to ? `Updated to ${item.to}` : "Updated";
  if (item.state === "failed") return item.error || "The update failed.";
  if (item.state === "waiting") return "Waiting";
  const percent = agentUpdatePercent(item);
  return percent === null ? item.stage : `${item.stage} ${percent}%`;
}

/** A key for one update: a new update (other agents or versions) shows the popup again after the X. */
function batchKey(items: AgentUpdateItem[]): string {
  return items.map((i) => `${i.id}@${i.to ?? ""}`).join(",");
}

export function AgentUpdatesToast({ conn, onOpen }: {
  conn: DaemonConnection;
  onOpen: () => void; // Open Settings > Agents.
}) {
  const [items, setItems] = useState<AgentUpdateItem[]>([]);
  const [closed, setClosed] = useState<string | null>(null); // The update that the user closed.
  const [paused, setPaused] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setItems([]);
    return conn.onMessage((msg) => {
      if (msg.type === "harnesses.updating") setItems(msg.items);
    });
  }, [conn]);

  const key = batchKey(items);
  const active = items.some((i) => i.state === "waiting" || i.state === "running");
  const failed = items.some((i) => i.state === "failed");
  const shown = items.length > 0 && closed !== key;

  // Hide the popup DONE_MS after the last update, when all of them are done. The time starts again when the
  // pointer or the focus leaves the popup. A failed update stays until the user closes it.
  useEffect(() => {
    if (!shown || active || failed || paused) return;
    const timer = window.setTimeout(() => setClosed(key), DONE_MS);
    return () => window.clearTimeout(timer);
  }, [shown, active, failed, paused, key]);

  if (!shown) return null;
  const Icon = active ? LoaderCircle : failed ? TriangleAlert : CircleCheck;
  const state = active ? "running" : failed ? "failed" : "done";
  return (
    <div
      ref={box}
      className={`update-toast agent-updates agent-updates-${state}`}
      role={failed && !active ? "alert" : "status"}
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node)) setPaused(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && setClosed(key)}
    >
      <Icon size={18} aria-hidden className={`update-toast-icon${active ? " spin" : ""}`} />
      <div className="update-toast-text">
        <span className="update-toast-title">{agentUpdatesTitle(items)}</span>
        <ul className="agent-updates-list" aria-label="Agent updates">
          {items.map((item) => (
            <AgentUpdateRow key={item.id} item={item} />
          ))}
        </ul>
        {failed && !active && (
          <div className="update-toast-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setClosed(key);
                onOpen();
              }}
            >
              Open Settings
            </button>
          </div>
        )}
      </div>
      <CloseButton onClose={() => setClosed(key)} />
    </div>
  );
}

function AgentUpdateRow({ item }: { item: AgentUpdateItem }) {
  const percent = agentUpdatePercent(item);
  const busy = item.state === "waiting" || item.state === "running";
  return (
    <li className={`agent-update-row agent-update-${item.state}`}>
      <AgentIcon id={item.id} name={item.name} icon={item.icon} size={18} />
      <div className="agent-update-main">
        <div className="agent-update-head">
          <span className="agent-update-name">{item.name}</span>
          {item.from && item.to && (
            <span className="agent-update-version">
              {item.from} <ArrowRight size={11} aria-label="to" /> {item.to}
            </span>
          )}
        </div>
        {busy && (
          <div
            className={`update-toast-track${item.state === "running" && percent === null ? " indeterminate" : ""}`}
            role="progressbar"
            aria-label={`${item.name} update progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
          >
            <div className="update-toast-bar" style={percent === null ? undefined : { width: `${percent}%` }} />
          </div>
        )}
        <span className="agent-update-stage">
          {item.state === "done" && <CircleCheck size={12} aria-hidden />}
          {item.state === "failed" && <TriangleAlert size={12} aria-hidden />}
          {agentUpdateStage(item)}
        </span>
      </div>
    </li>
  );
}
