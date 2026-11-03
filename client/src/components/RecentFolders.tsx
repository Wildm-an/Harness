// The folder block of the start screen, as in Claude: when the app opens, the recent project folders
// show in the center. The user selects the folder to work in. "Show more" under the folders shows all
// the project folders. Under the block, "Open folder…" (left) adds a folder, and "New project…" (right)
// makes a new folder in a location that stays the same until the user changes it. The IDE view shows
// the same block in the editor.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Folder, FolderOpen, FolderPlus, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ProjectItem } from "../daemon/protocol";
import { parentHints } from "../lib/projectLabels";

// The block shows this many folders. "Show more" shows all of them.
const SHOWN = 3;
// With all the folders shown, the list scrolls after this many rows.
const SCROLL_AFTER = 8;

/** The path of a new folder in a location, with the separator of the location. */
export function joinFolder(location: string, name: string): string {
  const sep = location.includes("\\") || /^[a-z]:/i.test(location) ? "\\" : "/";
  return location.replace(/[\\/]+$/, "") + sep + name;
}

/** The problem with a new folder name, or null for a good name. */
export function folderNameProblem(name: string): string | null {
  if (!name) return "Enter a name for the folder.";
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return 'A folder name cannot have these characters: < > : " / \\ | ? *';
  if (name === "." || name === ".." || /[. ]$/.test(name)) return "A folder name cannot end with a period or a space.";
  return null;
}

/** The form to make a new project folder: the folder name and its location. */
function NewProjectForm({
  location,
  onLocationChange,
  onBrowse,
  onCreate,
  onCancel,
}: {
  location: string;
  onLocationChange: (location: string) => void;
  onBrowse: (current: string) => Promise<string | null>;
  onCreate: (name: string, location: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();
  const where = location.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = folderNameProblem(trimmed) ?? (where ? null : "Select the location of the folder.");
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate(trimmed, where);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const browse = async () => {
    const folder = await onBrowse(where);
    if (folder) onLocationChange(folder);
  };

  return (
    <form
      className="new-project-form"
      onSubmit={submit}
      noValidate
      autoComplete="off"
      onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}
    >
      <div className="new-project-head">
        <FolderPlus size={15} aria-hidden />
        New project
      </div>
      <label className="new-project-label" htmlFor="new-project-name">
        Folder name
      </label>
      <input
        id="new-project-name"
        autoFocus
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        placeholder="my-app"
        maxLength={80}
        spellCheck={false}
      />
      <label className="new-project-label" htmlFor="new-project-location">
        Location
      </label>
      <div className="new-project-row">
        <input
          id="new-project-location"
          className="mono"
          value={location}
          onChange={(e) => {
            onLocationChange(e.target.value);
            setError(null);
          }}
          placeholder={navigator.userAgent.includes("Windows") ? "C:\\Users\\you\\projects" : "/home/you/projects"}
          spellCheck={false}
        />
        <button type="button" className="btn btn-small" onClick={() => void browse()}>
          Browse
        </button>
      </div>
      {trimmed && where && !folderNameProblem(trimmed) && (
        <p className="new-project-path mono" title={joinFolder(where, trimmed)}>
          {joinFolder(where, trimmed)}
        </p>
      )}
      {error && (
        <p className="form-error new-project-error" role="alert">
          {error}
        </p>
      )}
      <div className="new-project-actions">
        <button type="button" className="btn btn-small btn-ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn-small btn-primary" disabled={saving}>
          {saving && <LoaderCircle size={13} className="spin" aria-hidden />}
          Create
        </button>
      </div>
    </form>
  );
}

/** The projects, the newest use first. */
export function recentFolders(projects: ProjectItem[]): ProjectItem[] {
  return [...projects].sort((a, b) => (b.last_used || b.created_at) - (a.last_used || a.created_at));
}

export function RecentFolders({
  projects,
  selectedId,
  onPick,
  onOpenFolder,
  location,
  onLocationChange,
  onBrowse,
  onCreate,
  error,
}: {
  projects: ProjectItem[] | null; // null: loading.
  selectedId: string | null; // The folder with the check mark.
  onPick: (id: string) => void;
  onOpenFolder: () => void;
  location: string; // The location of a new project folder.
  onLocationChange: (location: string) => void;
  onBrowse: (current: string) => Promise<string | null>;
  onCreate: (name: string, location: string) => Promise<void>; // Make the folder, and select it.
  error?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = projects ? recentFolders(projects) : [];
  // Two folders with the same name show their parent folders.
  const hints = parentHints(items.map((p) => ({ key: p.id, name: p.name, path: p.path })));
  const [all, setAll] = useState(false);
  const [creating, setCreating] = useState(false);
  // The first folders show, and also the folder with the check mark.
  const shown = all ? items : items.filter((p, i) => i < SHOWN || p.id === selectedId);

  // The block gets the focus, so the arrow keys and Enter select a folder at once.
  const loaded = projects !== null;
  useEffect(() => {
    if (!loaded) return;
    const box = ref.current;
    const target = box?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? box?.querySelector<HTMLButtonElement>("button");
    target?.focus({ preventScroll: true });
  }, [loaded]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (creating) return; // The form uses the arrow keys in its fields.
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const closeForm = () => {
    setCreating(false);
    // The focus goes back to the "New project…" item.
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(".recent-folders-new")?.focus());
  };

  if (creating) {
    return (
      <div className="recent-folders" ref={ref}>
        <NewProjectForm location={location} onLocationChange={onLocationChange} onBrowse={onBrowse} onCreate={onCreate} onCancel={closeForm} />
      </div>
    );
  }

  // The box holds the folders and "Show more". "Open folder…" and "New project…" are small text
  // buttons under the box. The arrow keys move through all of them.
  return (
    <div className="recent-folders-wrap" ref={ref} onKeyDown={onKeyDown}>
      {(projects === null || items.length > 0) && (
        <div className="recent-folders" role="menu" aria-label="Choose a folder to work in">
          {projects === null ? (
            <p className="recent-folders-status" role="status">
              <LoaderCircle size={14} className="spin" aria-hidden /> Loading the folders
            </p>
          ) : (
            <div id="recent-folders-list" className="recent-folders-list" style={{ maxHeight: `${SCROLL_AFTER * 34}px` }}>
              {shown.map((p) => {
                const checked = p.id === selectedId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    disabled={!p.exists}
                    title={p.exists ? p.path : `${p.path}: the folder does not exist.`}
                    onClick={() => onPick(p.id)}
                  >
                    {p.exists ? <Folder size={15} aria-hidden /> : <TriangleAlert size={15} aria-hidden />}
                    <span className="recent-folders-name">
                      {p.name}
                      {hints.get(p.id) && <span className="project-hint"> · {hints.get(p.id)}</span>}
                    </span>
                    {checked && <Check size={15} className="recent-folders-check" aria-hidden />}
                  </button>
                );
              })}
            </div>
          )}
          {items.length > shown.length || all ? (
            <button
              type="button"
              role="menuitem"
              className="recent-folders-more"
              aria-expanded={all}
              aria-controls="recent-folders-list"
              onClick={() => setAll((v) => !v)}
            >
              {all ? "Show less" : "Show more"}
              {all ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
            </button>
          ) : null}
        </div>
      )}
      <div className="recent-folders-actions">
        <button type="button" onClick={onOpenFolder}>
          <FolderOpen size={13} aria-hidden />
          Open folder…
        </button>
        <button type="button" className="recent-folders-new" onClick={() => setCreating(true)}>
          <FolderPlus size={13} aria-hidden />
          New project…
        </button>
      </div>
      {error && (
        <p className="form-error recent-folders-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
