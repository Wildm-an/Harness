// The question before the delete of a session (UI_RULES S8), as the "Delete session?" dialog of the
// Claude app. Harness keeps no copy on a server, so the text has no line about one. The focus starts
// on "Delete", so Enter deletes the session.

import { ConfirmDialog } from "./ConfirmDialog";

export function DeleteSessionConfirm({ title, branch, onDelete, onCancel }: {
  title: string; // The name of the session.
  branch?: string | null; // The branch of a worktree session.
  onDelete: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog title="Delete session?" confirmLabel="Delete" focusConfirm onConfirm={onDelete} onCancel={onCancel}>
      “{title}” will be removed from this computer.
      {branch && (
        <>
          {" "}
          The worktree folder is removed. The branch <span className="mono">{branch}</span> stays.
        </>
      )}
    </ConfirmDialog>
  );
}
