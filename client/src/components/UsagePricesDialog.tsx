// The "Model prices" dialog of the Usage page, as the custom model prices of T3 Code (MIT): a price for each model id
// (USD for one million tokens) replaces the automatic LiteLLM price, and "Map to" counts the tokens of a model as
// another model. The daemon keeps them (usage.prices.set, ~/.harness/usage-model-prices.json).

import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, Plus, Trash2, X } from "lucide-react";
import type { DaemonConnection } from "../daemon/connection";
import type { UsageModelPrice, UsageRate } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";

export interface PriceRow {
  key: number; // A stable React key.
  model: string;
  map_to: string;
  input: string;
  output: string;
  cache_read: string;
  cache_write: string;
}

const PRICE_KEYS = ["input", "output", "cache_read", "cache_write"] as const;

let nextKey = 1;

export function emptyRow(model = ""): PriceRow {
  return { key: nextKey++, model, map_to: "", input: "", output: "", cache_read: "", cache_write: "" };
}

/** The rows of the saved prices, sorted by model id, then a new row for `add` when it has no row. */
export function priceRows(prices: Record<string, UsageModelPrice>, add?: string | null): PriceRow[] {
  const rows = Object.keys(prices)
    .sort((a, b) => a.localeCompare(b))
    .map((model) => {
      const p = prices[model];
      const text = (v: number | undefined) => (v === undefined ? "" : String(v));
      return { ...emptyRow(model), map_to: p.map_to ?? "", input: text(p.input), output: text(p.output), cache_read: text(p.cache_read), cache_write: text(p.cache_write) };
    });
  if (add && !rows.some((r) => r.model === add)) rows.push(emptyRow(add));
  return rows;
}

/** The models for usage.prices.set, or the first error. An empty row (no id, no value) is ignored. */
export function rowsToModels(rows: PriceRow[]): { models: Record<string, UsageModelPrice> } | { error: string } {
  const models: Record<string, UsageModelPrice> = {};
  for (const row of rows) {
    const model = row.model.trim();
    const values = PRICE_KEYS.map((k) => row[k].trim());
    const mapTo = row.map_to.trim();
    if (!model && !mapTo && values.every((v) => !v)) continue;
    if (!model) return { error: "Enter a model ID." };
    if (model in models) return { error: `${model} has two rows. Keep one.` };
    const entry: UsageModelPrice = {};
    for (const [i, k] of PRICE_KEYS.entries()) {
      if (!values[i]) continue;
      const n = Number(values[i]);
      if (!Number.isFinite(n) || n < 0) return { error: `The ${k.replace("_", " ")} price of ${model} must be a number from 0.` };
      entry[k] = n;
    }
    const hasPrice = entry.input !== undefined && entry.output !== undefined;
    if (!hasPrice && values.some((v) => v)) return { error: `${model} needs an input price and an output price.` };
    if (mapTo && mapTo !== model) entry.map_to = mapTo;
    if (!hasPrice && !entry.map_to) return { error: `Enter prices or a "Map to" model for ${model}.` };
    models[model] = entry;
  }
  return { models };
}

const fmtRate = (n: number) => String(Number(n.toPrecision(4)));

export function UsagePricesDialog({ conn, computer, prices, rates, add, onSaved, onClose }: {
  conn: DaemonConnection;
  computer: string;
  prices: Record<string, UsageModelPrice>; // The saved custom prices.
  rates: Record<string, UsageRate>; // The current price of each model with use, for the placeholders.
  add: string | null; // A model to add a row for ("Set price").
  onSaved: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const close = useRef<HTMLButtonElement>(null);
  const [rows, setRows] = useState<PriceRow[]>(() => priceRows(prices, add));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const added = useRef<HTMLInputElement>(null);
  useOverlay(true);

  useEffect(() => (add ? added.current?.focus() : close.current?.focus()), [add]);

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "usage.prices") {
          setBusy(false);
          onSaved();
        } else if (msg.type === "error" && msg.ref === "usage.prices.set") {
          setBusy(false);
          setError(msg.message);
        }
      }),
    [conn, onSaved],
  );

  const update = (key: number, field: keyof Omit<PriceRow, "key">, value: string) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, [field]: value } : r)));

  const save = () => {
    const result = rowsToModels(rows);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      conn.send({ type: "usage.prices.set", models: result.models });
    } catch {
      setBusy(false);
      setError("Connect to a computer to change its model prices.");
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal usage-prices-dialog"
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
          <h2 id={`${id}-title`}>Model prices</h2>
          <button ref={close} type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="usage-prices-body">
          <p className="help">
            USD for one million tokens. A custom price replaces the automatic price for all the history on {computer}. A
            blank cache price is the input price. "Map to" counts the tokens of a model as another model, with the price of
            that model.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {rows.length === 0 ? (
            <p className="usage-note">No custom prices or mappings. Add a row to set one.</p>
          ) : (
            <div className="usage-table-wrap">
              <table className="usage-table usage-prices-table">
                <thead>
                  <tr>
                    <th scope="col">Model ID</th>
                    <th scope="col">Map to</th>
                    <th scope="col" className="num">Input</th>
                    <th scope="col" className="num">Output</th>
                    <th scope="col" className="num">Cache read</th>
                    <th scope="col" className="num">Cache write</th>
                    <th scope="col" className="narrow"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const auto = rates[r.model.trim()];
                    const holder = (k: (typeof PRICE_KEYS)[number]) =>
                      k === "cache_read" || k === "cache_write" ? (r.input.trim() || (auto ? fmtRate(auto[k]) : "Optional")) : auto ? fmtRate(auto[k]) : "";
                    return (
                      <tr key={r.key}>
                        <td>
                          <input
                            ref={r.model === add ? added : undefined}
                            className="mono"
                            value={r.model}
                            aria-label="Model ID"
                            placeholder="New model ID"
                            spellCheck={false}
                            onChange={(e) => update(r.key, "model", e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            className="mono"
                            value={r.map_to}
                            aria-label={`Map ${r.model || "the new model"} to`}
                            placeholder="Optional"
                            spellCheck={false}
                            onChange={(e) => update(r.key, "map_to", e.target.value)}
                          />
                        </td>
                        {PRICE_KEYS.map((k) => (
                          <td key={k} className="num">
                            <input
                              className="usage-price-input"
                              inputMode="decimal"
                              value={r[k]}
                              aria-label={`${k === "input" ? "Input" : k === "output" ? "Output" : k === "cache_read" ? "Cache read" : "Cache write"} price of ${r.model || "the new model"}`}
                              placeholder={holder(k)}
                              onChange={(e) => update(r.key, k, e.target.value)}
                            />
                          </td>
                        ))}
                        <td className="narrow">
                          <button
                            type="button"
                            className="icon-btn ghost"
                            aria-label={`Reset ${r.model || "the new model"} to the automatic price`}
                            title="Reset to automatic"
                            onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <button type="button" className="btn btn-small btn-ghost usage-prices-add" onClick={() => setRows((list) => [...list, emptyRow()])}>
            <Plus size={14} aria-hidden />
            Add model price
          </button>
        </div>
        <footer className="storage-foot">
          <button type="button" className="btn btn-small" onClick={onClose}>
            Discard changes
          </button>
          <button type="button" className="btn btn-small btn-primary" onClick={save} disabled={busy}>
            {busy && <LoaderCircle size={14} className="spin" aria-hidden />}
            {busy ? "Saving…" : "Save changes"}
          </button>
        </footer>
      </div>
    </div>
  );
}
