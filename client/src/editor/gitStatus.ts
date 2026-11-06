// The git state of the changed files in the session folder (daemon message "git.status"). The file
// tree shows it in colors: a letter after a changed file, and a dot after a folder that holds one.

import type { GitFileState } from "../daemon/protocol";

export type { GitFileState };

/** The color group of a state: the CSS class is ``git-<tone>``. */
export type GitTone = "modified" | "added" | "deleted" | "conflict";

export function gitTone(state: GitFileState): GitTone {
  if (state === "conflict") return "conflict";
  if (state === "deleted") return "deleted";
  if (state === "added" || state === "untracked") return "added";
  return "modified";
}

export const GIT_LETTER: Record<GitFileState, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflict: "!",
};

export const GIT_LABEL: Record<GitFileState, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  conflict: "Conflict",
};

const FOLDER_RANK: Record<GitTone, number> = { added: 1, deleted: 2, modified: 2, conflict: 3 };

/**
 * The tone of each folder that holds changed files. A conflict wins, then a change, then a new file.
 * A folder with a deleted file shows as changed: the folder itself is still there.
 */
export function folderTones(files: Record<string, GitFileState>): Map<string, GitTone> {
  const tones = new Map<string, GitTone>();
  for (const [path, state] of Object.entries(files)) {
    let tone = gitTone(state);
    if (tone === "deleted") tone = "modified";
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const old = tones.get(dir);
      if (!old || FOLDER_RANK[tone] > FOLDER_RANK[old]) tones.set(dir, tone);
    }
  }
  return tones;
}
