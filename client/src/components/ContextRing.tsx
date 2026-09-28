import { useEffect, useRef, useState } from "react";
import { Archive, LoaderCircle } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { contextRows, contextSourceText, formatTokens, type ContextUsage } from "../lib/context";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function percent(share: number): string {
  const p = share * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
}

/**
 * The context use: a ring next to the model, as in Claude Code. A click opens the breakdown of
 * the next request: the parts, the free space, and the compaction buffer.
 */
export function ContextRing({
  tokens,
  length,
  source,
  usage,
  running,
  onOpen,
  onCompact,
}: {
  tokens: number;
  length: number;
  source?: string;
  usage: ContextUsage | null; // The last context.usage reply.
  running: boolean; // A turn runs: "Compact now" waits.
  onOpen: () => void; // Asks the daemon for the breakdown.
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  const share = length > 0 ? Math.min(tokens / length, 1) : 0;
  const compactAt = usage?.compact_at ?? 0.8;
  const level = share >= compactAt ? "high" : share >= 0.6 ? "mid" : "low";

  useEffect(() => {
    if (!open) return;
    onOpen();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Ask again after each change while the view is open, for example after a turn.
  useEffect(() => {
    if (open) onOpen();
  }, [tokens, length]);

  const rows = usage ? contextRows(usage) : [];
  return (
    <div className="context-ring-wrap" ref={ref} onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), setOpen(false))}>
      <button
        type="button"
        className={`context-ring context-${level}${open ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Context: ${formatTokens(tokens)} of ${formatTokens(length)} tokens (${percent(share)}). Show the breakdown.`}
        title={`Context: ${formatTokens(tokens)} / ${formatTokens(length)} tokens (${percent(share)})`}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle className="ring-track" cx="9" cy="9" r={RADIUS} />
          <circle
            className="ring-fill"
            cx="9"
            cy="9"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - share)}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </button>
      {open && (
        <div className="menu context-panel" role="dialog" aria-label="Context use">
          <div className="context-head">
            <span className="context-title">Context</span>
            <span className="context-total mono">
              {formatTokens(usage?.tokens ?? tokens)} / {formatTokens(usage?.length ?? length)} tokens · {percent(share)}
            </span>
          </div>
          {!usage ? (
            <p className="menu-note">
              <LoaderCircle size={14} className="spin" aria-hidden /> Reading the context.
            </p>
          ) : (
            <>
              <div className="context-bar" aria-hidden>
                {rows.map((r) => (r.share > 0 ? <span key={r.kind} className={`ctx-${r.kind}`} style={{ width: `${r.share * 100}%` }} /> : null))}
              </div>
              <ul className="context-list">
                {rows.map((r) => (
                  <li key={r.kind}>
                    <span className={`context-dot ctx-${r.kind}`} aria-hidden />
                    <span className="context-label">{r.label}</span>
                    <span className="context-tokens mono">{formatTokens(r.tokens)}</span>
                    <span className="context-share mono">{percent(r.share)}</span>
                  </li>
                ))}
              </ul>
              <p className="context-note">
                The agent summarizes the old turns at {Math.round(compactAt * 100)}% of the context. {contextSourceText(source ?? usage.source)}
              </p>
            </>
          )}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            className="context-compact"
            disabled={running}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
            title={running ? "Wait for the end of the turn." : "Summarize the old turns now (/compact)."}
          >
            <Archive size={14} aria-hidden />
            Compact now
          </button>
        </div>
      )}
    </div>
  );
}
