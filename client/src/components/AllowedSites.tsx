// "Manage allowed sites" in the menu of the Browser pane: the sites that the agent browser can open
// with no question. They are the preview_navigate(<origin>/*) allow rules of the project: "Always
// allow" on a site request adds one. Local servers (localhost) are always allowed.

import { useEffect, useRef, useState } from "react";
import { Globe, Trash2, X } from "lucide-react";
import { useOverlay } from "../lib/overlay";

const SITE_RULE = /^preview_navigate\((https?:\/\/[^/()\s]+)\/\*\)$/i;

/** The origin of a site rule, or null for another rule. */
export function siteOfRule(rule: string): string | null {
  return SITE_RULE.exec(rule.trim())?.[1].toLowerCase() ?? null;
}

/** The rule for a typed site: "example.com" or "https://example.com/page" gives the https origin. */
export function ruleForSite(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return `preview_navigate(${url.protocol}//${url.host.toLowerCase()}/*)`;
  } catch {
    return null;
  }
}

export function AllowedSites({ rules, busy, onSave, onClose }: {
  rules: { allow: string[]; deny: string[] } | null; // null: loading.
  busy: boolean;
  onSave: (allow: string[], deny: string[]) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useOverlay(true);
  useEffect(() => input.current?.focus(), []);

  const sites = (rules?.allow ?? []).map((rule) => ({ rule, site: siteOfRule(rule) })).filter((r) => r.site);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!rules) return;
    const rule = ruleForSite(typed);
    if (!rule) {
      setProblem("Enter a site, for example example.com or https://docs.example.com.");
      return;
    }
    setProblem(null);
    setTyped("");
    if (!rules.allow.includes(rule)) onSave([...rules.allow, rule], rules.deny);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal allowed-sites"
        role="dialog"
        aria-modal="true"
        aria-labelledby="allowed-sites-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="pane-head">
          <Globe size={16} aria-hidden className="pane-icon" />
          <span className="pane-title" id="allowed-sites-title">
            Allowed sites
          </span>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close" title="Close">
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="allowed-sites-body">
          <p className="help">
            The agent browser opens these sites with no question. It always opens the local servers of the project. The list is
            in the permission rules of this project.
          </p>
          {rules === null ? (
            <p className="help">Loading the rules…</p>
          ) : sites.length === 0 ? (
            <p className="help">No site is allowed. "Always allow" on a site request adds the site here.</p>
          ) : (
            <ul className="allowed-sites-list">
              {sites.map(({ rule, site }) => (
                <li key={rule}>
                  <span className="mono">{site}</span>
                  <button
                    type="button"
                    className="icon-btn ghost"
                    disabled={busy}
                    onClick={() => onSave(rules.allow.filter((r) => r !== rule), rules.deny)}
                    aria-label={`Remove ${site}`}
                    title="Remove"
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="allowed-sites-add" onSubmit={add}>
            <input
              ref={input}
              className="mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="example.com"
              aria-label="A site to allow"
              aria-invalid={!!problem}
              spellCheck={false}
              disabled={rules === null}
            />
            <button type="submit" className="btn" disabled={busy || rules === null || !typed.trim()}>
              Allow
            </button>
          </form>
          {problem && (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
