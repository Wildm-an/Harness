// Shared parts of Settings > Agents and the agent picker (as in T3 Code): the icon of an agent, the status
// line of an agent, and the usage bars of a subscription (daemon agent_auth.py).

import type { AgentAuth, AgentUsage, HarnessItem } from "../daemon/protocol";
import { formatDateTime, formatTime } from "../lib/timeFormat";

/** The id of the built-in agent loop of Harness. It is not an ACP harness. */
export const BUILTIN_AGENT = "harness";

/** The initials of an agent name: "Claude Agent" -> "CA", "OpenCode" -> "OC", "goose" -> "G". */
export function agentInitials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? "?";
  const caps = word.match(/\p{Lu}/gu);
  if (caps && caps.length >= 2) return (caps[0] + caps[1]).toUpperCase();
  return word[0].toUpperCase();
}

/**
 * The icon of an agent: the app icon for the built-in loop, the logo of the agent (a data URL from the daemon, in an
 * <img>, so the SVG runs no code) in its own colors on a light tile, else the initials in a small square.
 */
export function AgentIcon({ id, name, icon, size = 16 }: { id: string; name: string; icon?: string | null; size?: number }) {
  if (id === BUILTIN_AGENT) {
    return <img className="agent-icon builtin" src="/app-icon.svg" alt="" width={size} height={size} aria-hidden />;
  }
  if (icon && icon.startsWith("data:image/svg+xml")) {
    // Full color, as the brand shows it (the user asked for this): the logo on a light tile, as an app icon.
    return (
      <span className="agent-icon logo" style={{ width: size, height: size }} aria-hidden>
        <img src={icon} alt="" draggable={false} />
      </span>
    );
  }
  return (
    <span className="agent-icon" style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.45)) }} aria-hidden>
      {agentInitials(name)}
    </span>
  );
}

export type AgentTone = "ok" | "warn" | "error" | "muted";

/** The status of an agent, as the status line of T3 Code: a dot tone and a headline. */
export function agentStatus(item: Pick<HarnessItem, "status" | "detail" | "can_sign_in" | "auth">): { tone: AgentTone; headline: string; detail: string } {
  if (item.status === "missing") return { tone: "error", headline: "Not found", detail: item.detail || "The program is not installed." };
  const auth = item.auth;
  if (item.can_sign_in) {
    if (!auth) return { tone: "muted", headline: "Checking the sign-in", detail: "" };
    if (auth.status === "authenticated") return { tone: "ok", headline: `Authenticated · ${auth.label}`, detail: "" };
    if (auth.status === "unauthenticated") return { tone: "error", headline: "Not authenticated", detail: auth.detail };
    return { tone: "warn", headline: "Needs attention", detail: auth.detail };
  }
  return { tone: "ok", headline: "Available", detail: "" };
}

/** True when the agent can run a session now: installed (or it runs with npx or uvx), and signed in when it has a sign-in. */
export function agentReady(item: Pick<HarnessItem, "status" | "can_sign_in" | "auth">): boolean {
  if (item.status === "missing") return false;
  return !item.can_sign_in || item.auth?.status !== "unauthenticated";
}

/** "Resets 3:20 PM" today, else "Resets Nov 20, 7:00 PM". */
export function resetText(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toDateString() === now.toDateString() ? `Resets ${formatTime(at)}` : `Resets ${formatDateTime(at)}`;
}

/** The time until a reset: "45 min", "2 hr 5 min", "3 days 4 hr". Empty for a time that passed. */
export function timeLeft(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms) || ms <= 0) return "";
  const minutes = Math.max(1, Math.round(ms / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} ${days === 1 ? "day" : "days"} ${hours} hr` : `${days} ${days === 1 ? "day" : "days"}`;
  if (hours > 0) return mins > 0 ? `${hours} hr ${mins} min` : `${hours} hr`;
  return `${mins} min`;
}

/** The hover tip of a usage row: "5-hour limit: 17% used. Resets in 2 hr 5 min (2:20 PM)." */
export function usageTip(u: AgentUsage, now = new Date()): string {
  const used = `${u.label}: ${Math.round(u.percent)}% used.`;
  const reset = resetText(u.resets_at, now);
  if (!reset) return used;
  const left = timeLeft(u.resets_at, now);
  return left ? `${used} Resets in ${left} (${reset.slice("Resets ".length)}).` : `${used} ${reset}.`;
}

/** The usage bars of a subscription. Nothing when the agent gives no usage. */
export function UsageBars({ auth, compact = false }: { auth: AgentAuth | null | undefined; compact?: boolean }) {
  if (!auth?.usage?.length) {
    return auth?.usage_error && !compact ? <p className="setting-help agent-usage-error">{auth.usage_error}</p> : null;
  }
  return (
    <div className={`agent-usage${compact ? " compact" : ""}`}>
      {auth.usage.map((u: AgentUsage) => {
        const pct = Math.round(u.percent);
        const tone = pct >= 90 ? " danger" : pct >= 75 ? " warn" : "";
        // The row has no box of its own (display: contents), so each part has the tip with the reset time.
        const tip = usageTip(u);
        return (
          <div key={u.label} className="agent-usage-row">
            <span className="agent-usage-label" title={tip}>{u.label}</span>
            <span className="agent-usage-bar" title={tip} role="progressbar" aria-label={`${u.label} usage`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <span className={`agent-usage-fill${tone}`} style={{ width: `${Math.min(100, Math.max(0, u.percent))}%` }} />
            </span>
            <span className="agent-usage-pct" title={tip}>{pct}%</span>
            {!compact && <span className="agent-usage-reset" title={tip}>{resetText(u.resets_at)}</span>}
          </div>
        );
      })}
    </div>
  );
}
