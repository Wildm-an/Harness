// The page of an empty browser tab, as in the Claude app: a block with the dev servers of the project
// (.harness/launch.json). The play button starts a server, and the tab opens it when it runs.

import { useEffect, useRef, useState } from "react";
import { FileCog, LoaderCircle, Play, Server, SquareArrowOutUpRight } from "lucide-react";
import type { ChatItem } from "../chat/state";
import type { Decision, ServerItem } from "../daemon/protocol";
import type { ServersApi } from "../servers/useServers";

// The server of a new launch.json when the harness finds no server in the project.
const TEMPLATE = { name: "web", command: "npm run dev", port: 3000, default: true };

/** The servers that started from the block and now run: the tab opens them. */
export function serversToOpen(waiting: readonly string[], servers: readonly ServerItem[]): ServerItem[] {
  return servers.filter((s) => waiting.includes(s.name) && s.state === "running" && !!s.url);
}

/**
 * The servers that the block waits for after a change of the list. ``seen``: the servers that
 * were "starting" after the click. A server that runs, crashes, or stops after it was starting
 * leaves the list. A server that is still "stopped" just after the click stays: the start comes next.
 */
export function stillWaiting(waiting: readonly string[], seen: ReadonlySet<string>, servers: readonly ServerItem[]): string[] {
  return waiting.filter((name) => {
    const s = servers.find((x) => x.name === name);
    // A running server stays until its URL is known: then the tab opens it.
    if (!s || (s.state === "running" && !!s.url) || s.state === "crashed") return false;
    return !(s.state === "stopped" && seen.has(name));
  });
}

/** A question of the daemon before the first start of a server command (tool "server"). */
export interface ServerApproval {
  requestId: string;
  name: string;
  command: string;
  rule: string | null;
}

/** The server questions of the chat that wait for a decision. */
export function pendingServerApprovals(items: readonly ChatItem[]): ServerApproval[] {
  const out: ServerApproval[] = [];
  for (const i of items) {
    if (i.kind !== "permission" || i.tool !== "server" || i.decision || i.expired) continue;
    const input = (i.input ?? {}) as { name?: unknown; command?: unknown };
    if (typeof input.name !== "string") continue;
    out.push({ requestId: i.id, name: input.name, command: typeof input.command === "string" ? input.command : "", rule: i.rule });
  }
  return out;
}

// The servers that the user started from the block. They stay when the block mounts again, for
// example after a change of the layout while a server starts.
let keptWaiting: string[] = [];
const keptSeen = new Set<string>(); // The waiting servers that were "starting".

