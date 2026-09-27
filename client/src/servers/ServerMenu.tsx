import { useEffect, useRef, useState } from "react";
import { ChevronDown, ExternalLink, Play, Server, Square } from "lucide-react";
import type { ServerItem } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { StateBadge } from "./ServersPane";
import type { ServersApi } from "./useServers";

/** The server controls in the session toolbar (SPEC.md section 8.7). */
export function ServerMenu({
  api,
  onOpenInBrowser,
  onOpenPane,
}: {
  api: ServersApi;
  onOpenInBrowser: (server: ServerItem) => void;
  onOpenPane: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  const running = api.items.filter((i) => i.state === "running").length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="server-menu" ref={ref} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        className={`btn btn-ghost${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        aria-label="Servers"
      >
        <Server size={15} aria-hidden />
        <span className="btn-label">Servers</span>
        {running > 0 && <span className="tab-badge running" title={`${running} running`}>{running}</span>}
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="menu server-dropdown" role="menu">
          {api.items.length === 0 && <p className="menu-note">No server in .harness/launch.json.</p>}
          {api.items.map((item) => {
            const live = item.state === "running" || item.state === "starting";
            return (
              <div key={item.name} className="server-menu-row">
                <span className="server-menu-name">
                  {item.name}
                  <StateBadge state={item.state} />
                </span>
                <span className="server-menu-actions">
                  <button
                    type="button"
                    role="menuitem"
                    className="icon-btn ghost"
                    onClick={() => (live ? api.stop(item.name) : api.start(item.name))}
                    aria-label={live ? `Stop ${item.name}` : `Start ${item.name}`}
                    title={live ? "Stop" : "Start"}
                  >
                    {live ? <Square size={13} aria-hidden /> : <Play size={13} aria-hidden />}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="icon-btn ghost"
                    disabled={item.state !== "running"}
                    onClick={() => {
                      setOpen(false);
                      onOpenInBrowser(item);
                    }}
                    aria-label={`Open ${item.name} in the browser`}
                    title="Open in browser"
                  >
                    <ExternalLink size={13} aria-hidden />
                  </button>
                </span>
              </div>
            );
          })}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenPane();
            }}
          >
            <Server size={14} aria-hidden /> Open the Servers pane
          </button>
        </div>
      )}
    </div>
  );
}
