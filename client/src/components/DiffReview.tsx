import { Fragment, memo, useMemo, useState } from "react";
import { Check, Clock, Columns2, FileDiff, Rows3, ShieldAlert, X } from "lucide-react";
import type { PermissionItem } from "../chat/state";
import type { Decision } from "../daemon/protocol";
import { parseUnifiedDiff, toSplitRows, wordSegments, type DiffLine, type Hunk, type Segment } from "../lib/diff";
import { loadPref, savePref } from "../lib/prefs";

type Mode = "split" | "unified";

const DECISION_LABEL: Record<Decision, string> = {
  allow_once: "Allowed once",
  allow_always: "Always allowed",
  deny: "Denied",
};

function Segments({ segments, kind }: { segments: Segment[]; kind: "add" | "del" }) {
  return (
    <>
      {segments.map((s, i) =>
        s.changed ? (
          <mark key={i} className={`word-${kind}`}>
            {s.text}
          </mark>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  );
}

function HunkHeader({ hunk, colSpan }: { hunk: Hunk; colSpan: number }) {
  return (
    <tr className="dr-hunk">
      <td colSpan={colSpan}>
        @@ -{hunk.oldStart} +{hunk.newStart} @@ {hunk.header}
      </td>
    </tr>
  );
}

function SplitHunk({ hunk }: { hunk: Hunk }) {
  const rows = useMemo(() => toSplitRows(hunk), [hunk]);
  return (
    <>
      <HunkHeader hunk={hunk} colSpan={4} />
      {rows.map((row, i) => {
        const { left, right } = row;
        const words = left?.kind === "del" && right?.kind === "add" ? wordSegments(left.text, right.text) : null;
        return (
          <tr key={i}>
            <td className={`dr-num ${left ? `dr-${left.kind}` : "dr-empty"}`}>{left?.oldNo}</td>
            <td className={`dr-code ${left ? `dr-${left.kind}` : "dr-empty"}`}>
              {words ? <Segments segments={words.left} kind="del" /> : left?.text}
            </td>
            <td className={`dr-num dr-num-right ${right ? `dr-${right.kind}` : "dr-empty"}`}>{right?.newNo}</td>
            <td className={`dr-code ${right ? `dr-${right.kind}` : "dr-empty"}`}>
              {words ? <Segments segments={words.right} kind="add" /> : right?.text}
            </td>
          </tr>
        );
      })}
    </>
  );
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", context: " " };

function UnifiedHunk({ hunk }: { hunk: Hunk }) {
  return (
    <>
      <HunkHeader hunk={hunk} colSpan={3} />
      {hunk.lines.map((line, i) => (
        <tr key={i}>
          <td className={`dr-num dr-${line.kind}`}>{line.oldNo}</td>
          <td className={`dr-num dr-${line.kind}`}>{line.newNo}</td>
          <td className={`dr-code dr-${line.kind}`}>
            <span className="dr-sign" aria-hidden>
              {SIGN[line.kind]}
            </span>
            {line.text}
          </td>
        </tr>
      ))}
    </>
  );
}

export const DiffReview = memo(function DiffReview({
  diff,
  permission,
  onDecide,
  onClose,
}: {
  diff: string;
  permission: PermissionItem | null; // Set when the diff belongs to an approval request.
  onDecide: (requestId: string, decision: Decision) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>(() => (loadPref("diffMode", "split") === "unified" ? "unified" : "split"));
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const pending = permission !== null && permission.decision === undefined && !permission.expired;

  const changeMode = (next: Mode) => {
    setMode(next);
    savePref("diffMode", next);
  };

  // Shortcuts work only when the pane has focus, so that text typed in the prompt box never approves a change.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!pending || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const decision = ({ "1": "allow_once", "2": "allow_always", "3": "deny" } as const)[e.key as "1" | "2" | "3"];
    if (decision) {
      e.preventDefault();
      onDecide(permission.id, decision);
    }
  };

  return (
    <section className="side-pane diff-review" aria-label="Diff review" tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="pane-head">
        <FileDiff size={16} aria-hidden className="pane-icon" />
        <span className="pane-title mono" title={parsed.path}>
          {parsed.path || "Change"}
        </span>
        <span className="diff-stats" aria-label={`${parsed.added} lines added, ${parsed.removed} lines removed`}>
          <span className="stat-add">+{parsed.added}</span>
          <span className="stat-del">−{parsed.removed}</span>
        </span>
        <div className="segmented" role="group" aria-label="Diff layout">
          <button
            type="button"
            aria-pressed={mode === "split"}
            onClick={() => changeMode("split")}
            title="Side by side"
            aria-label="Side by side"
          >
            <Columns2 size={14} aria-hidden />
          </button>
          <button
            type="button"
            aria-pressed={mode === "unified"}
            onClick={() => changeMode("unified")}
            title="Unified"
            aria-label="Unified"
          >
            <Rows3 size={14} aria-hidden />
          </button>
        </div>
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close diff review" title="Close">
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="dr-scroll">
        {parsed.hunks.length === 0 ? (
          <p className="pane-empty">The change has no lines to show.</p>
        ) : (
          <table className={`dr-table dr-${mode}`}>
            <colgroup>
              {mode === "split" ? (
                <>
                  <col className="dr-col-num" />
                  <col />
                  <col className="dr-col-num" />
                  <col />
                </>
              ) : (
                <>
                  <col className="dr-col-num" />
                  <col className="dr-col-num" />
                  <col />
                </>
              )}
            </colgroup>
            <tbody>
              {parsed.hunks.map((hunk, i) =>
                mode === "split" ? <SplitHunk key={i} hunk={hunk} /> : <UnifiedHunk key={i} hunk={hunk} />,
              )}
            </tbody>
          </table>
        )}
      </div>

      {permission && (
        <footer className={`pane-foot${pending ? " pending" : ""}`}>
          {pending ? (
            <>
              <div className="pane-foot-title">
                <ShieldAlert size={16} aria-hidden />
                Apply this change?
              </div>
              <div className="permission-actions">
                <button type="button" className="btn btn-primary" onClick={() => onDecide(permission.id, "allow_once")}>
                  Allow once <kbd>1</kbd>
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onDecide(permission.id, "allow_always")}
                  title={`Adds ${permission.rule} to the project permission rules`}
                >
                  Always allow <kbd>2</kbd>
                </button>
                <button type="button" className="btn btn-danger" onClick={() => onDecide(permission.id, "deny")}>
                  Deny <kbd>3</kbd>
                </button>
              </div>
              <p className="help">
                "Always allow" adds the rule <code>{permission.rule}</code>. Click this pane to use the number keys.
              </p>
            </>
          ) : (
            <div className={`pane-foot-status ${permission.decision === "deny" ? "denied" : permission.decision ? "allowed" : ""}`}>
              {permission.decision === "deny" ? (
                <X size={15} aria-hidden />
              ) : permission.decision ? (
                <Check size={15} aria-hidden />
              ) : (
                <Clock size={15} aria-hidden />
              )}
              {permission.decision ? DECISION_LABEL[permission.decision] : "The turn ended with no decision."}
            </div>
          )}
        </footer>
      )}
    </section>
  );
});
