// Pull requests and the parts of the work of a session, as in the Claude Code desktop app: the
// "Create PR" button, the PR row of the Changes section, the PR mark of a session row, and the
// hover card of a pull request link in the chat.

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ChatItem } from "../chat/state";
import type { CheckState, GitChanges, PrChecks, PrState, PullRequest, WorkPart } from "../daemon/protocol";
import { loadPref, savePref } from "./prefs";

export const PR_STATE_TEXT: Record<PrState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

/** "owner/name" and the number of a GitHub pull request URL, else null. */
export function prUrlRef(url: string | null | undefined): { repo: string; number: number } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s?#]+\/[^/\s?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url?.trim() ?? "");
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** "Wildm-an/Harness #5", or "#5" with no repository. */
export function prRefText(pr: Pick<PullRequest, "number" | "repo" | "url">): string {
  const repo = pr.repo ?? prUrlRef(pr.url)?.repo;
  return repo ? `${repo} #${pr.number}` : `#${pr.number}`;
}

/** "Harness #18": the repository name (no owner) and the number, as the PR rows of the Claude app. */
export function prShortRef(pr: Pick<PullRequest, "number" | "repo" | "url">): string {
  const repo = pr.repo ?? prUrlRef(pr.url)?.repo;
  const name = repo?.split("/").pop();
  return name ? `${name} #${pr.number}` : `#${pr.number}`;
}

// -- the pull requests that a session made ------------------------------------------------------

const PR_URL = /https?:\/\/(?:www\.)?github\.com\/[^/\s?#"'<>]+\/[^/\s?#"'<>]+\/pull\/\d+/gi;

/** True for a tool call that makes a pull request: `gh pr create` in a shell, or a "create pull request" tool (GitHub MCP). */
function makesPr(name: string, input: unknown): boolean {
  if (name === "bash" || name === "shell" || name === "powershell") {
    const command = input && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
    return typeof command === "string" && /\bgh\s+pr\s+create\b/.test(command);
  }
  const tool = name.toLowerCase();
  return /(pull_?request|(^|_)pr($|_))/.test(tool) && /(create|open|new)/.test(tool);
}

/**
 * The URLs of the pull requests that the agent made in a session, as the PR list of the Changes
 * section of the Claude app: from the output of `gh pr create` and of the tools that make a pull
 * request. The newest first, each one time. A link that the agent only reads or names does not count.
 */
export function sessionPrUrls(items: readonly ChatItem[]): string[] {
  const urls: string[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || item.status !== "done" || !item.output || !makesPr(item.name, item.input)) continue;
    for (const match of item.output.match(PR_URL) ?? []) {
      const ref = prUrlRef(match);
      if (!ref) continue;
      const url = `https://github.com/${ref.repo}/pull/${ref.number}`;
      const at = urls.indexOf(url);
      if (at >= 0) urls.splice(at, 1);
      urls.push(url);
    }
  }
  return urls.reverse();
}

/** A row of the PR list: the URL, and the details when the daemon sent them. */
export interface ListedPr {
  url: string | null;
  number: number;
  repo: string | null;
  info: PullRequest | null | undefined; // undefined: no reply yet. null: gh cannot read it.
}

/** The PR list of the Changes section: the pull requests of the session, then the pull request of the branch when the list does not have it. */
export function listedPrs(urls: readonly string[], branchPr: PullRequest | null | undefined, info: (url: string) => PullRequest | null | undefined): ListedPr[] {
  const rows: ListedPr[] = urls.map((url) => {
    const ref = prUrlRef(url);
    return { url, number: ref?.number ?? 0, repo: ref?.repo ?? null, info: info(url) };
  });
  if (branchPr) {
    const ref = prUrlRef(branchPr.url);
    const key = ref ? `https://github.com/${ref.repo}/pull/${ref.number}` : null;
    const at = key ? rows.findIndex((r) => r.url === key) : -1;
    // The store asks every 30 seconds (usePrRefresh): its reply is newer than the branch status, which
    // the daemon sends only at the start and the end of a turn.
    const fresh = key ? info(key) : undefined;
    const details = fresh ?? branchPr;
    if (at >= 0) rows[at] = { ...rows[at], info: rows[at].info ?? branchPr };
    else rows.push({ url: branchPr.url, number: branchPr.number, repo: branchPr.repo ?? ref?.repo ?? null, info: details });
  }
  return rows;
}

