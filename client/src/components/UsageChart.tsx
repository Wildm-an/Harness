// The chart of the Usage page (UsagePage.tsx), as the UsageProviderChart of T3 Code (MIT): one area for each
// provider (not stacked), with a smooth monotone line, a "nice" y scale with 4 ticks, and a hover tip with the
// value of each provider and the total. A custom SVG: no chart library.

import { useRef, useState } from "react";
import type { UsagePoint } from "../daemon/protocol";
import { formatCount, formatTokens, formatUsd } from "../lib/usageFormat";

export type UsageMetric = "cost" | "tokens";

/** The size of the SVG view box. The SVG stretches to the width of the page (preserveAspectRatio="none"). */
export const VIEW_W = 960;
export const VIEW_H = 260;
const PAD_TOP = 10; // Space over the top tick, for the stroke.
const PAD_BOTTOM = 2;

/** The step of a "nice" scale: 1, 2, 2.5, or 5 times a power of 10, the smallest that is at least `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const f = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return Number((f * mag).toPrecision(12));
}

/** A y scale with `count` ticks from 0. The top tick is at `max` or over it. `minStep`: 1 for token counts. */
export function niceScale(max: number, count = 4, minStep = 0): { max: number; step: number; ticks: number[] } {
  const intervals = Math.max(1, count - 1);
  const step = Math.max(niceStep(max / intervals), minStep);
  const ticks = Array.from({ length: intervals + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  return { max: ticks[ticks.length - 1], step, ticks };
}

/** The label of a y tick: "$1.5K", "$250", "$0.25", "$0.005", or "1.5M" tokens. */
export function tickLabel(value: number, step: number, metric: UsageMetric): string {
  if (metric === "tokens") return formatTokens(value);
  if (value === 0) return "$0";
  if (step >= 1000) return `$${formatTokens(value)}`;
  if (step >= 1) return `$${formatCount(value)}`;
  if (step >= 0.01) return formatUsd(value);
  const decimals = Math.min(6, Math.ceil(-Math.log10(step)));
  return `$${value.toFixed(decimals)}`;
}

/**
 * A smooth line through the points that does not go over or under the points (a monotone cubic curve,
 * Fritsch-Butland tangents, as curveMonotoneX of d3). The x values must increase.
 */
export function monotonePath(points: [number, number][]): string {
  const n = points.length;
  if (n === 0) return "";
  const f = (v: number) => Number(v.toFixed(2));
  const [x0, y0] = points[0];
  if (n === 1) return `M${f(x0)},${f(y0)}`;
  const d: number[] = []; // The slope of each segment.
  for (let i = 0; i < n - 1; i++) {
    const h = points[i + 1][0] - points[i][0];
    d.push(h ? (points[i + 1][1] - points[i][1]) / h : 0);
  }
  const m: number[] = new Array(n).fill(0); // The tangent at each point.
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue; // A peak, a valley, or a flat part: a flat tangent.
    const h0 = points[i][0] - points[i - 1][0];
    const h1 = points[i + 1][0] - points[i][0];
    m[i] = (3 * (h0 + h1)) / ((2 * h1 + h0) / d[i - 1] + (h1 + 2 * h0) / d[i]);
  }
  let path = `M${f(x0)},${f(y0)}`;
  for (let i = 0; i < n - 1; i++) {
    const [xa, ya] = points[i];
    const [xb, yb] = points[i + 1];
    const dx = (xb - xa) / 3;
    path += `C${f(xa + dx)},${f(ya + m[i] * dx)},${f(xb - dx)},${f(yb - m[i + 1] * dx)},${f(xb)},${f(yb)}`;
  }
  return path;
}

/** The x of each point in the view box. One point is in the center. */
export function pointX(i: number, n: number): number {
  return n > 1 ? (i / (n - 1)) * VIEW_W : VIEW_W / 2;
}

/** The y of a value in the view box. */
export function valueY(value: number, max: number): number {
  const h = VIEW_H - PAD_TOP - PAD_BOTTOM;
  return VIEW_H - PAD_BOTTOM - (max > 0 ? Math.min(1, Math.max(0, value / max)) : 0) * h;
}

/** The value of a provider at a point. */
export function pointValue(p: UsagePoint, provider: string, metric: UsageMetric): number {
  return p.by_provider[provider]?.[metric] ?? 0;
}

export interface ChartSeries {
  id: string;
  name: string;
  color: string;
}

/** The index of the point nearest to a fraction (0 to 1) of the width. */
export function nearestIndex(fraction: number, n: number): number {
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.max(0, Math.round(fraction * (n - 1))));
}

