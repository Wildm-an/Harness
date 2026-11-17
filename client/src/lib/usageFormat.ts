// The number formats of the Usage page (UsagePage.tsx), with the rules of the Usage page of T3 Code (MIT).

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

/** "$6,784.98". */
export function formatUsd(n: number): string {
  return USD.format(finite(n));
}

/** "1,234". */
export function formatCount(n: number): string {
  return COUNT.format(finite(n));
}

const UNITS: [string, number][] = [
  ["K", 1e3],
  ["M", 1e6],
  ["B", 1e9],
  ["T", 1e12],
];

/** A number with 2 decimals under 10, 1 decimal under 100, and no decimals from 100. Zeros at the end go away. */
function short(v: number): string {
  const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
  const text = v.toFixed(digits);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** "812", "152K", "1.25M", "16.5B". The unit comes after the rounding: 999,950 is "1M", not "1000K". */
export function formatTokens(n: number): string {
  const value = finite(n);
  const sign = value < 0 ? "-" : "";
  const a = Math.abs(value);
  if (Math.round(a) < 1000) return `${sign}${Math.round(a)}`;
  for (let i = 0; i < UNITS.length; i++) {
    const [unit, size] = UNITS[i];
    const text = short(a / size);
    if (Number(text) < 1000 || i === UNITS.length - 1) return `${sign}${text}${unit}`;
  }
  return `${sign}${Math.round(a)}`;
}

/** A percent (0 to 100) with 1 decimal: "12.3%". A value over 0 and under 0.1 is "<0.1%". */
export function formatPercent(pct: number): string {
  const v = finite(pct);
  if (v > 0 && v < 0.1) return "<0.1%";
  return `${v.toFixed(1)}%`;
}

/** The share of a part in a total, as a percent. 0 when the total is 0. */
export function share(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}
