// The worktree option of the start screen (UI_RULES N3): "Work in an isolated copy of the
// repository", and "Branch to start from". A worktree session gets a new branch and a new folder
// (a git worktree). The project folder of the user does not change. The "Worktree" check box of the
// start screen turns the option on. The chip shows only while the box is on, for a project in a git
// repository.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Folder, GitBranch } from "lucide-react";
import type { GitBranches } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";

export interface WorktreeChoice {
  on: boolean;
  base: string | null; // The branch to start from. null: the current branch of the project folder.
}

/** The branch that the session starts from: the saved choice if it still exists, else the current branch. */
export function startBranch(choice: WorktreeChoice, info: GitBranches | null): string | null {
  if (!info?.repo) return null;
  if (choice.base && info.branches.includes(choice.base)) return choice.base;
  return info.current ?? info.branches[0] ?? null;
}

/** The text of the chip: the branch to start from. The "Worktree" check box before the chip says
 *  that the session works in a worktree, so the chip does not say it again. */
export function worktreeLabel(choice: WorktreeChoice, info: GitBranches | null): string {
  const branch = startBranch(choice, info);
  return branch ?? (choice.on ? "Branch" : "Project folder");
}

const MAX_BRANCHES = 30;

export function WorktreeMenu({ choice, info, onChange }: {
  choice: WorktreeChoice;
  info: GitBranches | null; // null: loading.
  onChange: (choice: WorktreeChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!info?.repo) return null;
  const branch = startBranch(choice, info);
  const shown = info.branches.slice(0, MAX_BRANCHES);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (!open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div className="model-menu worktree-menu" ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`prompt-chip${choice.on ? " worktree-on" : ""}${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={choice.on ? "Work in an isolated copy of the repository" : "The agent works in the project folder"}
      >
        <GitBranch size={13} aria-hidden />
        <span className="prompt-chip-text">{worktreeLabel(choice, info)}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <div className="menu model-dropdown up worktree-dropdown" role="menu" aria-label="Where the agent works">
          <div className="menu-heading">Where the agent works</div>
          {(
            [
              [false, Folder, "Project folder", "The agent changes the files of the project folder."],
              [true, GitBranch, "Work in an isolated copy of the repository", "A new branch and folder (a git worktree). Your folder does not change."],
            ] as const
          ).map(([on, Icon, label, help]) => (
            <button
              key={String(on)}
              type="button"
              role="menuitemradio"
              aria-checked={choice.on === on}
              className="mode-item"
              onClick={() => onChange({ ...choice, on })}
            >
              <Icon size={15} aria-hidden />
              <span className="mode-text">
                <span className="mode-label">{label}</span>
                <span className="mode-help">{help}</span>
              </span>
              <span className="menu-check">{choice.on === on && <Check size={14} aria-hidden />}</span>
            </button>
          ))}
          {choice.on && shown.length > 0 && (
            <>
              <div className="menu-sep" role="separator" />
              <div className="menu-heading">Branch to start from</div>
              <div className="worktree-branches">
                {shown.map((b) => (
                  <button
                    key={b}
                    type="button"
                    role="menuitemradio"
                    aria-checked={b === branch}
                    className="worktree-branch"
                    onClick={() => {
                      setOpen(false);
                      onChange({ on: true, base: b === info.current ? null : b });
                    }}
                  >
                    <span className="menu-check">{b === branch && <Check size={14} aria-hidden />}</span>
                    <span className="mono worktree-branch-name">{b}</span>
                    {b === info.current && <span className="worktree-branch-note">current</span>}
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="menu-note">
            {choice.on ? "Archive or delete removes the worktree folder. The branch stays." : "Applies to new sessions."}
          </p>
        </div>
      )}
    </div>
  );
}