export function UsageChart({ points, series, metric, label }: {
  points: UsagePoint[];
  series: ChartSeries[]; // The shown providers, in the order of the legend.
  metric: UsageMetric;
  label: string; // "Daily cost", for the screen readers.
}) {
  const [hover, setHover] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  const n = points.length;
  const fmt = metric === "cost" ? formatUsd : formatTokens;

  let peak = 0;
  for (const p of points) for (const s of series) peak = Math.max(peak, pointValue(p, s.id, metric));
  const scale = niceScale(peak, 4, metric === "tokens" ? 1 : 0);

  const paths = series.map((s) => {
    const pts = points.map((p, i) => [pointX(i, n), valueY(pointValue(p, s.id, metric), scale.max)] as [number, number]);
    const line = monotonePath(pts);
    const base = valueY(0, scale.max);
    const area = pts.length > 1 ? `${line}L${pts[pts.length - 1][0]},${base}L${pts[0][0]},${base}Z` : "";
    return { s, line, area };
  });

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = plot.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || n === 0) return;
    setHover(nearestIndex((e.clientX - box.left) / box.width, n));
  };

  const hovered = hover !== null ? points[hover] : null;
  const total = (p: UsagePoint) => series.reduce((sum, s) => sum + pointValue(p, s.id, metric), 0);
  const xLabels = n === 0 ? [] : n === 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];
  const hoverLeft = hover !== null ? (pointX(hover, n) / VIEW_W) * 100 : 0;

  return (
    <div className="usage-chart">
      <div className="usage-chart-frame" aria-hidden>
        <div className="usage-chart-gutter">
          {scale.ticks.map((t) => (
            <span key={t} className="usage-chart-tick" style={{ top: `${(valueY(t, scale.max) / VIEW_H) * 100}%` }}>
              {tickLabel(t, scale.step, metric)}
            </span>
          ))}
        </div>
        <div className="usage-chart-plot" ref={plot} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" className="usage-chart-svg">
            {scale.ticks.map((t) => {
              const y = valueY(t, scale.max);
              return <line key={t} className="usage-chart-grid" x1={0} x2={VIEW_W} y1={y} y2={y} vectorEffect="non-scaling-stroke" />;
            })}
            {paths.map(({ s, area }) => area && <path key={`a-${s.id}`} d={area} fill={s.color} fillOpacity={0.12} stroke="none" />)}
            {paths.map(({ s, line }) => (
              <path key={`l-${s.id}`} d={line} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            ))}
            {hover !== null && (
              <line className="usage-chart-cursor" x1={pointX(hover, n)} x2={pointX(hover, n)} y1={0} y2={VIEW_H} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {hovered && (
            <div className={`usage-chart-tip${hoverLeft > 60 ? " left" : ""}`} style={{ left: `${hoverLeft}%` }}>
              <div className="usage-chart-tip-head">{hovered.label}</div>
              {series.map((s) => (
                <div key={s.id} className="usage-chart-tip-row">
                  <span className="usage-dot" style={{ background: s.color }} />
                  <span className="usage-chart-tip-name">{s.name}</span>
                  <span className="usage-chart-tip-value">{fmt(pointValue(hovered, s.id, metric))}</span>
                </div>
              ))}
              {series.length > 1 && (
                <div className="usage-chart-tip-row total">
                  <span className="usage-chart-tip-name">Total</span>
                  <span className="usage-chart-tip-value">{fmt(total(hovered))}</span>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="usage-chart-x">
          {xLabels.map((i) => (
            <span key={i} className={`usage-chart-xlabel${i === 0 ? " first" : i === n - 1 ? " last" : ""}`} style={{ left: `${(pointX(i, n) / VIEW_W) * 100}%` }}>
              {points[i].label}
            </span>
          ))}
        </div>
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {series.map((s) => (
              <th key={s.id} scope="col">{s.name}</th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <th scope="row">{p.label}</th>
              {series.map((s) => (
                <td key={s.id}>{fmt(pointValue(p, s.id, metric))}</td>
              ))}
              <td>{fmt(total(p))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
