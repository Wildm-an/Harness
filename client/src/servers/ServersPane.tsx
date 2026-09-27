import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Circle,
  CircleCheck,
  CircleX,
  ExternalLink,
  FileCog,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  Square,
  TriangleAlert,
} from "lucide-react";
import type { ServerConfigJson, ServerItem, ServerState } from "../daemon/protocol";
import type { LogLine, ServersApi } from "./useServers";

const STATE_LABEL: Record<ServerState, string> = {
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  crashed: "Crashed",
};

/** The state as an icon and a word: the color is not the only sign. */
export function StateBadge({ state }: { state: ServerState }) {
  const Icon = state === "running" ? CircleCheck : state === "crashed" ? CircleX : state === "starting" ? LoaderCircle : Circle;
  return (
    <span className={`server-state state-${state}`}>
      <Icon size={13} aria-hidden className={state === "starting" ? "spin" : undefined} />
      {STATE_LABEL[state]}
    </span>
  );
}

function LogView({ lines }: { lines: LogLine[] }) {
  const box = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <pre
      className="server-log"
      ref={box}
      aria-label="Server log"
      onScroll={() => {
        const el = box.current;
        if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {lines.length === 0 ? (
        <span className="log-empty">No output yet.</span>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={`log-${line.stream}`}>
            {line.text || " "}
          </div>
        ))
      )}
    </pre>
  );
}

