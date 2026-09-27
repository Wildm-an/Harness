import { memo, useEffect, useState } from "react";
import { Check, LoaderCircle, Plus, ShieldCheck, X } from "lucide-react";

export interface Rules {
  path: string;
  allow: string[];
  deny: string[];
}

type Kind = "allow" | "deny";

// The same rule form as the daemon: tool, tool(pattern), or a tool prefix with "*" (mcp__server__*).
const RULE_RE = /^[A-Za-z0-9_-]+\*?(\(.*\))?$/s;

function RuleList({
  kind,
  rules,
  busy,
  onChange,
}: {
  kind: Kind;
  rules: string[];
  busy: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = `rule-${kind}`;

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const rule = draft.trim();
    if (!rule) return;
    if (!RULE_RE.test(rule)) {
      setError("Use tool or tool(pattern). Example: bash(npm test)");
      return;
    }
    setError(null);
    setDraft("");
    if (!rules.includes(rule)) onChange([...rules, rule]);
  };

  return (
    <section className="rules-section" aria-labelledby={`${inputId}-title`}>
      <h3 id={`${inputId}-title`}>{kind === "allow" ? "Allow" : "Deny"}</h3>
      <p className="help">
        {kind === "allow"
          ? "These tool calls run with no approval request."
          : "These tool calls never run. A deny rule has priority over an allow rule."}
      </p>
      {rules.length === 0 ? (
        <p className="rules-empty">No rules.</p>
      ) : (
        <ul className="rules-list">
          {rules.map((rule) => (
            <li key={rule}>
              <code>{rule}</code>
              <button
                type="button"
                className="icon-btn ghost"
                disabled={busy}
                onClick={() => onChange(rules.filter((r) => r !== rule))}
                aria-label={`Remove rule ${rule}`}
                title="Remove"
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="rules-add" onSubmit={add}>
        <label htmlFor={inputId} className="sr-only">
          New {kind} rule
        </label>
        <input
          id={inputId}
          className="mono"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          placeholder={kind === "allow" ? "bash(npm test)" : "bash(rm:*)"}
          spellCheck={false}
          aria-invalid={error !== null}
          aria-describedby={error ? `${inputId}-error` : undefined}
        />
        <button type="submit" className="btn" disabled={busy || !draft.trim()}>
          <Plus size={14} aria-hidden />
          Add
        </button>
      </form>
      {error && (
        <p id={`${inputId}-error`} className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export const RulesPanel = memo(function RulesPanel({
  rules,
  busy,
  savedAt,
  onSave,
  onClose,
}: {
  rules: Rules | null;
  busy: boolean;
  savedAt: number | null; // When the daemon confirmed the last save.
  onSave: (allow: string[], deny: string[]) => void;
  onClose: () => void;
}) {
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (savedAt === null) return;
    setShowSaved(true);
    const timer = window.setTimeout(() => setShowSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  return (
    <section className="side-pane rules-panel" aria-label="Permission rules">
      <header className="pane-head">
        <ShieldCheck size={16} aria-hidden className="pane-icon" />
        <span className="pane-title">Permission rules</span>
        <span className="pane-status" role="status">
          {busy && <LoaderCircle size={14} className="spin" aria-hidden />}
          {!busy && showSaved && (
            <>
              <Check size={14} aria-hidden /> Saved
            </>
          )}
        </span>
        <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close permission rules" title="Close">
          <X size={16} aria-hidden />
        </button>
      </header>
      <div className="pane-body">
        {rules === null ? (
          <p className="pane-empty">
            <LoaderCircle size={16} className="spin" aria-hidden /> Loading the rules.
          </p>
        ) : (
          <>
            <p className="help">
              The rules are in <code>{rules.path}</code> in the project folder.
            </p>
            <RuleList kind="allow" rules={rules.allow} busy={busy} onChange={(allow) => onSave(allow, rules.deny)} />
            <RuleList kind="deny" rules={rules.deny} busy={busy} onChange={(deny) => onSave(rules.allow, deny)} />
            <section className="rules-section">
              <h3>Rule forms</h3>
              <table className="rules-help">
                <tbody>
                  <tr>
                    <td><code>bash</code></td>
                    <td>Each command.</td>
                  </tr>
                  <tr>
                    <td><code>bash(git status)</code></td>
                    <td>This exact command.</td>
                  </tr>
                  <tr>
                    <td><code>bash(npm run test:*)</code></td>
                    <td>Commands that start with the prefix, with no shell operators.</td>
                  </tr>
                  <tr>
                    <td><code>edit(src/*.py)</code></td>
                    <td>Edits to files that match the pattern.</td>
                  </tr>
                  <tr>
                    <td><code>mcp__github__*</code></td>
                    <td>Each tool of the MCP server “github”.</td>
                  </tr>
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </section>
  );
});
