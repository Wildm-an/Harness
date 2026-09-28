import { ChefHat, Cpu, MessageSquare, PanelLeftClose, Plus, type LucideIcon } from "lucide-react";
import type { ConnectionStatus } from "../daemon/connection";
import type { SessionSummary } from "../daemon/protocol";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionGroup {
  label: string;
  items: SessionSummary[];
}

/** Groups the sessions by the day of their last change: Today, Yesterday, Previous 7 days, Older. */
export function groupSessions(items: SessionSummary[], now: Date = new Date()): SessionGroup[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const labels = ["Today", "Yesterday", "Previous 7 days", "Older"];
  const buckets: SessionSummary[][] = labels.map(() => []);
  for (const item of [...items].sort((a, b) => b.updated_at - a.updated_at)) {
    // The daemon gives the times in seconds.
    const at = item.updated_at * 1000;
    const index = at >= today ? 0 : at >= today - DAY_MS ? 1 : at >= today - 7 * DAY_MS ? 2 : 3;
    buckets[index].push(item);
  }
  return labels.map((label, i) => ({ label, items: buckets[i] })).filter((g) => g.items.length > 0);
}

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function NavButton({ icon: Icon, label, active, disabled, onClick }: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`side-item${active ? " active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={16} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

export function Sidebar({
  sessions,
  activeId,
  screen,
  status,
  connection,
  onNewSession,
  onResume,
  onCookbook,
  onProviders,
  onCollapse,
}: {
  sessions: SessionSummary[];
  activeId: string | null;
  screen: string;
  status: ConnectionStatus;
  connection: React.ReactNode; // The connection button at the bottom.
  onNewSession: () => void;
  onResume: (id: string) => void;
  onCookbook: () => void;
  onProviders: () => void;
  onCollapse: () => void;
}) {
  const open = status === "open";
  const grouped = groupSessions(sessions);
  return (
    <nav className="sidebar" aria-label="Sessions and tools">
      <div className="side-head">
        <img src="/app-icon.svg" alt="" width={18} height={18} />
        <span className="side-brand">Harness</span>
        <button type="button" className="icon-btn ghost" onClick={onCollapse} aria-label="Close the sidebar" title="Close the sidebar">
          <PanelLeftClose size={16} aria-hidden />
        </button>
      </div>

      <div className="side-actions">
        <NavButton icon={Plus} label="New session" active={screen === "start"} disabled={!open} onClick={onNewSession} />
        <NavButton icon={ChefHat} label="Cookbook" active={screen === "cookbook"} disabled={!open} onClick={onCookbook} />
        <NavButton icon={Cpu} label="Providers" active={screen === "providers"} disabled={!open} onClick={onProviders} />
      </div>

      <div className="side-sessions">
        {grouped.length === 0 && (
          <p className="side-empty">{open ? "No sessions yet." : "Connect to a daemon to see its sessions."}</p>
        )}
        {grouped.map((group) => (
          <section key={group.label} className="side-group" aria-label={group.label}>
            <h2 className="side-label">{group.label}</h2>
            <ul>
              {group.items.map((s) => {
                const active = s.id === activeId;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`side-session${active ? " active" : ""}`}
                      onClick={() => !active && onResume(s.id)}
                      disabled={!open}
                      aria-current={active ? "true" : undefined}
                      title={`${s.title ?? "Untitled session"}\n${s.cwd}\n${s.provider}/${s.model}`}
                    >
                      <MessageSquare size={14} aria-hidden />
                      <span className="side-session-text">
                        <span className="side-session-title">{s.title ?? "Untitled session"}</span>
                        <span className="side-session-folder mono">{folderName(s.cwd)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <div className="side-foot">{connection}</div>
    </nav>
  );
}
