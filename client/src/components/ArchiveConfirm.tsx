// The question before the archive of a worktree session with changes that are not in a commit
// (UI_RULES S8). The archive removes the worktree folder, so the changes go away. The branch and
// its commits stay.

import { ConfirmDialog } from "./ConfirmDialog";

export function ArchiveConfirm({ title, branch, onArchive, onCancel }: {
  title: string; // The name of the session.
  branch: string;
  onArchive: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog title="Archive session with uncommitted changes?" confirmLabel="Archive anyway" onConfirm={onArchive} onCancel={onCancel}>
      The worktree of <strong>{title}</strong> has changes that are not in a commit. The archive removes the worktree folder and
      these changes. The commits on the branch <span className="mono">{branch}</span> stay.
    </ConfirmDialog>
  );
}
