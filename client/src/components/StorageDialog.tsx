// Settings > General > Storage > Manage: the disk space that Harness uses, as the Storage dialog of
// Claude. The daemon measures its computer (disk.usage, daemon disk_usage.py). The desktop app adds
// its own folders (app_storage in src-tauri). The dialog only shows the space: it deletes nothing.

import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { DaemonConnection } from "../daemon/connection";
import type { DiskItem, DiskUsage } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { appStorage, isTauri, revealInExplorer, type AppFolder } from "../lib/tauri";

import { formatBytes } from "../lib/bytes";
export { formatBytes }; // One formula for all sizes (lib/bytes.ts).

/** "just now", "5 minutes ago", "2 hours ago". */
export function checkedAgo(checkedAt: number, now: number): string {
  const minutes = Math.floor((now - checkedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Category {
  id: string;
  label: string;
  color: string; // A CSS color for the bar and the legend.
  size: number;
  summary: string;
  items: DiskItem[];
  note?: string;
}

const APP_FOLDER_NAMES: Record<AppFolder["id"], string> = {
  app: "The Harness app",
  webview: "Web cache and app settings",
  browser: "Browser pane",
};

/** The categories of the dialog, in the order of the bar. */
export function categories(usage: DiskUsage, app: AppFolder[]): Category[] {
  const folder = (id: AppFolder["id"]) => app.filter((f) => f.id === id).map((f) => ({ name: APP_FOLDER_NAMES[id], size: f.size, path: f.path }));
  const s = usage.sessions;
  const worktrees = s.worktrees.length;
  const stale = s.stale_count > 0 ? ` ${plural(s.stale_count, "has", "have")} had no activity in the last 30 days (${formatBytes(s.stale_size)}).` : "";
  const runtime = [...folder("app"), ...usage.runtime.items.map((i) => ({ ...i, name: `Browser tools: ${i.name}` }))];
  const caches = [
    ...folder("webview"),
    ...folder("browser"),
    ...usage.caches.items.map((i) => ({ ...i, name: i.name === "logs" ? "Logs" : i.name === "chrome-automation" ? "Browser connector profile" : i.name })),
  ];
  return [
    {
      id: "sessions",
      label: "Sessions and worktrees",
      color: "#d97757", // Fixed, as in Claude: the accent color can be white or gray.
      size: s.size,
      summary: `${plural(s.count, "session", "sessions")} and ${plural(worktrees, "worktree", "worktrees")}.${stale}`,
      items: [
        { name: "Session database", size: s.database },
        ...s.worktrees.map((w) => ({ name: `Worktree ${w.project} · ${w.name}`, size: w.size, path: w.path })),
        ...s.largest.map((l) => ({ name: `Session: ${l.title} · ${l.project}`, size: l.size })),
      ],
      note: s.largest.length > 0 ? "The session rows show the largest sessions. Their space is part of the session database." : undefined,
    },
    {
      id: "models",
      label: "Local models",
      color: "var(--info)",
      size: usage.models.size,
      summary: usage.models.items.length
        ? `${plural(usage.models.items.length, "model", "models")} in the Hugging Face cache.`
        : "No model files in the Hugging Face cache.",
      items: usage.models.items,
      note: `Other apps can use this cache too: ${usage.models.path}`,
    },
    {
      id: "runtime",
      label: "Runtime",
      color: "var(--success)",
      size: runtime.reduce((n, i) => n + i.size, 0),
      summary: app.some((f) => f.id === "app") ? "The Harness app and the Chromium of the browser tools." : "The Chromium of the browser tools.",
      items: runtime,
      note: `Other apps that use Playwright can use the Chromium folder too: ${usage.runtime.path}`,
    },
    {
      id: "memory",
      label: "Memory and settings",
      color: "var(--warning)",
      size: usage.memory.size,
      summary: "Memory, routines, plugins, and settings.",
      items: usage.memory.items,
    },
    {
      id: "caches",
      label: "App caches and logs",
      color: "var(--text-muted)",
      size: caches.reduce((n, i) => n + i.size, 0),
      summary: "Web cache, browser panes and logs.",
      items: caches,
    },
  ];
}

export function StorageDialog({ conn, remoteName, onClose }: {
  conn: DaemonConnection;
  remoteName: string | null; // The name of a remote daemon computer. null: the daemon runs on this computer.
  onClose: () => void;
}) {
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [app, setApp] = useState<AppFolder[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useOverlay(true);

  useEffect(() => close.current?.focus(), []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "disk.usage") {
          const { type: _type, ...report } = msg;
          setUsage(report);
          setBusy(false);
          setNow(Date.now());
        } else if (msg.type === "error" && msg.ref === "disk.usage") {
          setError(msg.message);
          setBusy(false);
        }
      }),
    [conn],
  );

  const refresh = () => {
    setBusy(true);
    setError(null);
    try {
      conn.send({ type: "disk.usage" });
    } catch {
      setBusy(false);
      setError("Connect to a computer to see the space of its daemon.");
    }
    if (isTauri()) {
      appStorage().then(setApp, () => setApp([]));
    }
  };
  useEffect(refresh, [conn]);

  const list = usage ? categories(usage, app) : [];
  const total = list.reduce((n, c) => n + c.size, 0);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal storage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="storage-head">
          <h2 id={`${id}-title`}>Storage</h2>
          <button ref={close} type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="storage-body">
          <p className="help">
            {remoteName
              ? `Space Harness uses on this computer and on ${remoteName}. The sessions, the models, the browser tools, and the memory are on ${remoteName}.`
              : "Space Harness uses on this computer."}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!usage ? (
            !error && (
              <p className="help storage-loading">
                <LoaderCircle size={14} className="spin" aria-hidden /> Checking the disk space…
              </p>
            )
          ) : (
            <>
              <div className="storage-total">
                <div className="setting-text">
                  <span className="setting-label">Disk space used</span>
                  <span className="setting-help">Checked {checkedAgo(usage.checked_at * 1000, now)}.</span>
                </div>
                <strong>{formatBytes(total)}</strong>
              </div>
              <div className="storage-bar" role="img" aria-label={list.map((c) => `${c.label} ${formatBytes(c.size)}`).join(", ")}>
                {list
                  .filter((c) => c.size > 0)
                  .map((c) => (
                    <span key={c.id} style={{ flexGrow: c.size, background: c.color }} />
                  ))}
              </div>
              <ul className="storage-legend">
                {list.map((c) => (
                  <li key={c.id}>
                    <span className="storage-swatch" style={{ background: c.color }} aria-hidden />
                    {c.label} <span className="storage-legend-size">{formatBytes(c.size)}</span>
                  </li>
                ))}
              </ul>
              {list.map((c) => (
                <section key={c.id} className="storage-row">
                  <div className="storage-row-head">
                    <div className="setting-text">
                      <span className="setting-label">{c.label}</span>
                      <span className="setting-help">{c.summary}</span>
                    </div>
                    <span className="storage-size">{formatBytes(c.size)}</span>
                  </div>
                  {c.items.length > 0 && (
                    <details className="storage-details">
                      <summary>Details</summary>
                      <ul>
                        {c.items.map((item, i) => (
                          <li key={`${item.name}-${i}`} title={item.path}>
                            <span className="storage-item-name">{item.name}</span>
                            <span className="storage-item-size">{formatBytes(item.size)}</span>
                          </li>
                        ))}
                      </ul>
                      {c.note && <p className="help">{c.note}</p>}
                    </details>
                  )}
                </section>
              ))}
            </>
          )}
        </div>
        <footer className="storage-foot">
          {usage && !remoteName && isTauri() && (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => void revealInExplorer(usage.home).catch((e) => setError(String(e)))}>
              <FolderOpen size={14} aria-hidden />
              Open folder
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={refresh} disabled={busy}>
            {busy ? <LoaderCircle size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            Refresh
          </button>
        </footer>
      </div>
    </div>
  );
}
