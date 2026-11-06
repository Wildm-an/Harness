// The pull request mark and its hover card, as in the Claude Code desktop app. The card shows the
// state, the repository and number, the time, the title, the author, and the line counts. It shows on
// a pull request link in the chat, on the PR mark of a session row, and on the PR row of the rail.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { PrState, PullRequest } from "../daemon/protocol";
import { PR_STATE_TEXT, groupNumber, prRefText, timeAgo } from "../lib/pr";

const ICONS = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed };

/** The pull request icon in the color of its state: green open, gray draft, violet merged, red closed. */
export function PrIcon({ state, size = 14, className = "" }: { state: PrState | null; size?: number; className?: string }) {
  const Icon = state ? ICONS[state] : GitPullRequest;
  return <Icon size={size} aria-hidden className={`pr-icon${state ? ` pr-${state}` : ""}${className ? ` ${className}` : ""}`} />;
}

const SHOW_DELAY = 350;
const HIDE_DELAY = 150;
const GAP = 6;
const EDGE = 8;

/**
 * A hover card for an element. Spread `anchor` on the element and render `card`. The card stays
 * while the pointer is on the element or on the card. Focus shows it too.
 */
export function useHoverCard(render: () => ReactNode, enabled = true) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef(0);
  const el = useRef<HTMLElement | null>(null);
  const clear = () => window.clearTimeout(timer.current);
  const show = useCallback((target: HTMLElement) => {
    clear();
    el.current = target;
    timer.current = window.setTimeout(() => setAnchor(target.getBoundingClientRect()), SHOW_DELAY);
  }, []);
  const hide = useCallback(() => {
    clear();
    timer.current = window.setTimeout(() => setAnchor(null), HIDE_DELAY);
  }, []);
  useEffect(() => clear, []);
  // A scroll moves the anchor: close the card.
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
    };
  }, [anchor]);
  return {
    anchor: enabled
      ? {
          onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget),
          onMouseLeave: hide,
          onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget),
          onBlur: hide,
        }
      : {},
    open: anchor !== null,
    card: anchor ? (
      <FloatingCard anchor={anchor} onEnter={clear} onLeave={hide}>
        {render()}
      </FloatingCard>
    ) : null,
  };
}

function FloatingCard({ anchor, onEnter, onLeave, children }: { anchor: DOMRect; onEnter: () => void; onLeave: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    let top = anchor.bottom + GAP;
    if (top + box.height > window.innerHeight - EDGE) top = Math.max(EDGE, anchor.top - GAP - box.height);
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - EDGE - box.width));
    setPos({ left, top });
  }, [anchor]);
  return createPortal(
    <div
      ref={ref}
      className="pr-card-float"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: "hidden" }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The full card of a pull request (a chat link, the rail). null pr: the card says that it loads. */
export function PrCard({ pr, url, loading }: { pr: PullRequest | null | undefined; url: string; loading?: boolean }) {
  if (!pr) {
    return (
      <div className="pr-card">
        <div className="pr-card-head">
          <PrIcon state={null} size={13} />
          <span className="pr-card-ref">{url.replace(/^https?:\/\/(www\.)?github\.com\//i, "")}</span>
        </div>
        <div className="pr-card-muted">{loading ? "Loading the pull request…" : "No details. The GitHub CLI (gh) cannot read this pull request."}</div>
      </div>
    );
  }
  const when = timeAgo(pr.updated_at);
  const counts = pr.additions != null && pr.deletions != null;
  return (
    <div className="pr-card">
      <div className="pr-card-head">
        <span className={`pr-pill pr-pill-${pr.state}`}>
          <PrIcon state={pr.state} size={12} />
          {PR_STATE_TEXT[pr.state]}
        </span>
        <span className="pr-card-ref">{prRefText(pr)}</span>
        {when && <span className="pr-card-time">{when}</span>}
      </div>
      {pr.title && <div className="pr-card-title">{pr.title}</div>}
      {(pr.author || counts || pr.changed_files != null) && (
        <div className="pr-card-foot">
          {pr.author && (
            <span className="pr-card-author">
              <span className="pr-avatar" aria-hidden>
                {pr.author.slice(0, 1).toUpperCase()}
              </span>
              {pr.author}
            </span>
          )}
          <span className="pr-card-stats">
            {counts && (
              <span className="pr-chip" aria-label={`${pr.additions} lines added, ${pr.deletions} lines removed`}>
                <span className="stat-add">+{groupNumber(pr.additions!)}</span>
                <span className="stat-del">−{groupNumber(pr.deletions!)}</span>
              </span>
            )}
            {pr.changed_files != null && <span className="pr-chip">{`${groupNumber(pr.changed_files)} ${pr.changed_files === 1 ? "file" : "files"}`}</span>}
          </span>
        </div>
      )}
    </div>
  );
}

/** The small card of a session row: the title, "Merged · owner/name #5", and the line counts. */
export function PrMiniCard({ pr }: { pr: PullRequest }) {
  const counts = pr.additions != null && pr.deletions != null;
  return (
    <div className="pr-card pr-card-mini">
      {pr.title && <div className="pr-card-title">{pr.title}</div>}
      <div className="pr-card-line">
        <PrIcon state={pr.state} size={12} />
        <span className={`pr-state-text pr-${pr.state}`}>{PR_STATE_TEXT[pr.state]}</span>
        <span className="pr-card-muted">· {prRefText(pr)}</span>
        {counts && (
          <span className="pr-card-counts">
            <span className="stat-add">+{pr.additions}</span>
            <span className="stat-del">−{pr.deletions}</span>
          </span>
        )}
      </div>
    </div>
  );
}
