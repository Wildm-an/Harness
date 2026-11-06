// The Changes section of the session rail, as in the Claude Code desktop app: the pull request of
// the branch, the work of the session in three parts, and the git button ("Create PR", "Commit",
// "Push"). Each part has its own color and icon, so the user can see at once what is not in a
// commit, what is not pushed, and what is on the remote:
//
//   Uncommitted  (orange, the color of a changed file in the file tree)
//   Not pushed   (blue)
//   Pushed       (green)
//
// The colors are hues of the Clear Sight palette (styles.css), as the other status colors.

import { useEffect, useRef, useState } from "react";
import { ArrowDown, Check, ChevronDown, CloudCheck, Copy, Diff, Ellipsis, ExternalLink, FilePen, GitCommitHorizontal } from "lucide-react";
import type { GitChanges, PullRequest } from "../daemon/protocol";
import { ACTION_LABELS, ACTION_TIPS, PR_STATE_TEXT, chosenAction, compareUrl, dismiss, gitActions, hasWorkParts, isDismissed, setChosenAction, workRows, workSignature, type GitAction, type GitButton, type WorkKind } from "../lib/pr";
import { DiffCounts } from "./DiffStats";
import { PrCard, PrIcon, useHoverCard } from "./PrCard";

const WORK_ICONS: Record<WorkKind, typeof FilePen> = { uncommitted: FilePen, unpushed: GitCommitHorizontal, pushed: CloudCheck };

