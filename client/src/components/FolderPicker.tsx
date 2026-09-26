import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Folder, FolderGit2, HardDrive, House, LoaderCircle, X } from "lucide-react";
import type { DirListing, HostInfo } from "../daemon/protocol";

/**
 * Selects a project folder on the daemon host. The native dialog shows only the disk of
 * this computer, so a remote daemon needs this picker.
 */
export function FolderPicker({
  host,
  listing,
  error,
  initialPath,
  onNavigate,
  onSelect,
  onClose,
}: {
  host: HostInfo | null;
  listing: DirListing | null;
  error: string | null;
  initialPath: string;
  onNavigate: (path: string | undefined, hidden: boolean) => void;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  const [typed, setTyped] = useState("");
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onNavigate(initialPath || undefined, false);
    dialog.current?.focus();
  }, []);

  useEffect(() => setTyped(listing?.path ?? ""), [listing?.path]);

  const go = (path: string | undefined) => onNavigate(path, hidden);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal folder-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <header className="pane-head">
          <Folder size={16} aria-hidden className="pane-icon" />
          <span className="pane-title" id="picker-title">
            Select a folder on {host?.hostname ?? "the daemon host"}
          </span>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Close" title="Close">
            <X size={16} aria-hidden />
          </button>
        </header>

        <form
          className="picker-path"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) go(typed.trim());
          }}
        >
          <button
            type="button"
            className="icon-btn ghost"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && go(listing.parent)}
            aria-label="Parent folder"
            title="Parent folder"
          >
            <ArrowUp size={15} aria-hidden />
          </button>
          <button type="button" className="icon-btn ghost" onClick={() => go(undefined)} aria-label="Home folder" title="Home folder">
            <House size={15} aria-hidden />
          </button>
          <label htmlFor="picker-input" className="sr-only">
            Folder path
          </label>
          <input id="picker-input" className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
        </form>

        {listing && listing.roots.length > 1 && (
          <div className="picker-roots">
            {listing.roots.map((root) => (
              <button key={root} type="button" className="btn btn-small" onClick={() => go(root)}>
                <HardDrive size={13} aria-hidden />
                {root}
              </button>
            ))}
          </div>
        )}

        <div className="picker-list" aria-live="polite">
          {error ? (
            <p className="field-error picker-message" role="alert">
              {error}
            </p>
          ) : !listing ? (
            <p className="pane-empty">
              <LoaderCircle size={16} className="spin" aria-hidden /> Loading the folders.
            </p>
          ) : listing.items.length === 0 ? (
            <p className="pane-empty">This folder has no subfolders.</p>
          ) : (
            <ul>
              {listing.items.map((item) => (
                <li key={item.path}>
                  <button type="button" className="picker-item" onClick={() => go(item.path)}>
                    <Folder size={15} aria-hidden />
                    <span>{item.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="picker-foot">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked);
                onNavigate(listing?.path, e.target.checked);
              }}
            />
            Show hidden folders
          </label>
          <span className="spacer" />
          {listing?.is_project && (
            <span className="badge ok" title="The folder has .git, a HARNESS.md, or a project file">
              <FolderGit2 size={12} aria-hidden /> Project
            </span>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!listing} onClick={() => listing && onSelect(listing.path)}>
            <Check size={14} aria-hidden />
            Use this folder
          </button>
        </footer>
      </div>
    </div>
  );
}
