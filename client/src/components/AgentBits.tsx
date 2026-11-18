// Shared parts of Settings > Agents and the agent picker (as in T3 Code): the icon of an agent, the status
// line of an agent, and the usage bars of a subscription (daemon agent_auth.py).

import { LoaderCircle } from "lucide-react";
import type { AgentAuth, AgentUsage, HarnessItem } from "../daemon/protocol";
import type { PlanLimits } from "../lib/context";
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

/** The logos whose true form has a tile (the user asked for no tile on the other logos): Hermes Agent is a black
 * figure on a white square, and the Oh My Pi logo has light parts on a dark square. */
const LIGHT_TILES = new Set(["hermes"]);
const DARK_TILES = new Set(["omp"]);

/** The SVG text of a data URL (base64 or text), or "" when it cannot be read. */
function svgText(url: string): string {
  const comma = url.indexOf(",");
  if (comma < 0) return "";
  const body = url.slice(comma + 1);
  try {
    return url.slice(0, comma).endsWith(";base64") ? atob(body) : decodeURIComponent(body);
  } catch {
    return "";
  }
}

/** A logo in one color (``currentColor``): it takes the text color of the theme, as in T3 Code. */
export function isMonochromeLogo(url: string): boolean {
  return svgText(url).includes("currentColor");
}

/**
 * The icon of an agent: the app icon for the built-in loop, the logo of the agent (a data URL from the daemon, in an
 * <img>, so the SVG runs no code) in its own colors on a light tile, else the initials in a small square.
 */
export function AgentIcon({ id, name, icon, size = 16 }: { id: string; name: string; icon?: string | null; size?: number }) {
  if (id === BUILTIN_AGENT) {
    // The logo of the title bar (app-logo.png). app-icon.svg squeezes "{H}" into its width, so it looked stretched.
    return <img className="agent-icon builtin" src="/app-logo.png" alt="" width={size} height={size} draggable={false} aria-hidden />;
  }
  if (icon && icon.startsWith("data:image/svg+xml")) {
    const tile = LIGHT_TILES.has(id) ? " tile" : DARK_TILES.has(id) ? " tile dark" : "";
    if (isMonochromeLogo(icon) && !tile) {
      // A one-color logo with no brand color: the text color of the theme, with no tile (a CSS mask of the SVG).
      return (
        <span
          className="agent-icon logo mono"
          style={{ width: size, height: size, WebkitMaskImage: `url("${icon}")`, maskImage: `url("${icon}")` }}
          aria-hidden
        />
      );
    }
    // A logo in its own colors, as the brand shows it, with no tile. Only a logo whose true form has a tile gets one.
    return (
      <span className={`agent-icon logo${tile}`} style={{ width: size, height: size }} aria-hidden>
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
  return <LimitRows usage={auth.usage} compact={compact} />;
}

/** The rows of the subscription limits: the label, a bar, the percent, and the reset time (not in compact rows).
 * `used`: "41% used" in place of "41%" (the Limits tab of the Usage page). */
export function LimitRows({ usage, compact = false, used = false }: { usage: AgentUsage[]; compact?: boolean; used?: boolean }) {
  return (
    <div className={`agent-usage${compact ? " compact" : ""}`}>
      {usage.map((u: AgentUsage) => {
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
            <span className="agent-usage-pct" title={tip}>{used ? `${pct}% used` : `${pct}%`}</span>
            {!compact && <span className="agent-usage-reset" title={tip}>{resetText(u.resets_at)}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** The usage limits of the plan of a session agent, as in Claude Code /usage: for each window the name, the share
 * in use, a bar, and the time to the reset. The context panel under the prompt box and the Context section of the
 * session rail show it. Nothing for a session with no subscription. */
export function PlanUsage({ limits }: { limits: PlanLimits | null | undefined }) {
  if (!limits) return null;
  const body =
    limits.windows.length > 0 ? (
      <ul className="plan-usage-list">
        {limits.windows.map((u) => {
          const pct = Math.round(u.percent);
          const tone = pct >= 90 ? " danger" : pct >= 75 ? " warn" : "";
          const left = timeLeft(u.resets_at);
          const tip = usageTip(u);
          return (
            <li key={u.label} title={tip}>
              <div className="plan-usage-line">
                <span className="plan-usage-label">{u.label}</span>
                <span className="plan-usage-pct mono">{pct}% used</span>
              </div>
              <span className="agent-usage-bar" role="progressbar" aria-label={`${u.label} usage`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <span className={`agent-usage-fill${tone}`} style={{ width: `${Math.min(100, Math.max(0, u.percent))}%` }} />
              </span>
              {left && <span className="plan-usage-reset">Resets in {left}</span>}
            </li>
          );
        })}
      </ul>
    ) : limits.checking ? (
      <p className="plan-usage-note">
        <LoaderCircle size={13} className="spin" aria-hidden /> Reading the usage.
      </p>
    ) : (
      <p className="plan-usage-note">{limits.error || "This agent reports no limits now."}</p>
    );
  return (
    <section className="plan-usage" aria-label="Plan usage">
      <div className="plan-usage-head">
        <span className="plan-usage-title">Plan usage</span>
        {limits.label && <span className="plan-usage-plan">{limits.label}</span>}
      </div>
      {body}
    </section>
  );
}