export function RailChanges({
  sessionId,
  changes,
  pr,
  onAction,
  onOpenChanges,
  onOpenPr,
}: {
  sessionId: string;
  changes: GitChanges;
  pr: PullRequest | null;
  onAction: ((action: GitAction) => void) | null; // null: not connected.
  onOpenChanges?: () => void;
  onOpenPr: (url: string) => void;
}) {
  const rows = workRows(changes);
  const parts = hasWorkParts(changes);
  const [chosen, setChosen] = useState(chosenAction);
  const button = gitActions(changes, pr, chosen);
  const signature = workSignature(changes, pr);
  // "Dismiss" hides the button for this session until the work changes.
  const [dismissed, setDismissed] = useState(() => isDismissed(sessionId, signature));
  useEffect(() => setDismissed(isDismissed(sessionId, signature)), [sessionId, signature]);
  const behind = changes.behind ?? 0;
  return (
    <div className="rail-changes-box">
      {pr && <RailPr pr={pr} onOpen={onOpenPr} />}
      {parts && rows.length > 0 && (
        <ul className="rail-work" aria-label="The work of the session">
          {rows.map((r) => {
            const Icon = WORK_ICONS[r.kind];
            return (
              <li key={r.kind}>
                <button type="button" className={`rail-work-row work-${r.kind}`} onClick={onOpenChanges} disabled={!onOpenChanges} title={r.tip}>
                  <Icon size={13} aria-hidden className="rail-work-icon" />
                  <span className="rail-work-label">{r.label}</span>
                  <span className="rail-work-detail">{r.detail}</span>
                  <DiffCounts added={r.added} removed={r.removed} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {parts && behind > 0 && (
        <p className="rail-work-behind" title={`${changes.upstream ?? "The remote branch"} has ${behind} ${behind === 1 ? "commit" : "commits"} that this folder does not have.`}>
          <ArrowDown size={12} aria-hidden />
          {behind} {behind === 1 ? "commit" : "commits"} to pull from {changes.upstream ?? "the remote"}
        </p>
      )}
      <div className="rail-changes">
        <Diff size={15} aria-hidden className="rail-changes-icon" />
        <button
          type="button"
          className="rail-changes-count"
          onClick={onOpenChanges}
          disabled={!onOpenChanges}
          title={
            changes.files === 0
              ? "No changes. Click to open the Changes pane."
              : `${changes.files} ${changes.files === 1 ? "file" : "files"} changed${changes.base ? ` since ${changes.base}` : " (not committed)"}. Click to see the changes.`
          }
        >
          <DiffCounts added={changes.added} removed={changes.removed} />
          {parts && rows.length === 0 && <span className="rail-work-clean">{pr ? "All work is in the pull request" : "No changes"}</span>}
        </button>
        {button.primary && !dismissed && (
          <ActionButton
            button={button}
            manualUrl={compareUrl(changes)}
            onAction={onAction}
            onChoose={(a) => {
              setChosenAction(a);
              setChosen(a);
            }}
            onViewChanges={onOpenChanges}
            onManual={onOpenPr}
            onDismiss={() => {
              dismiss(sessionId, signature);
              setDismissed(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The git button, with its menu at the right, as in the Claude app: "View changes", the actions
 * (the check mark is on the action of the button: a click checks it, as on GitHub, and the button
 * then does it), "Manually create PR" (the GitHub page that makes a pull request), and "Dismiss".
 */
function ActionButton({ button, manualUrl, onAction, onChoose, onViewChanges, onManual, onDismiss }: {
  button: GitButton;
  manualUrl: string | null;
  onAction: ((action: GitAction) => void) | null;
  onChoose: (action: GitAction) => void;
  onViewChanges?: () => void;
  onManual: (url: string) => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const primary = button.primary!;
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const close = (then: () => void) => {
    setOpen(false);
    then();
  };
  return (
    <div
      className="rail-git-action split"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        } else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      <button type="button" className="btn btn-small rail-changes-pr" disabled={!onAction} title={ACTION_TIPS[primary]} onClick={() => onAction?.(primary)}>
        {ACTION_LABELS[primary]}
      </button>
      <button
        type="button"
        className="btn btn-small rail-git-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More git actions"
        title="More git actions"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="menu rail-git-menu" role="menu" aria-label="Git actions">
          <button type="button" role="menuitem" disabled={!onViewChanges} onClick={() => close(() => onViewChanges?.())}>
            <span className="rail-git-label">View changes</span>
          </button>
          <div className="menu-sep" role="separator" />
          {button.choices.map((a) => (
            <button key={a} type="button" role="menuitemradio" aria-checked={a === primary} title={ACTION_TIPS[a]} onClick={() => close(() => onChoose(a))}>
              <span className="rail-git-label">{ACTION_LABELS[a]}</span>
              {a === primary && <Check size={14} aria-hidden className="rail-git-check" />}
            </button>
          ))}
          {button.manual && (
            <>
              <div className="menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                disabled={!manualUrl}
                title={manualUrl ? "Open the GitHub page that makes a pull request of this branch" : "Push the branch first: GitHub needs it to make a pull request."}
                onClick={() => close(() => manualUrl && onManual(manualUrl))}
              >
                <span className="rail-git-label">Manually create PR</span>
              </button>
            </>
          )}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" title="Hide this button until the work changes" onClick={() => close(onDismiss)}>
            <span className="rail-git-label">Dismiss</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The pull request of the branch, as in the Claude app: the icon, the title, "#5 · Merged", and ⋯. */
function RailPr({ pr, onOpen }: { pr: PullRequest; onOpen: (url: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hover = useHoverCard(() => <PrCard pr={pr} url={pr.url ?? ""} />, !menu);
  useEffect(() => {
    if (!menu) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu]);
  const copy = async () => {
    if (!pr.url) return;
    try {
      await navigator.clipboard.writeText(pr.url);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
        setMenu(false);
      }, 700);
    } catch {
      setMenu(false);
    }
  };
  return (
    <div
      className="rail-pr"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && menu) {
          e.stopPropagation();
          setMenu(false);
        }
      }}
    >
      <button type="button" className="rail-pr-main" onClick={() => pr.url && onOpen(pr.url)} disabled={!pr.url} aria-label={`Open pull request #${pr.number}: ${pr.title ?? ""}`} {...hover.anchor}>
        <PrIcon state={pr.state} size={15} className="rail-pr-state" />
        <span className="rail-item-text">
          <span className="rail-item-title">{pr.title ?? `Pull request #${pr.number}`}</span>
          <span className="rail-item-detail">
            #{pr.number} · {PR_STATE_TEXT[pr.state]}
          </span>
        </span>
      </button>
      <button type="button" className="rail-pr-more" aria-haspopup="menu" aria-expanded={menu} aria-label="Pull request actions" title="More actions" onClick={() => setMenu((v) => !v)}>
        <Ellipsis size={14} aria-hidden />
      </button>
      {menu && (
        <div className="menu rail-git-menu" role="menu" aria-label="Pull request">
          <button type="button" role="menuitem" disabled={!pr.url} onClick={() => (setMenu(false), pr.url && onOpen(pr.url))}>
            <ExternalLink size={14} aria-hidden /> Open pull request
          </button>
          <button type="button" role="menuitem" disabled={!pr.url} onClick={() => void copy()}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
      {hover.card}
    </div>
  );
}