export function ServerBlock({
  api,
  approvals = [],
  onDecide,
  onOpen,
  onEdit,
}: {
  api: ServersApi;
  approvals?: ServerApproval[]; // The open questions: the block shows them under their server.
  onDecide?: (requestId: string, decision: Decision) => void;
  onOpen: (server: ServerItem) => void; // Opens the server in this tab.
  onEdit: () => void; // Open .harness/launch.json in the editor.
}) {
  const servers = api.items;
  // The servers that the user started here. When one runs, it opens in the tab.
  const [waiting, setWaitingState] = useState<string[]>(() => keptWaiting);
  const setWaiting = (next: string[] | ((w: string[]) => string[])) =>
    setWaitingState((w) => (keptWaiting = typeof next === "function" ? next(w) : next));
  const seen = useRef(keptSeen);

  useEffect(() => {
    if (waiting.length === 0) return;
    for (const s of servers) if (waiting.includes(s.name) && s.state === "starting") seen.current.add(s.name);
    const ready = serversToOpen(waiting, servers);
    const next = stillWaiting(waiting, seen.current, servers);
    if (next.length !== waiting.length) {
      for (const name of waiting) if (!next.includes(name)) seen.current.delete(name);
      setWaiting(next);
    }
    if (ready[0]) onOpen(ready[0]);
  }, [servers, waiting]);

  return (
    <div className="server-block-page">
      <span className="spacer" />
      {servers.length > 0 ? (
        <ul className="server-block" aria-label="Dev servers">
          {servers.map((s) => {
            const busy = s.state === "starting" || (waiting.includes(s.name) && s.state !== "running");
            const running = s.state === "running" && !!s.url;
            const ask = approvals.find((a) => a.name === s.name);
            return (
              <li key={s.name} className={`server-block-row${ask ? " asks" : ""}`}>
                <Server size={15} aria-hidden className="server-block-icon" />
                <span className="server-block-text">
                  <span className="server-block-name">{s.name}</span>
                  {s.state === "crashed" && <span className="server-block-error">{s.error || "The server stopped with an error."}</span>}
                </span>
                {s.port !== null && <span className="server-block-port mono">:{s.port}</span>}
                <button
                  type="button"
                  className="server-block-go"
                  disabled={busy}
                  onClick={() => {
                    if (running) return onOpen(s);
                    setWaiting((w) => (w.includes(s.name) ? w : [...w, s.name]));
                    api.start(s.name);
                  }}
                  aria-label={busy ? `${s.name} is starting` : running ? `Open ${s.name}` : `Start ${s.name}`}
                  title={busy ? "Starting…" : running ? "Open in this tab" : "Start, then open in this tab"}
                >
                  {busy ? (
                    <LoaderCircle size={15} className="spin" aria-hidden />
                  ) : running ? (
                    <SquareArrowOutUpRight size={15} aria-hidden />
                  ) : (
                    <Play size={15} aria-hidden />
                  )}
                </button>
                {ask && onDecide && (
                  // The first start of a command asks, as the chat card does.
                  <div className="server-block-ask" role="group" aria-label={`Allow ${s.name} to run?`}>
                    <span className="server-block-ask-text">
                      Allow <span className="mono">{ask.command}</span>?
                    </span>
                    <span className="server-block-ask-buttons">
                      <button type="button" className="btn btn-small" onClick={() => onDecide(ask.requestId, "deny")}>
                        Deny
                      </button>
                      {ask.rule && (
                        <button type="button" className="btn btn-small" onClick={() => onDecide(ask.requestId, "allow_always")}>
                          Always allow
                        </button>
                      )}
                      <button type="button" className="btn btn-primary btn-small" onClick={() => onDecide(ask.requestId, "allow_once")}>
                        Allow once
                      </button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : api.config === "invalid" ? (
        <div className="server-block-none">
          <p className="server-block-error">{api.error || ".harness/launch.json is not valid."}</p>
          <button type="button" className="btn btn-small" onClick={onEdit}>
            <FileCog size={14} aria-hidden /> Edit launch.json
          </button>
        </div>
      ) : api.proposal.length > 0 ? (
        // No launch.json: the harness found these servers in the project (package.json and others).
        <div className="server-block-none">
          <p>The project has no dev servers yet. The harness found these:</p>
          <ul className="server-block" aria-label="Found servers">
            {api.proposal.map((p) => (
              <li key={p.name} className="server-block-row">
                <Server size={15} aria-hidden className="server-block-icon" />
                <span className="server-block-text">
                  <span className="server-block-name">{p.name}</span>
                  <span className="server-block-port mono">{p.command}</span>
                </span>
                {p.port != null && <span className="server-block-port mono">:{p.port}</span>}
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-primary btn-small" onClick={() => api.save(api.proposal)}>
            Save to .harness/launch.json
          </button>
        </div>
      ) : (
        <div className="server-block-none">
          <p>The project has no dev servers yet.</p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              api.save([TEMPLATE]);
              onEdit();
            }}
          >
            <FileCog size={14} aria-hidden /> Create launch.json from a template
          </button>
        </div>
      )}
      <span className="spacer" />
      <p className="server-block-foot">
        Run a server to preview your app, or enter a URL.
        {servers.length > 0 && (
          <>
            <br />
            Edit this list in{" "}
            <button type="button" className="link-btn mono" onClick={onEdit}>
              .harness/launch.json
            </button>
            .
          </>
        )}
      </p>
    </div>
  );
}
