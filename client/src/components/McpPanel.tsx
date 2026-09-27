import { memo, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, FileCog, LoaderCircle, Plug, RefreshCw, TriangleAlert, X } from "lucide-react";
import type { McpServerItem, McpState, McpStatus } from "../daemon/protocol";

const STATE_LABEL: Record<McpState, string> = {
  starting: "Connecting",
  connected: "Connected",
  failed: "Failed",
  disabled: "Off",
  stopped: "Stopped",
};

function StateBadge({ state }: { state: McpState }) {
  const Icon = state === "connected" ? CircleCheck : state === "failed" ? CircleX : state === "starting" ? LoaderCircle : Plug;
  const css = state === "connected" ? "running" : state === "failed" ? "crashed" : state === "starting" ? "starting" : "stopped";
  return (
    <span className={`server-state state-${css}`}>
      <Icon size={13} aria-hidden className={state === "starting" ? "spin" : undefined} />
      {STATE_LABEL[state]}
    </span>
  );
}

function ServerRow({ item, busy, onRestart }: { item: McpServerItem; busy: boolean; onRestart: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="mcp-server">
      <div className="mcp-server-head">
        <button type="button" className="mcp-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={item.tools.length === 0}>
          <ChevronRight size={14} aria-hidden className="tool-chevron" />
          <span className="mcp-name">{item.name}</span>
          <span className="badge">{item.scope}</span>
          <span className="badge">{item.transport}</span>
          <StateBadge state={item.state} />
          {item.state === "connected" && <span className="help">{item.tools.length === 1 ? "1 tool" : `${item.tools.length} tools`}</span>}
        </button>
        <button type="button" className="icon-btn ghost" onClick={onRestart} disabled={busy} aria-label={`Restart ${item.name}`} title="Read the configuration again and connect again">
          <RefreshCw size={14} aria-hidden />
        </button>
      </div>
      <p className="mcp-target mono" title={item.target}>
        {item.target}
      </p>
      {item.error && (
        <div className="notice-bar bad" role="alert">
          <CircleX size={15} aria-hidden />
          <span>{item.error}</span>
        </div>
      )}
      {item.log && item.log.length > 0 && <pre className="server-log mcp-log">{item.log.join("\n")}</pre>}
      {open && (
        <ul className="mcp-tools">
          {item.tools.map((t) => (
            <li key={t.name}>
              <span className="mono mcp-tool-name">{t.agent_name || t.name}</span>
              {t.description && <span className="help">{t.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export const McpPanel = memo(function McpPanel({
  status,
  busy,
  onRestart,
  onEditConfig,
  onClose,
}: {
  status: McpStatus | null;
  busy: boolean;
  onRestart: (name?: string) => void;
  onEditConfig: () => void;
  onClose: () => void;
}) {
  return (
    <section className="side-pane mcp-panel" aria-label="MCP servers">
      <header className="pane-head">
        <Plug size={16} aria-hidden className="pane-icon" />
        <span className="pane-title">MCP servers</span>
        <span className="pane-status" role="status">
          {busy && <LoaderCircle size={14} className="spin" aria-hidden />}
        </span>
        <button type="button" className="btn btn-small" onClick={() => onRestart()} disabled={busy} title="Read mcp.json again and connect to all servers again">
          <RefreshCw size={12} aria-hidden /> Reload all
        </button>
        <button type="button" className="icon-btn ghost" onClick={onEditConfig} aria-label="Edit .harness/mcp.json" title="Edit .harness/mcp.json of the project">
          <FileCog size={15} aria-hidden />
        </button>
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close the MCP panel" title="Close">
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="pane-body">
        {status === null ? (
          <p className="pane-empty">
            <LoaderCircle size={16} className="spin" aria-hidden /> Loading the MCP servers.
          </p>
        ) : (
          <>
            <p className="help">
              The servers come from <code>{status.paths.project}</code> in the project and from <code>{status.paths.user}</code>. A project server
              replaces a user server with the same name. Each MCP tool call needs approval, unless a rule allows it, for example{" "}
              <code>mcp__github__*</code>.
            </p>
            {status.problems.map((p, i) => (
              <div key={i} className="notice-bar warn" role="alert">
                <TriangleAlert size={15} aria-hidden />
                <span>{p}</span>
              </div>
            ))}
            {status.items.length === 0 ? (
              <div className="pane-empty">
                <p>No MCP servers are configured.</p>
                <button type="button" className="btn" onClick={onEditConfig}>
                  <FileCog size={14} aria-hidden /> Create .harness/mcp.json
                </button>
              </div>
            ) : (
              <ul className="mcp-list">
                {status.items.map((item) => (
                  <ServerRow key={item.name} item={item} busy={busy} onRestart={() => onRestart(item.name)} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
});
