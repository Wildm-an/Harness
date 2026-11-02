// The question before the archive of a worktree session with changes that are not in a commit
// (UI_RULES S8). The archive removes the worktree folder, so the changes go away. The branch and
// its commits stay.

import { useEffect, useRef } from "react";
import { useOverlay } from "../lib/overlay";

export function ArchiveConfirm({ title, branch, onArchive, onCancel }: {
  title: string; // The name of the session.
  branch: string;
  onArchive: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useOverlay(true);
  useEffect(() => cancel.current?.focus(), []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="archive-confirm-title"
        aria-describedby="archive-confirm-text"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="archive-confirm-title" className="confirm-title">
          Archive session with uncommitted changes?
        </h2>
        <p id="archive-confirm-text" className="confirm-text">
          The worktree of <strong>{title}</strong> has changes that are not in a commit. The archive removes the worktree folder
          and these changes. The commits on the branch <span className="mono">{branch}</span> stay.
        </p>
        <div className="confirm-actions">
          <button ref={cancel} type="button" className="btn btn-small" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-small btn-danger" onClick={onArchive}>
            Archive anyway
          </button>
        </div>
      </div>
    </div>
  );
}
