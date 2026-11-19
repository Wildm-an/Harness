// The Changes section of the session rail, as in the Claude Code desktop app: the pull requests of
// the session (the ones that the agent made, and the one of the branch), the work of the session in three parts, and the git button ("Create PR", "Commit",
// "Push"). Each part has its own color and icon, so the user can see at once what is not in a
// commit, what is not pushed, and what is on the remote:
//
//   Uncommitted  (orange, the color of a changed file in the file tree)
//   Not pushed   (blue)
//   Pushed       (green)
//
// The colors are hues of the Clear Sight palette (styles.css), as the other status colors.

import { useEffect, useRef, useState } from "react";
import { ArrowDown, Check, ChevronDown, CloudCheck, Copy, Diff, Ellipsis, ExternalLink, FilePen, GitCommitHorizontal, ListChecks, Wrench } from "lucide-react";
import type { GitChanges, PullRequest } from "../daemon/protocol";
import { ACTION_LABELS, ACTION_TIPS, AUTO_FIX_LABEL, CHECK_STATE_TEXT, FIX_CI_LABEL, MAX_AUTO_FIXES, PR_STATE_TEXT, checksUrl, ciSummary, prShortRef, chosenAction, compareUrl, dismiss, gitActions, hasWorkParts, isDismissed, setChosenAction, workRows, workSignature, type GitAction, type GitButton, type ListedPr, type WorkKind } from "../lib/pr";
import { DiffCounts } from "./DiffStats";
import { CiIcon, PrCard, PrIcon, useHoverCard } from "./PrCard";

const CLICK_WAIT = 10_000; // ms. With no turn after a click of the git button, the button shows again.

const WORK_ICONS: Record<WorkKind, typeof FilePen> = { uncommitted: FilePen, unpushed: GitCommitHorizontal, pushed: CloudCheck };