/** A short time from now: "just now", "2m ago", "3h ago", "5d ago", else the date. */
export function timeAgo(iso: string | null | undefined, nowMs: number = Date.now()): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return null;
  const s = Math.max(0, Math.round((nowMs - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "1,479": a number with group marks. */
export const groupNumber = (n: number) => n.toLocaleString("en-US");

const plural = (n: number, one: string, many: string = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// -- the parts of the work --------------------------------------------------------------------

/**
 * The three parts of the work of a branch, each with its own color in the rail:
 * "uncommitted" (not in a commit), "unpushed" (commits that the remote does not have), and
 * "pushed" (on the remote branch, not in the base). A part with no work does not show.
 */
export type WorkKind = "uncommitted" | "unpushed" | "pushed";

export interface WorkRow {
  kind: WorkKind;
  label: string; // "Uncommitted", "Not pushed", "Pushed".
  detail: string; // "3 files", "2 commits · 4 files".
  added: number;
  removed: number;
  tip: string;
}

export const WORK_LABELS: Record<WorkKind, string> = { uncommitted: "Uncommitted", unpushed: "Not pushed", pushed: "Pushed" };

const filesText = (p: WorkPart) => plural(p.files, "file");

export function workRows(changes: GitChanges): WorkRow[] {
  const rows: WorkRow[] = [];
  const u = changes.uncommitted;
  if (u && u.files > 0) {
    rows.push({ kind: "uncommitted", label: WORK_LABELS.uncommitted, detail: filesText(u), added: u.added, removed: u.removed, tip: `${filesText(u)} with changes that are not in a commit. Click to see the changes.` });
  }
  const n = changes.unpushed;
  if (n && n.commits > 0) {
    const where = changes.upstream ? ` that ${changes.upstream} does not have` : " that are not on the remote";
    rows.push({ kind: "unpushed", label: WORK_LABELS.unpushed, detail: plural(n.commits, "commit"), added: n.added, removed: n.removed, tip: `${plural(n.commits, "commit")}${where} (${filesText(n)}). Click to see the changes.` });
  }
  const p = changes.pushed;
  if (p && p.commits > 0) {
    rows.push({ kind: "pushed", label: WORK_LABELS.pushed, detail: plural(p.commits, "commit"), added: p.added, removed: p.removed, tip: `${plural(p.commits, "commit")} on ${changes.upstream ?? "the remote"} that ${changes.base ?? "the base"} does not have (${filesText(p)}). Click to see the changes.` });
  }
  return rows;
}

/** True when the daemon sent the parts of the work (a daemon of this version or newer). */
export const hasWorkParts = (changes: GitChanges) => changes.uncommitted !== undefined;

// -- the git button of the Changes section ------------------------------------------------------

export type GitAction = "pr" | "draft" | "commit" | "commitPush" | "push";

// The labels of the Claude app menu: "View changes", "Create PR", "Create draft PR",
// "Manually create PR", "Dismiss". Harness adds "Commit", "Commit and push", and "Push" for the
// states with no pull request to create.
export const ACTION_LABELS: Record<GitAction, string> = {
  pr: "Create PR",
  draft: "Create draft PR",
  commit: "Commit",
  commitPush: "Commit and push",
  push: "Push",
};

export const ACTION_TIPS: Record<GitAction, string> = {
  pr: "Ask the agent to commit, push, and open a pull request",
  draft: "Ask the agent to commit, push, and open a draft pull request",
  commit: "Ask the agent to commit the changes",
  commitPush: "Ask the agent to commit the changes and push them",
  push: "Ask the agent to push the commits",
};

const isLive = (pr: PullRequest | null | undefined) => !!pr && (pr.state === "open" || pr.state === "draft");

/** The git button: its action, the actions of the menu (the button does the checked one), and
 * "Manually create PR" (a GitHub branch with no open pull request). primary null: nothing to do. */
export interface GitButton {
  primary: GitAction | null;
  choices: GitAction[];
  manual: boolean;
}

/**
 * The git button of the Changes section. It does the next step of the work: "Create PR" (or
 * "Create draft PR") for a GitHub branch with work and no open pull request, "Commit and push"
 * or "Push" for new work, and "Commit" with no remote. ``chosen`` is the action that the user
 * checked in the menu last: the button does it when it is one of the choices.
 */
export function gitActions(changes: GitChanges, pr: PullRequest | null | undefined, chosen: GitAction | null = null): GitButton {
  const parts = hasWorkParts(changes);
  const uncommitted = parts ? (changes.uncommitted?.files ?? 0) > 0 : changes.files > 0;
  const unpushed = parts ? (changes.unpushed?.commits ?? 0) > 0 : false;
  const anyWork = changes.files > 0 || uncommitted || unpushed;
  const remote = changes.remote ?? changes.github;
  let choices: GitAction[] = [];
  let manual = false;
  if (changes.github && !isLive(pr)) {
    if (anyWork) {
      choices = ["pr", "draft"];
      manual = true;
    }
  } else if (uncommitted) choices = remote ? ["commitPush", "commit"] : ["commit"];
  else if (unpushed) choices = ["push"];
  const primary = chosen && choices.includes(chosen) ? chosen : (choices[0] ?? null);
  return { primary, choices, manual };
}

const CHOSEN_PREF = "gitAction.chosen";

/** The action that the user checked in the menu last. */
export function chosenAction(): GitAction | null {
  const v = loadPref(CHOSEN_PREF, "");
  return v in ACTION_LABELS ? (v as GitAction) : null;
}

export function setChosenAction(action: GitAction): void {
  savePref(CHOSEN_PREF, action);
}

/**
 * The GitHub page that makes a pull request of the branch ("Manually create PR"), else null: the
 * repository is not on GitHub, or the branch is not on the remote (GitHub needs it).
 */
export function compareUrl(changes: GitChanges): string | null {
  const repo = changes.github_repo;
  const branch = changes.upstream?.replace(/^[^/]+\//, "") ?? null;
  const base = changes.base?.replace(/^[^/]+\//, "") ?? null;
  if (!repo || !branch || !base) return null;
  const part = (name: string) => name.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/compare/${part(base)}...${part(branch)}?expand=1`;
}

// -- "Dismiss": the git button hides for the session until the work changes ------------------------

const DISMISS_PREF = "gitAction.dismissed";

/** A short text of the work: the button shows again when it changes. */
export function workSignature(changes: GitChanges, pr: PullRequest | null | undefined): string {
  const p = (w: WorkPart | null | undefined) => (w ? `${w.files}/${w.added}/${w.removed}` : "-");
  return [changes.branch, changes.files, changes.added, changes.removed, p(changes.uncommitted), changes.unpushed?.commits ?? "-", changes.pushed?.commits ?? "-", pr?.state ?? "-"].join(":");
}

function dismissedMap(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(loadPref(DISMISS_PREF, "{}"));
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function isDismissed(sessionId: string, signature: string): boolean {
  return dismissedMap()[sessionId] === signature;
}

const MAX_DISMISSED = 200;

export function dismiss(sessionId: string, signature: string): void {
  const map = dismissedMap();
  delete map[sessionId];
  map[sessionId] = signature;
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DISMISSED))) delete map[k];
  savePref(DISMISS_PREF, JSON.stringify(map));
}

const SAFE_STAGE = "Do not commit files that another session or the user changed for other work: ask first.";

const PR_STEPS = (draft: boolean) => `1. Check for uncommitted changes. If any exist, stage and commit them with a message that says what changed and why. ${SAFE_STAGE}
2. If the current branch is the default branch of the repository, make a new branch for the changes first.
3. Push the branch to the remote.
4. Open the pull request with \`gh pr create${draft ? " --draft" : ""}\`. Write a title that summarizes the change, and a body that says what changed, why, and what a reviewer must know. Follow the pull request template of the repository if it has one.
5. If a pull request already exists for this branch, push the new commits and give its URL. Do not make a second pull request.
6. Give the URL of the pull request at the end.`;

/** The prompt that each action sends to the agent, and the text that the chat shows for it. */
export const ACTION_PROMPTS: Record<GitAction, string> = {
  pr: `Create a pull request for the changes in this session, ready for review (not a draft).\n\n${PR_STEPS(false)}`,
  draft: `Create a draft pull request for the changes in this session.\n\n${PR_STEPS(true)}`,
  commit: `Commit the changes in this session.

1. Look at the uncommitted changes with git status and git diff.
2. Stage the files of this session. ${SAFE_STAGE}
3. Commit with a message that says what changed and why.
4. Give the commit hash and a one-line summary at the end.`,
  commitPush: `Commit the changes in this session, then push them.

1. Look at the uncommitted changes with git status and git diff.
2. Stage the files of this session. ${SAFE_STAGE}
3. Commit with a message that says what changed and why.
4. Push the branch to its remote branch. If the branch has no remote branch, push it with -u to origin.
5. If the push fails because the remote has new commits, stop and tell me. Do not force the push.
6. Give the commit hash and the remote branch at the end.`,
  push: `Push the commits of this session.

1. Push the branch to its remote branch. If the branch has no remote branch, push it with -u to origin.
2. If the push fails because the remote has new commits, stop and tell me. Do not force the push.
3. Give the remote branch and the pushed commits at the end.`,
};

// -- the CI checks of a pull request ------------------------------------------------------------

export const CHECK_STATE_TEXT: Record<CheckState, string> = { pass: "Passed", fail: "Failed", pending: "Running", skip: "Skipped", cancel: "Cancelled" };

/** The CI line of a pull request: its state and a short text ("2 of 4 checks failed"). */
export interface CiSummary {
  state: "pass" | "fail" | "pending" | "skip";
  text: string;
  tip: string;
}

/** The CI line of a pull request, else null: no checks, or a daemon with no checks. */
export function ciSummary(checks: PrChecks | null | undefined): CiSummary | null {
  if (!checks || checks.total === 0) return null;
  const { total, failed, pending, passed, skipped } = checks;
  const parts = [failed && `${failed} failed`, pending && `${pending} running`, passed && `${passed} passed`, skipped && `${skipped} skipped`].filter(Boolean).join(", ");
  const tip = `${plural(total, "check")}: ${parts}.`;
  if (checks.state === "fail") return { state: "fail", text: failed === total ? `${plural(total, "check")} failed` : `${failed} of ${total} checks failed`, tip };
  if (checks.state === "pending") return { state: "pending", text: pending === total ? `${plural(total, "check")} running` : `${pending} of ${total} checks running`, tip };
  if (checks.state === "pass") return { state: "pass", text: "All checks passed", tip };
  return { state: "skip", text: "Checks skipped", tip };
}

/** The GitHub page of the checks of a pull request, else null. */
export function checksUrl(url: string | null | undefined): string | null {
  const key = prKeyUrl(url);
  return key ? `${key}/checks` : null;
}

/** The label of the CI fix action, as in the Claude app. */
export const FIX_CI_LABEL = "Fix CI";

/** The prompt of "Fix CI": the agent reads the failed runs, fixes the cause, and pushes the fix. */
export function fixCiPrompt(pr: Pick<PullRequest, "url" | "number" | "head">, failed: readonly string[] = []): string {
  const ref = pr.url ?? `#${pr.number}`;
  const names = failed.length > 0 ? `\n\nThe failed checks: ${failed.join(", ")}.` : "";
  const branch = pr.head ? ` (${pr.head})` : "";
  return `Fix the failed CI checks of the pull request ${ref}.${names}

1. If this folder is not on the branch of the pull request${branch}, stop and tell me.
2. Read the failed checks with \`gh pr checks ${ref}\`. Read the log of each failed run with \`gh run view <run-id> --log-failed\`.
3. Find the cause of each failure. If possible, run the same test or command on this computer.
4. Fix the cause in the code. Do not skip, disable, or weaken a test to make a check pass.
5. Commit the fix, and push it to the branch of the pull request. Do not force the push.
6. Give the cause and the fix of each failure at the end.`;
}

/**
 * The CI runs that finished since the last call: a pull request whose checks were "pending" and are now
 * "pass" or "fail". ``last`` keeps the last state of each URL, and this function updates it. The first
 * state of a URL is not a change: a pull request that failed before the app opened does not count.
 */
export function finishedCi(
  last: Map<string, PrChecks["state"]>,
  urls: readonly string[],
  info: (url: string) => PullRequest | null | undefined,
): { url: string; pr: PullRequest; state: "pass" | "fail" }[] {
  const done: { url: string; pr: PullRequest; state: "pass" | "fail" }[] = [];
  for (const url of urls) {
    const pr = info(url);
    if (!pr || pr.checks === undefined) continue;
    const now = pr.checks?.state ?? null;
    const before = last.get(url);
    last.set(url, now);
    if (before === "pending" && (now === "pass" || now === "fail")) done.push({ url, pr, state: now });
  }
  return done;
}

// -- Auto-fix: the agent fixes a failed CI run with no click -------------------------------------

/** The label of the switch, as in the Claude app. */
export const AUTO_FIX_LABEL = "Auto-fix";

/** The fixes that Auto-fix starts for one pull request before it stops. A passed CI run sets the count to 0. */
export const MAX_AUTO_FIXES = 3;

const AUTO_FIX_PREF = "ci.autoFix";
const MAX_AUTO_FIX_SESSIONS = 200;

function autoFixMap(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(loadPref(AUTO_FIX_PREF, "{}"));
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** True when Auto-fix is on for a session. The default is off. */
export function autoFixOn(sessionId: string | null | undefined): boolean {
  return !!sessionId && autoFixMap()[sessionId] === true;
}

export function setAutoFix(sessionId: string, on: boolean): void {
  const map = autoFixMap();
  delete map[sessionId];
  if (on) map[sessionId] = true;
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_AUTO_FIX_SESSIONS))) delete map[k];
  savePref(AUTO_FIX_PREF, JSON.stringify(map));
}

/** The names of the failed and the cancelled checks of a pull request. */
export function failedCheckNames(pr: PullRequest): string[] {
  return (pr.checks?.items ?? []).filter((c) => c.state === "fail" || c.state === "cancel").map((c) => c.name);
}

/**
 * What Auto-fix does for a pull request with a new CI state. ``tries`` keeps the fixes of each URL, and
 * this function updates it. "fix": start a fix. "limit": the last fix also failed, so Auto-fix stops for
 * this pull request until a CI run passes. null: nothing to do.
 */
export function autoFixStep(tries: Map<string, number>, url: string, pr: PullRequest, state: "pass" | "fail"): "fix" | "limit" | null {
  if (state === "pass") {
    tries.delete(url);
    return null;
  }
  if (pr.state !== "open" && pr.state !== "draft") return null;
  const n = tries.get(url) ?? 0;
  if (n > MAX_AUTO_FIXES) return null; // Stopped: the user knows already.
  tries.set(url, n + 1);
  return n < MAX_AUTO_FIXES ? "fix" : "limit";
}

// -- the pull requests of chat links ---------------------------------------------------------

/**
 * The pull requests of the links in the chat. A card asks the daemon for its pull request one
 * time (git.pr_info), and all the cards of the same URL get the reply.
 * undefined: not asked yet or no reply yet. null: gh cannot read it.
 */
type Listener = () => void;
const infos = new Map<string, PullRequest | null>();
const asked = new Set<string>();
const listeners = new Set<Listener>();
let sender: ((url: string, fresh: boolean) => boolean) | null = null;
let version = 0; // Changes with each reply: the snapshot of usePrInfos.

export const prInfoStore = {
  /** The app gives the function that sends git.pr_info. null: no connection. */
  setSender(send: ((url: string, fresh: boolean) => boolean) | null) {
    sender = send;
    if (!send) asked.clear();
  },
  /** A reply of the daemon. */
  put(url: string, pr: PullRequest | null) {
    infos.set(url, pr);
    version++;
    listeners.forEach((l) => l());
  },
  /** Ask for a pull request, one time for each URL. */
  request(url: string) {
    if (asked.has(url) || infos.has(url) || !sender) return;
    if (sender(url, false)) asked.add(url);
  },
  /** Ask again with a short daemon cache (the state can change: merged, closed). The old details show until the reply. */
  refresh(url: string) {
    if (sender?.(url, true)) asked.add(url);
  },
  get: (url: string) => infos.get(url),
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** The URL of a pull request in the form of the PR list ("https://github.com/{owner}/{name}/pull/{n}"), else null. */
export function prKeyUrl(url: string | null | undefined): string | null {
  const ref = prUrlRef(url);
  return ref ? `https://github.com/${ref.repo}/pull/${ref.number}` : null;
}

/** The time between two requests of the PR list, while the window shows. */
export const PR_REFRESH_MS = 30_000;
/** A focus of the window asks again only when the last request is older than this. */
const PR_FOCUS_GAP_MS = 5_000;

/**
 * Keep the details of some pull requests current, as the Claude app does: a new state on GitHub
 * (merged, closed, draft) shows soon. Asks at once, every PR_REFRESH_MS while the window shows,
 * and when the window comes back (focus, or the page shows again). ``again`` asks at once when it changes.
 */
export function usePrRefresh(urls: readonly string[], again: unknown = null): void {
  const key = urls.join(" ");
  useEffect(() => {
    if (!key) return;
    const list = key.split(" ");
    let last = 0;
    const ask = () => {
      last = Date.now();
      list.forEach((url) => prInfoStore.refresh(url));
    };
    const shown = () => typeof document === "undefined" || document.visibilityState === "visible";
    const back = () => {
      if (shown() && Date.now() - last > PR_FOCUS_GAP_MS) ask();
    };
    ask();
    const timer = window.setInterval(() => shown() && ask(), PR_REFRESH_MS);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [key, again]);
}

/**
 * Watch the CI checks of some pull requests: ``onFinish`` gets each pull request whose checks were
 * running and are now passed or failed. It reads the store with no new render. A new list of URLs keeps
 * the last state of the URLs that stay.
 */
export function useCiWatch(urls: readonly string[], onFinish: (done: { url: string; pr: PullRequest; state: "pass" | "fail" }) => void): void {
  const last = useRef(new Map<string, PrChecks["state"]>());
  const list = useRef(urls);
  const finish = useRef(onFinish);
  list.current = urls;
  finish.current = onFinish;
  useEffect(() => {
    const check = () => finishedCi(last.current, list.current, prInfoStore.get).forEach((d) => finish.current(d));
    check();
    const stop = prInfoStore.subscribe(check);
    return () => void stop();
  }, []);
}

/** Reads the pull requests of the store, and renders again with each reply of the daemon. */
export function usePrInfos(): (url: string) => PullRequest | null | undefined {
  useSyncExternalStore(prInfoStore.subscribe, () => version);
  return (url) => prInfoStore.get(url);
}

/** The pull request of a URL, from the store. */
export function usePrInfo(url: string | null): PullRequest | null | undefined {
  return useSyncExternalStore(prInfoStore.subscribe, () => (url ? prInfoStore.get(url) : undefined));
}
