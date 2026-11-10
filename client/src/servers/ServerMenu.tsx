import { useEffect, useRef, useState } from "react";
import { ChevronDown, ExternalLink, FileCog, Play, Server, Square } from "lucide-react";
import type { ServerItem } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { StateBadge } from "./StateBadge";
import type { ServersApi } from "./useServers";

/** The dev servers of the project, in the header of the Browser pane, as in the Claude app (SPEC.md section 8.7). */
export function ServerMenu({
  api,
  onOpenInBrowser,
  onEditConfig,
}: {
  api: ServersApi;
  onOpenInBrowser: (server: ServerItem) => void;
  onEditConfig: () => void; // Open .harness/launch.json, or the empty tab that makes it.
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
        aria-label={running > 0 ? `Servers: ${running} running` : "Servers"}
        title={running > 0 ? `Servers: ${running} running` : "Servers"}
      >
        <Server size={14} aria-hidden />
        {running > 0 && <span className="tab-badge running" title={`${running} running`}>{running}</span>}
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="menu server-dropdown" role="menu" data-tauri-drag-region="false">
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
                    title="Open in the Browser pane"
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
              onEditConfig();
            }}
          >
            <FileCog size={14} aria-hidden /> {api.items.length > 0 ? "Edit launch.json" : "Add a dev server…"}
          </button>
        </div>
      )}
    </div>
  );
}