export function RailChanges({
  sessionId,
  changes,
  pr,
  prs,
  running,
  onAction,
  onOpenChanges,
  onOpenPr,
  onFixCi = null,
  autoFix = null,
}: {
  onFixCi?: ((pr: PullRequest) => void) | null; // "Fix CI" of a pull request with failed checks. null: not connected.
  autoFix?: AutoFix | null;
  sessionId: string;
  changes: GitChanges;
  pr: PullRequest | null; // The pull request of the branch: the git button and "All work is in the pull request" use it.
  prs: ListedPr[]; // The rows of the PR list.
  running: boolean; // A turn of the session runs: the git button does not show.
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
  // The git button goes away at the click, and while the agent works: the user cannot ask for the
  // same pull request two times. It shows again after the turn, if there is still something to do.
  const [clicked, setClicked] = useState(false);
  const sawTurn = useRef(false);
  useEffect(() => {
    if (!clicked) return;
    if (running) {
      sawTurn.current = true;
      return;
    }
    if (sawTurn.current) {
      sawTurn.current = false;
      setClicked(false);
      return;
    }
    // No turn started (the prompt did not go): show the button again.
    const timer = window.setTimeout(() => setClicked(false), CLICK_WAIT);
    return () => window.clearTimeout(timer);
  }, [clicked, running]);
  return (
    <div className="rail-changes-box">
      <RailPrList prs={prs} onOpen={onOpenPr} onFixCi={onFixCi} running={running} autoFix={autoFix} />
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
        {button.primary && !dismissed && !running && !clicked && (
          <ActionButton
            button={button}
            manualUrl={compareUrl(changes)}
            onAction={
              onAction &&
              ((action) => {
                setClicked(true);
                onAction(action);
              })
            }
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

/**
 * The pull requests of the session, as in the Claude app: the newest first. Each row has the icon in
 * the color of the state, the title, "Harness #18", and ⋯.
 */
/** The Auto-fix switch of a session: on, the agent fixes a failed CI run with no click. */
export interface AutoFix {
  on: boolean;
  onToggle: (on: boolean) => void;
}

export function RailPrList({ prs, onOpen, onFixCi = null, running = false, autoFix = null }: {
  prs: ListedPr[];
  onOpen: (url: string) => void;
  onFixCi?: ((pr: PullRequest) => void) | null; // null: not connected, or no session.
  running?: boolean; // A turn of the session runs: "Fix CI" does not show.
  autoFix?: AutoFix | null; // null: no switch.
}) {
  if (prs.length === 0) return null;
  // The switch shows when a pull request of the list has CI checks.
  const hasCi = prs.some((p) => p.info?.checks);
  return (
    <>
      <ul className="rail-prs" aria-label="Pull requests">
        {prs.map((p) => (
          <li key={p.url ?? `#${p.number}`}>
            <RailPr item={p} onOpen={onOpen} onFixCi={running ? null : onFixCi} />
          </li>
        ))}
      </ul>
      {autoFix && hasCi && (
        <button
          type="button"
          role="switch"
          aria-checked={autoFix.on}
          className="rail-awake rail-autofix"
          disabled={!onFixCi}
          onClick={() => autoFix.onToggle(!autoFix.on)}
          aria-label={AUTO_FIX_LABEL}
          title={`Only for this session. When a CI run of a pull request fails, the agent fixes it with no click (${MAX_AUTO_FIXES} times at most for each pull request).`}
        >
          <Wrench size={13} aria-hidden className="rail-awake-icon" />
          <span className="rail-awake-text">{AUTO_FIX_LABEL}</span>
          <span className={`switch switch-small${autoFix.on ? " on" : ""}`} aria-hidden>
            <span className="switch-knob" />
          </span>
        </button>
      )}
    </>
  );
}

/**
 * The CI count of a pull request row, as in the Claude app: the GitHub state icon and "2/4" at the
 * bottom right of the row. A click opens the checks under the row: the summary ("2 of 4 checks
 * failed") with "Fix CI", then each check. A check opens its page.
 */
function RailCi({ pr, url, onOpen, onFixCi }: { pr: PullRequest; url: string | null; onOpen: (url: string) => void; onFixCi: ((pr: PullRequest) => void) | null }) {
  const ci = ciSummary(pr.checks);
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // A new CI state shows "Fix CI" again.
  const signature = `${pr.checks?.state}:${pr.checks?.failed}:${pr.checks?.total}`;
  useEffect(() => setAsked(false), [signature]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  if (!ci || !pr.checks) return null;
  const live = pr.state === "open" || pr.state === "draft";
  const all = checksUrl(url);
  const go = (to: string) => {
    setOpen(false);
    onOpen(to);
  };
  return (
    <div
      className={`rail-ci ci-text-${ci.state}`}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        } else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".rail-ci-menu button:not(:disabled)") ?? [])];
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      <button
        type="button"
        className="rail-ci-count"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`${ci.text}. Show the checks.`}
        title={`${ci.tip} Click to ${open ? "hide" : "show"} the checks.`}
        onClick={() => setOpen((v) => !v)}
      >
        <CiIcon state={ci.state} size={12} />
        <span>{ci.count}</span>
      </button>
      {open && (
        <div className="menu rail-ci-menu" role="dialog" aria-label="Checks">
          <div className="rail-ci-head">
            <CiIcon state={ci.state} size={13} />
            <span className="rail-ci-text">{ci.text}</span>
            {ci.state === "fail" && live && onFixCi && !asked && (
              <button
                type="button"
                className="btn btn-small rail-ci-fix"
                title="Ask the agent to read the failed checks, fix the cause, and push the fix"
                onClick={() => {
                  setAsked(true);
                  setOpen(false);
                  onFixCi(pr);
                }}
              >
                <Wrench size={12} aria-hidden /> {FIX_CI_LABEL}
              </button>
            )}
          </div>
          <ul className="rail-ci-list" aria-label="Checks">
            {pr.checks.items.map((c) => (
              <li key={`${c.workflow ?? ""}/${c.name}`}>
                <button type="button" className="rail-ci-check" disabled={!c.url} onClick={() => c.url && go(c.url)} title={`${CHECK_STATE_TEXT[c.state]}${c.url ? ". Click to open the check." : ""}`}>
                  <CiIcon state={c.state} size={13} />
                  <span className="rail-ci-name">{c.name}</span>
                  {c.workflow && <span className="rail-ci-workflow">{c.workflow}</span>}
                </button>
              </li>
            ))}
          </ul>
          {all && (
            <button type="button" className="rail-ci-check rail-ci-more" onClick={() => go(all)}>
              <ListChecks size={13} aria-hidden />
              {pr.checks.total > pr.checks.items.length ? `${pr.checks.total - pr.checks.items.length} more on GitHub` : "View checks"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One pull request: the icon, the title, "Harness #18", and at the right ⋯ ("Open pull request",
 * "View checks", "Copy link") over the CI count.
 */
function RailPr({ item, onOpen, onFixCi }: { item: ListedPr; onOpen: (url: string) => void; onFixCi: ((pr: PullRequest) => void) | null }) {
  const pr = item.info;
  const url = pr?.url ?? item.url;
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hover = useHoverCard(() => (pr ? <PrCard pr={pr} url={url ?? ""} /> : null), !menu && !!pr);
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
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
        setMenu(false);
      }, 700);
    } catch {
      setMenu(false);
    }
  };
  const title = pr?.title ?? `Pull request #${item.number}`;
  const state = pr ? `, ${PR_STATE_TEXT[pr.state]}` : "";
  const ci = pr ? ciSummary(pr.checks) : null;
  return (
    <div
      className={`rail-pr${ci ? " has-ci" : ""}`}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape" && menu) {
          e.stopPropagation();
          setMenu(false);
        }
      }}
    >
      <button type="button" className="rail-pr-main" onClick={() => url && onOpen(url)} disabled={!url} aria-label={`Open pull request #${item.number}: ${title}${state}`} {...hover.anchor}>
        <PrIcon state={pr?.state ?? null} size={15} className="rail-pr-state" />
        <span className="rail-item-text">
          <span className="rail-item-title">{title}</span>
          <span className="rail-item-detail">{prShortRef({ number: item.number, repo: pr?.repo ?? item.repo, url })}</span>
        </span>
      </button>
      <div className="rail-pr-side">
        <button type="button" className="rail-pr-more" aria-haspopup="menu" aria-expanded={menu} aria-label="Pull request actions" title="More actions" onClick={() => setMenu((v) => !v)}>
          <Ellipsis size={14} aria-hidden />
        </button>
        {pr && ci && <RailCi pr={pr} url={url} onOpen={onOpen} onFixCi={onFixCi} />}
      </div>
      {menu && (
        <div className="menu rail-git-menu" role="menu" aria-label="Pull request">
          <button type="button" role="menuitem" disabled={!url} onClick={() => (setMenu(false), url && onOpen(url))}>
            <ExternalLink size={14} aria-hidden /> Open pull request
          </button>
          {pr?.checks && checksUrl(url) && (
            <button type="button" role="menuitem" onClick={() => (setMenu(false), onOpen(checksUrl(url)!))}>
              <ListChecks size={14} aria-hidden /> View checks
            </button>
          )}
          <button type="button" role="menuitem" disabled={!url} onClick={() => void copy()}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
      {hover.card}
    </div>
  );
}