function Proposal({ api, onEditConfig }: { api: ServersApi; onEditConfig: () => void }) {
  const [rows, setRows] = useState<(ServerConfigJson & { include: boolean })[]>(() =>
    api.proposal.map((s) => ({ ...s, include: true })),
  );
  useEffect(() => setRows(api.proposal.map((s) => ({ ...s, include: true }))), [api.proposal]);

  const update = (i: number, patch: Partial<ServerConfigJson & { include: boolean }>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const chosen = rows.filter((r) => r.include && r.command.trim());
  const save = () => api.save(chosen.map(({ include: _include, ...server }) => server));

  if (rows.length === 0) {
    return (
      <div className="server-proposal">
        <p>
          The project has no <code>.harness/launch.json</code>, and the harness found no server to propose.
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            api.save([{ name: "web", command: "npm run dev", port: 3000, default: true }]);
            onEditConfig();
          }}
        >
          <FileCog size={14} aria-hidden />
          Create launch.json from a template
        </button>
      </div>
    );
  }

  return (
    <div className="server-proposal">
      <p>
        The project has no <code>.harness/launch.json</code>. The harness found these servers. Check the commands, then
        save them.
      </p>
      <ul>
        {rows.map((row, i) => (
          <li key={row.name} className="proposal-row">
            <label className="checkbox">
              <input type="checkbox" checked={row.include} onChange={(e) => update(i, { include: e.target.checked })} />
              <span className="mono">{row.name}</span>
            </label>
            <label className="sr-only" htmlFor={`proposal-cmd-${i}`}>
              Command of {row.name}
            </label>
            <input
              id={`proposal-cmd-${i}`}
              className="mono"
              value={row.command}
              onChange={(e) => update(i, { command: e.target.value })}
              spellCheck={false}
            />
            <label className="sr-only" htmlFor={`proposal-port-${i}`}>
              Port of {row.name}
            </label>
            <input
              id={`proposal-port-${i}`}
              className="mono proposal-port"
              inputMode="numeric"
              value={row.port ?? ""}
              placeholder="port"
              onChange={(e) => update(i, { port: e.target.value ? Number(e.target.value.replace(/\D/g, "")) : undefined })}
            />
            {row.cwd && row.cwd !== "." && <span className="help mono">in {row.cwd}</span>}
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-primary" onClick={save} disabled={chosen.length === 0}>
        Save to .harness/launch.json
      </button>
    </div>
  );
}

export const ServersPane = memo(function ServersPane({
  api,
  autoVerify,
  onAutoVerify,
  onOpenInBrowser,
  onEditConfig,
}: {
  api: ServersApi;
  autoVerify: boolean;
  onAutoVerify: (enabled: boolean) => void;
  onOpenInBrowser: (server: ServerItem) => void;
  onEditConfig: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const current = api.items.find((i) => i.name === selected) ?? api.items[0] ?? null;

  useEffect(() => {
    if (current && api.logs[current.name] === undefined) api.loadLogs(current.name);
  }, [current?.name]);

  const anyRunning = api.items.some((i) => i.state === "running" || i.state === "starting");

  return (
    <section className="side-pane servers-pane" aria-label="Servers">
      <header className="pane-head">
        <Server size={16} aria-hidden className="pane-icon" />
        <span className="pane-title">Servers</span>
        <label
          className="checkbox auto-verify"
          title="The agent checks the app with its preview browser after each change to the user interface. This setting is for this project."
        >
          <input type="checkbox" checked={autoVerify} onChange={(e) => onAutoVerify(e.target.checked)} />
          Auto-verify
        </label>
        <button type="button" className="btn btn-small" onClick={api.stopAll} disabled={!anyRunning}>
          <Square size={12} aria-hidden />
          Stop all
        </button>
        <button type="button" className="icon-btn ghost" onClick={onEditConfig} title="Edit the configuration" aria-label="Edit launch.json">
          <FileCog size={15} aria-hidden />
        </button>
        <button type="button" className="icon-btn ghost" onClick={api.refresh} title="Read launch.json again" aria-label="Refresh">
          <RefreshCw size={14} aria-hidden />
        </button>
      </header>

      {api.config === "missing" && <Proposal api={api} onEditConfig={onEditConfig} />}
      {api.config === "invalid" && (
        <div className="notice-bar bad" role="alert">
          <TriangleAlert size={15} aria-hidden />
          <span>{api.error}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-small" onClick={onEditConfig}>
            Edit launch.json
          </button>
        </div>
      )}

      {api.items.length > 0 && (
        <>
          <ul className="server-list" aria-label="Configured servers">
            {api.items.map((item) => {
              const busy = item.state === "starting";
              const live = item.state === "running" || item.state === "starting";
              return (
                <li key={item.name} className={`server-row${current?.name === item.name ? " selected" : ""}`}>
                  <button type="button" className="server-main" onClick={() => setSelected(item.name)} aria-pressed={current?.name === item.name}>
                    <span className="server-name">
                      {item.name}
                      {item.default && <span className="badge">default</span>}
                    </span>
                    <span className="server-cmd mono" title={item.command}>
                      {item.command}
                    </span>
                    <span className="server-meta">
                      <StateBadge state={item.state} />
                      {item.port && <span className="mono">:{item.port}</span>}
                      {item.cwd && item.cwd !== "." && <span className="mono">{item.cwd}</span>}
                    </span>
                    {item.error && <span className="server-error">{item.error}</span>}
                  </button>
                  <div className="server-actions">
                    {live ? (
                      <button type="button" className="btn btn-small" onClick={() => api.stop(item.name)}>
                        <Square size={12} aria-hidden />
                        Stop
                      </button>
                    ) : (
                      <button type="button" className="btn btn-small btn-primary" onClick={() => api.start(item.name)}>
                        <Play size={12} aria-hidden />
                        Start
                      </button>
                    )}
                    <button type="button" className="btn btn-small" onClick={() => api.restart(item.name)} disabled={busy}>
                      <RotateCw size={12} aria-hidden />
                      Restart
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => onOpenInBrowser(item)}
                      disabled={item.state !== "running" || !item.url}
                      title={item.url ?? undefined}
                    >
                      <ExternalLink size={12} aria-hidden />
                      Open in browser
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {current && (
            <div className="server-log-wrap">
              <div className="server-log-head">
                Log of <span className="mono">{current.name}</span>
                <span className="log-legend">
                  <span className="log-stdout">stdout</span> <span className="log-stderr">stderr</span>
                </span>
              </div>
              {current.state === "crashed" && current.last_lines && (
                <div className="notice-bar bad" role="alert">
                  <CircleX size={15} aria-hidden />
                  <span>{current.error} The last {current.last_lines.length} log lines are below.</span>
                </div>
              )}
              <LogView lines={current.state === "crashed" && current.last_lines ? current.last_lines : (api.logs[current.name] ?? [])} />
            </div>
          )}
        </>
      )}
      {api.config === "unknown" && (
        <p className="pane-empty">
          <LoaderCircle size={16} className="spin" aria-hidden /> Loading the servers.
        </p>
      )}
    </section>
  );
});
