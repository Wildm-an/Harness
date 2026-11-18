// The Usage page, as the Usage page of T3 Code (MIT): the token use and the API cost estimate of the agents on the
// daemon computer (daemon usage.py, message usage.summary). A full screen in the main area, as the Routines page.
// The provider menu filters on this side: the totals are the sums of the shown providers.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Check, ChevronDown, CircleDollarSign, Info, RefreshCw, X } from "lucide-react";
import type { DaemonConnection } from "../daemon/connection";
import type { UsageModel, UsagePoint, UsageProvider, UsageRange, UsageRate, UsageSummary, UsageTotals } from "../daemon/protocol";
import { loadPref, savePref } from "../lib/prefs";
import { formatCount, formatPercent, formatTokens, formatUsd, share } from "../lib/usageFormat";
import { AgentIcon, LimitRows } from "./AgentBits";
import { SkeletonRows } from "./Skeleton";
import { UsageChart, type UsageMetric } from "./UsageChart";
import { UsagePricesDialog } from "./UsagePricesDialog";

export type UsageTab = "cost" | "tokens" | "limits";
type Breakdown = "model" | "day";

export const RANGES: { id: UsageRange; label: string }[] = [
  { id: "24h", label: "Past 24h" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
];

const TABS: { id: UsageTab; label: string }[] = [
  { id: "cost", label: "Cost" },
  { id: "tokens", label: "Tokens" },
  { id: "limits", label: "Limits" },
];

export function parseRange(value: string): UsageRange {
  return RANGES.some((r) => r.id === value) ? (value as UsageRange) : "30d";
}

export function parseTab(value: string): UsageTab {
  return TABS.some((t) => t.id === value) ? (value as UsageTab) : "cost";
}

// The last summary of each computer and range, for the life of the app: a switch back to a range shows it at once,
// then the new summary replaces it.
const cache = new Map<string, UsageSummary>();
const cacheKey = (computer: string, range: UsageRange) => `${computer}\n${range}`;

const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;

const TOTAL_KEYS = ["tokens", "input", "cache_read", "cache_write", "output", "reasoning", "cost", "premium", "fast_cost", "ultrafast_cost", "cache_savings", "sessions", "records", "unpriced_records"] as const;

/** The sum of the totals of some providers. */
export function sumTotals(list: UsageTotals[]): UsageTotals {
  const out = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0])) as unknown as UsageTotals;
  for (const t of list) for (const k of TOTAL_KEYS) out[k] += t[k] ?? 0;
  return out;
}

export interface UsageView {
  providers: UsageProvider[]; // The shown providers.
  models: UsageModel[]; // The models of the shown providers.
  totals: UsageTotals; // The summary totals, or the sum of the shown providers when a filter is on.
  filtered: boolean; // A provider of the summary is hidden.
}

/** The summary with the hidden providers removed. */
export function filterSummary(s: UsageSummary, hidden: ReadonlySet<string>): UsageView {
  const filtered = s.providers.some((p) => hidden.has(p.id));
  if (!filtered) return { providers: s.providers, models: s.models, totals: s.totals, filtered };
  const providers = s.providers.filter((p) => !hidden.has(p.id));
  return {
    providers,
    models: s.models.filter((m) => !hidden.has(m.provider)),
    totals: sumTotals(providers),
    filtered,
  };
}

/** The models, the largest first by the metric of the tab, then by the other metric, then by name. */
export function sortModels(models: UsageModel[], metric: UsageMetric): UsageModel[] {
  const other: UsageMetric = metric === "cost" ? "tokens" : "cost";
  return [...models].sort((a, b) => b[metric] - a[metric] || b[other] - a[other] || a.model.localeCompare(b.model));
}

export interface TypePart {
  key: "input" | "cache_read" | "cache_write" | "output" | "other";
  label: string;
  value: number;
  mix: number; // The percent of the text color in the color of the part (the rest is the background).
}

const PARTS: Omit<TypePart, "value">[] = [
  { key: "input", label: "Input", mix: 60 },
  { key: "cache_read", label: "Cache read", mix: 30 },
  { key: "cache_write", label: "Cache write", mix: 72 },
  { key: "output", label: "Output", mix: 100 },
  { key: "other", label: "Other", mix: 44 },
];

/** The parts of "Cost by type" (from category_cost) or "Tokens by type" (from the totals). "Other" shows from $0.005. */
export function typeParts(s: UsageSummary, totals: UsageTotals, metric: UsageMetric): TypePart[] {
  if (metric === "cost") {
    return PARTS.filter((p) => p.key !== "other" || s.category_cost.other >= 0.005).map((p) => ({ ...p, value: s.category_cost[p.key] ?? 0 }));
  }
  return PARTS.filter((p) => p.key !== "other").map((p) => ({ ...p, value: totals[p.key as Exclude<TypePart["key"], "other">] ?? 0 }));
}

export interface SpeedPart {
  key: "standard" | "fast" | "ultrafast";
  label: string;
  value: number;
  mix: number;
}

/** The parts of "Cost by speed", as T3 Code. null: no fast or ultrafast request, so the section does not show. */
export function speedParts(totals: UsageTotals): SpeedPart[] | null {
  const fast = totals.fast_cost ?? 0;
  const ultrafast = totals.ultrafast_cost ?? 0;
  if (fast + ultrafast <= 0) return null;
  return [
    { key: "standard", label: "Standard", value: Math.max(0, totals.cost - fast - ultrafast), mix: 34 },
    { key: "fast", label: "Fast", value: fast, mix: 66 },
    { key: "ultrafast", label: "Ultrafast", value: ultrafast, mix: 100 },
  ];
}

/** The current price of each model with use (custom or LiteLLM), for the placeholders of the "Model prices" dialog. */
export function modelRates(models: UsageModel[]): Record<string, UsageRate> {
  const out: Record<string, UsageRate> = {};
  for (const m of models) if (m.rate && !(m.model in out)) out[m.model] = m.rate;
  return out;
}

const DAY_LABEL = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** The label of a day key, as the daily labels of the daemon: "2026-11-16" -> "Nov 16". */
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? DAY_LABEL.format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : day;
}

/**
 * The series by day. An hourly series ("2026-11-16T14") becomes one point for each day ("2026-11-16", "Nov 16"),
 * with the sum of the cost and the tokens of each provider. A daily series stays as it is.
 */
export function groupByDay(series: UsagePoint[]): UsagePoint[] {
  if (!series.some((p) => p.key.includes("T"))) return series;
  const days = new Map<string, UsagePoint>();
  for (const p of series) {
    const key = p.key.slice(0, 10);
    let day = days.get(key);
    if (!day) {
      day = { key, label: dayLabel(key), by_provider: {} };
      days.set(key, day);
    }
    for (const [id, v] of Object.entries(p.by_provider)) {
      const sum = (day.by_provider[id] ??= { cost: 0, tokens: 0 });
      sum.cost += v.cost;
      sum.tokens += v.tokens;
    }
  }
  return [...days.values()];
}

export interface DayRow {
  key: string;
  label: string;
  values: Record<string, number>; // The metric of each shown provider.
  total: number; // The metric of the tab.
  cost: number;
  tokens: number;
}

/** The rows of the Day table: the periods with use, the newest first. */
export function dayRows(series: UsagePoint[], providers: { id: string }[], metric: UsageMetric): DayRow[] {
  const rows: DayRow[] = [];
  for (const p of series) {
    const values: Record<string, number> = {};
    let cost = 0;
    let tokens = 0;
    for (const { id } of providers) {
      const v = p.by_provider[id];
      values[id] = v?.[metric] ?? 0;
      cost += v?.cost ?? 0;
      tokens += v?.tokens ?? 0;
    }
    if (cost === 0 && tokens === 0) continue;
    rows.push({ key: p.key, label: p.label, values, total: metric === "cost" ? cost : tokens, cost, tokens });
  }
  return rows.reverse();
}

export interface MenuProvider {
  id: string;
  name: string;
  agent: string;
  icon: string | null;
  color?: string;
}

/** The providers of the menu: the providers with use, then the providers that only report limits. */
export function menuProviders(s: UsageSummary): MenuProvider[] {
  const out: MenuProvider[] = s.providers.map((p) => ({ id: p.id, name: p.name, agent: p.agent, icon: p.icon, color: p.color }));
  for (const l of s.limits) if (!out.some((p) => p.id === l.provider)) out.push({ id: l.provider, name: l.name, agent: l.agent, icon: l.icon });
  return out;
}

/** The label of the provider menu: "All providers", the name of the one shown provider, or "{n} providers". */
export function providerLabel(items: MenuProvider[], hidden: ReadonlySet<string>): string {
  const shown = items.filter((p) => !hidden.has(p.id));
  if (shown.length === items.length) return "All providers";
  if (shown.length === 1) return shown[0].name;
  return `${shown.length} providers`;
}

/** The hover tip of the info icon of the cost estimate. */
export function estimateTip(totals: UsageTotals): string {
  const base = "The cost that the API would charge for these tokens, with the prices of LiteLLM. A subscription pays a fixed price.";
  if (totals.unpriced_records <= 0) return base;
  return `${base} The estimate leaves out ${formatPercent(share(totals.unpriced_records, totals.records))} of the requests: their model has no price.`;
}

/** The title of the chart. */
export function chartTitle(resolution: UsageSummary["resolution"], metric: UsageMetric): string {
  const period = resolution === "hour" ? "Hourly" : "Daily";
  return metric === "cost" ? `${period} cost` : `${period} processed tokens`;
}

function ProviderMenu({ items, hidden, onToggle, onAll }: {
  items: MenuProvider[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const shown = items.filter((p) => !hidden.has(p.id)).length;

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const list = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus({ preventScroll: true });
  };

  return (
    <div className="usage-provider-menu" ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="usage-crumb-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={items.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        {providerLabel(items, hidden)}
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="menu usage-menu" role="menu" aria-label="Providers">
          <button type="button" role="menuitemcheckbox" aria-checked={shown === items.length} onClick={onAll}>
            <span className="usage-menu-label">All providers</span>
            {shown === items.length && <Check size={14} aria-hidden />}
          </button>
          <div className="menu-sep" role="separator" />
          {items.map((p) => {
            const on = !hidden.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                disabled={on && shown === 1}
                title={on && shown === 1 ? "One provider must show" : undefined}
                onClick={() => onToggle(p.id)}
              >
                <span className="usage-dot" style={{ background: p.color ?? "var(--text-muted)" }} aria-hidden />
                <AgentIcon id={p.agent} name={p.name} icon={p.icon} size={16} />
                <span className="usage-menu-label">{p.name}</span>
                {on && <Check size={14} aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Segmented<T extends string>({ label, items, value, onChange }: {
  label: string;
  items: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="segmented usage-seg" role="group" aria-label={label}>
      {items.map((i) => (
        <button key={i.id} type="button" aria-pressed={value === i.id} onClick={() => onChange(i.id)}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the usage">
      <div className="usage-overview">
        <div className="usage-side">
          <span className="skeleton usage-sk-total" />
          <span className="skeleton usage-sk-line" />
          <SkeletonRows count={3} className="usage-sk-rows" label="Loading the providers" />
        </div>
        <span className="skeleton usage-sk-chart" />
      </div>
      <p className="usage-note">Harness reads the histories of the agents. The first read can take a few seconds.</p>
    </div>
  );
}

function ProviderErrors({ summary }: { summary: UsageSummary }) {
  if (summary.errors.length === 0) return null;
  const nameOf = (id: string) => menuProviders(summary).find((p) => p.id === id)?.name ?? id;
  return (
    <ul className="usage-errors">
      {summary.errors.map((e, i) => (
        <li key={i}>
          {nameOf(e.provider)}: {e.message}
        </li>
      ))}
    </ul>
  );
}

function ShareBar({ parts, fmt }: { parts: { key: string; label: string; value: number; mix: number }[]; fmt: (n: number) => string }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  return (
    <>
      <div className="usage-types-bar" role="img" aria-label={parts.map((p) => `${p.label} ${fmt(p.value)}`).join(", ")}>
        {total > 0 &&
          parts
            .filter((p) => p.value > 0)
            .map((p) => (
              <span key={p.key} style={{ flexGrow: p.value, background: `color-mix(in srgb, var(--text) ${p.mix}%, var(--bg))` }} />
            ))}
      </div>
      <ul className="usage-legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className="usage-swatch" style={{ background: `color-mix(in srgb, var(--text) ${p.mix}%, var(--bg))` }} aria-hidden />
            {p.label} <span className="usage-legend-value">{fmt(p.value)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Overview({ summary, view, metric, onSetPrice }: {
  summary: UsageSummary;
  view: UsageView;
  metric: UsageMetric;
  onSetPrice: (model: string) => void;
}) {
  const [breakdown, setBreakdown] = useState<Breakdown>(() => (loadPref("usage.breakdown", "model") === "day" ? "day" : "model"));
  const { totals, providers } = view;
  const fmt = metric === "cost" ? formatUsd : formatTokens;
  const total = totals[metric];
  const parts = typeParts(summary, totals, metric);
  const speeds = metric === "cost" ? speedParts(totals) : null;
  const models = sortModels(view.models, metric);
  const peak = models.reduce((n, m) => Math.max(n, m[metric]), 0);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const rows = dayRows(groupByDay(summary.series), providers, metric);
  const chooseBreakdown = (b: Breakdown) => {
    setBreakdown(b);
    savePref("usage.breakdown", b);
  };

  return (
    <>
      <section className="usage-overview">
        <div className="usage-side">
          <div className="usage-total">{fmt(total)}</div>
          <div className="usage-total-sub">
            {plural(totals.sessions, "session", "sessions")}
            {metric === "cost" && (
              <>
                {" · API estimate"}
                <span className="usage-info" role="img" tabIndex={0} aria-label={estimateTip(totals)} title={estimateTip(totals)}>
                  <Info size={13} aria-hidden />
                </span>
              </>
            )}
          </div>
          {metric === "cost" && summary.pricing.status === "unavailable" && (
            <p className="usage-note">The prices are not available now. The cost shows only the costs that the agents reported.</p>
          )}
          <ul className="usage-providers">
            {providers.map((p) => (
              <li key={p.id} className="usage-provider">
                <div className="usage-provider-main">
                  <span className="usage-dot" style={{ background: p.color }} aria-hidden />
                  <AgentIcon id={p.agent} name={p.name} icon={p.icon} size={16} />
                  <span className="usage-provider-name">{p.name}</span>
                  <span className="usage-muted">{plural(p.sessions, "session", "sessions")}</span>
                  <span className="usage-provider-value">{fmt(p[metric])}</span>
                </div>
                <div className="usage-provider-sub">
                  {metric === "cost"
                    ? `${formatPercent(share(p.cost, totals.cost))} of cost · ${formatTokens(p.tokens)} tokens`
                    : `${formatPercent(share(p.tokens, totals.tokens))} of tokens · ${formatUsd(p.cost)}`}
                </div>
              </li>
            ))}
          </ul>
          <ProviderErrors summary={summary} />
        </div>
        <div className="usage-chart-col">
          <h2 className="usage-h2">{chartTitle(summary.resolution, metric)}</h2>
          <UsageChart points={summary.series} series={providers} metric={metric} label={chartTitle(summary.resolution, metric)} />
        </div>
      </section>

      <section className="usage-section" aria-labelledby="usage-totals">
        <h2 id="usage-totals" className="usage-h2">Totals</h2>
        <dl className="usage-totals">
          {[
            ["Processed tokens", formatTokens(totals.tokens)],
            ["Cached input", formatTokens(totals.cache_read)],
            ["Uncached input", formatTokens(totals.input)],
            ["Output", formatTokens(totals.output)],
            ["Cache savings", formatUsd(totals.cache_savings)],
          ].map(([label, value]) => (
            <div key={label} className="usage-total-cell">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="usage-section" aria-labelledby="usage-types">
        <h2 id="usage-types" className="usage-h2">{metric === "cost" ? "Cost by type" : "Tokens by type"}</h2>
        {metric === "cost" && view.filtered ? (
          <p className="usage-note">Cost by type shows all providers. Show all providers to see it.</p>
        ) : (
          <ShareBar parts={parts} fmt={fmt} />
        )}
      </section>

      {speeds && (
        <section className="usage-section" aria-labelledby="usage-speeds">
          <div className="usage-section-head">
            <h2 id="usage-speeds" className="usage-h2">Cost by speed</h2>
            <span className="usage-muted usage-premium">
              Premium <span className="usage-legend-value">{formatUsd(totals.premium ?? 0)}</span>
            </span>
          </div>
          <ShareBar parts={speeds} fmt={formatUsd} />
        </section>
      )}

      <section className="usage-section" aria-labelledby="usage-breakdown">
        <div className="usage-section-head">
          <h2 id="usage-breakdown" className="usage-h2">Breakdown</h2>
          <Segmented
            label="Breakdown"
            items={[
              { id: "model", label: "Model" },
              { id: "day", label: "Day" },
            ]}
            value={breakdown}
            onChange={chooseBreakdown}
          />
        </div>
        <div className="usage-table-wrap">
          {breakdown === "model" ? (
            <table className="usage-table">
              <thead>
                <tr>
                  <th scope="col" className="num narrow">#</th>
                  <th scope="col">Model</th>
                  <th scope="col" className="num">Cost</th>
                  <th scope="col" className="num">Share</th>
                  <th scope="col" className="num">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m, i) => {
                  const p = byId.get(m.provider);
                  const pct = peak > 0 ? (m[metric] / peak) * 100 : 0;
                  return (
                    <tr key={`${m.provider}\n${m.model}`}>
                      <td className="num narrow usage-muted">{i + 1}</td>
                      <td>
                        <div className="usage-model">
                          <AgentIcon id={p?.agent ?? m.provider} name={p?.name ?? m.provider} icon={p?.icon} size={14} />
                          <span className="usage-model-name" title={m.mapped_from?.length ? `${m.model}. Includes ${m.mapped_from.join(", ")}.` : m.model}>{m.model}</span>
                          {m.custom_price && <span className="usage-muted usage-model-tag" title="A custom price of Model prices prices this model.">Custom price</span>}
                        </div>
                        <span className="usage-model-track" aria-hidden>
                          <span className="usage-model-bar" style={{ width: `max(0.5rem, ${pct}%)`, background: p?.color ?? "var(--text-muted)" }} />
                        </span>
                      </td>
                      <td className="num">
                        {m.unpriced ? (
                          <span className="usage-unpriced">
                            <span className="usage-muted" title="This model has no price.">Unpriced</span>
                            <button type="button" className="link-btn" onClick={() => onSetPrice(m.model)}>Set price</button>
                          </span>
                        ) : (
                          formatUsd(m.cost)
                        )}
                      </td>
                      <td className="num">{formatPercent(share(m[metric], total))}</td>
                      <td className="num">{formatTokens(m.tokens)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="usage-table">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  {providers.map((p) => (
                    <th key={p.id} scope="col" className="num">{p.name}</th>
                  ))}
                  <th scope="col" className="num">Total</th>
                  <th scope="col" className="num">{metric === "cost" ? "Tokens" : "Cost"}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">{r.label}</th>
                    {providers.map((p) => (
                      <td key={p.id} className="num">{fmt(r.values[p.id])}</td>
                    ))}
                    <td className="num usage-strong">{fmt(r.total)}</td>
                    <td className="num">{metric === "cost" ? formatTokens(r.tokens) : formatUsd(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

const REPORTED = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The note of limits from the last session of an agent (Codex with no codex program). */
export function reportedText(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "From the last session." : `From the last session, ${REPORTED.format(at)}.`;
}

function Limits({ summary, hidden }: { summary: UsageSummary; hidden: ReadonlySet<string> }) {
  const limits = summary.limits.filter((l) => !hidden.has(l.provider));
  if (limits.length === 0) return <p className="usage-empty">No agent on this computer reports subscription limits.</p>;
  return (
    <div className="usage-limits">
      {limits.map((l) => (
        <section key={l.provider} className="usage-limit" aria-label={l.name}>
          <div className="usage-limit-head">
            <AgentIcon id={l.agent} name={l.name} icon={l.icon} size={18} />
            <h2 className="usage-h2">{l.name}</h2>
          </div>
          {l.windows.length > 0 ? <LimitRows usage={l.windows} used /> : <p className="usage-note">This agent reports no limits now.</p>}
          {l.reported_at && <p className="usage-note">{reportedText(l.reported_at)}</p>}
        </section>
      ))}
    </div>
  );
}

export function UsagePage({ conn, computerKey, computer, onClose }: {
  conn: DaemonConnection;
  computerKey: string; // The id of the connection: the cache keeps the summaries of each computer.
  computer: string; // The name of the computer, for the breadcrumb.
  onClose: () => void; // Goes back to the previous view.
}) {
  const [range, setRange] = useState<UsageRange>(() => parseRange(loadPref("usage.range", "30d")));
  const [tab, setTab] = useState<UsageTab>(() => parseTab(loadPref("usage.tab", "cost")));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<Partial<Record<UsageRange, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const [pricesFor, setPricesFor] = useState<string | null | undefined>(undefined); // undefined: closed. A model: "Set price".
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const keyRef = useRef(computerKey);
  keyRef.current = computerKey;

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "usage.summary") {
          const { type: _type, ...summary } = msg;
          cache.set(cacheKey(keyRef.current, summary.range), summary);
          setPending((p) => ({ ...p, [summary.range]: false }));
          setError(null);
          bump();
        } else if (msg.type === "error" && msg.ref === "usage.summary") {
          setPending({});
          setError(msg.message);
        }
      }),
    [conn],
  );

  const request = useCallback(
    (r: UsageRange, refresh = false) => {
      setError(null);
      setPending((p) => ({ ...p, [r]: true }));
      try {
        conn.send({ type: "usage.summary", range: r, offset: -new Date().getTimezoneOffset(), ...(refresh ? { refresh: true } : {}) });
      } catch {
        setPending((p) => ({ ...p, [r]: false }));
        setError("Connect to a computer to see its usage.");
      }
    },
    [conn],
  );
  useEffect(() => request(range), [request, range, computerKey]);

  const chooseRange = (r: UsageRange) => {
    setRange(r);
    savePref("usage.range", r);
  };
  const chooseTab = (t: UsageTab) => {
    setTab(t);
    savePref("usage.tab", t);
  };

  const onPricesSaved = useCallback(() => {
    setPricesFor(undefined);
    for (const key of [...cache.keys()]) if (key.startsWith(`${computerKey}\n`)) cache.delete(key); // Old prices.
    request(range);
  }, [computerKey, range, request]);

  const summary = cache.get(cacheKey(computerKey, range)) ?? null;
  const loading = !!pending[range];
  const view = summary ? filterSummary(summary, hidden) : null;
  const empty = !!summary && summary.providers.length === 0;

  let body: React.ReactNode;
  if (!summary) {
    body = error ? null : tab === "limits" ? <SkeletonRows count={4} label="Loading the limits" /> : <UsageSkeleton />;
  } else if (tab === "limits") {
    body = <Limits summary={summary} hidden={hidden} />;
  } else if (empty || !view) {
    body = (
      <>
        <p className="usage-empty">No activity in this range.</p>
        <ProviderErrors summary={summary} />
      </>
    );
  } else {
    body = <Overview summary={summary} view={view} metric={tab} onSetPrice={(model) => setPricesFor(model)} />;
  }

  return (
    <div className="usage-page">
      <header className="usage-head">
        <nav className="usage-crumbs" aria-label="Breadcrumb">
          <h1 id="usage-title" className="usage-crumb-title">Usage</h1>
          <span className="usage-crumb-sep" aria-hidden>/</span>
          <span className="usage-crumb" title={computer}>{computer}</span>
          <span className="usage-crumb-sep" aria-hidden>/</span>
          <ProviderMenu
            items={summary ? menuProviders(summary) : []}
            hidden={hidden}
            onToggle={(id) =>
              setHidden((h) => {
                const next = new Set(h);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onAll={() => setHidden(new Set())}
          />
        </nav>
        <div className="usage-head-actions">
          {tab !== "limits" && <Segmented label="Range" items={RANGES} value={range} onChange={chooseRange} />}
          <Segmented label="View" items={TABS} value={tab} onChange={chooseTab} />
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="Model prices"
            title="Model prices"
            disabled={!summary}
            onClick={() => setPricesFor(null)}
          >
            <CircleDollarSign size={15} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="Read the histories again"
            aria-busy={loading}
            title="Read the histories again"
            onClick={() => !loading && request(range, true)}
          >
            <RefreshCw size={15} className={loading ? "spin" : undefined} aria-hidden />
          </button>
          <button type="button" className="icon-btn ghost" aria-label="Close" title="Close" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
      <div className="usage-body" role="region" aria-labelledby="usage-title" aria-busy={loading}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {body}
      </div>
      {pricesFor !== undefined && summary && (
        <UsagePricesDialog
          conn={conn}
          computer={computer}
          prices={summary.prices ?? {}}
          rates={modelRates(summary.models)}
          add={pricesFor}
          onSaved={onPricesSaved}
          onClose={() => setPricesFor(undefined)}
        />
      )}
    </div>
  );
}
