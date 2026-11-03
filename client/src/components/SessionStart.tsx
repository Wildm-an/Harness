import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Code2,
  Folder,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { CommandItem, GitBranches, PermissionMode, ProjectItem } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { ModelMenu, type ModelList } from "./ModelMenu";
import { ModeMenu, lastMode, nextMode, saveLastMode } from "./ModeMenu";
import { loadPref, savePref } from "../lib/prefs";
import { PromptBox, type Submission } from "./PromptBox";
import { parentHints } from "../lib/projectLabels";
import { mentionOrder, type MentionSession } from "./mentions";
import { WorktreeMenu, type WorktreeChoice } from "./WorktreeMenu";
import { RecentFolders, joinFolder, recentFolders } from "./RecentFolders";
import type { ViewMode } from "../lib/viewMode";

function samePath(a: string, b: string): boolean {
  const key = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return key(a) === key(b);
}

function loadWorktreeChoice(key: string): WorktreeChoice {
  try {
    const v = JSON.parse(loadPref(key, "{}"));
    return { on: v?.on === true, base: typeof v?.base === "string" ? v.base : null };
  } catch {
    return { on: false, base: null };
  }
}

/** The folder that holds a path. */
function parentFolder(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf(String.fromCharCode(92)));
  return at > 0 ? path.slice(0, at) : path;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

interface ProjectDraft {
  id?: string;
  name: string;
  path: string;
  create: boolean;
}

const NEW_PROJECT: ProjectDraft = { name: "", path: "", create: true };

/** The form to add or change a project. */
function ProjectForm({
  initial,
  onSave,
  onCancel,
  onBrowse,
}: {
  initial: ProjectDraft;
  onSave: (draft: ProjectDraft) => Promise<void>;
  onCancel: (() => void) | null; // null: there is no project yet, so the form cannot close.
  onBrowse: (current: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNew = !initial.id;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.path.trim()) {
      setError("Enter the project folder, or click Browse.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, name: draft.name.trim() || folderName(draft.path.trim()), path: draft.path.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const browse = async () => {
    const folder = await onBrowse(draft.path.trim());
    if (folder) setDraft((d) => ({ ...d, path: folder, name: d.name.trim() ? d.name : folderName(folder) }));
  };

  return (
    <form className="project-form" onSubmit={submit} noValidate autoComplete="off">
      <h2 className="form-title">{isNew ? (onCancel ? "New project" : "Add a project to start") : `Edit ${initial.name}`}</h2>
      <div className="field">
        <label htmlFor="project-path">Folder</label>
        <div className="field-row">
          <input
            id="project-path"
            className="mono"
            value={draft.path}
            onChange={(e) => setDraft((d) => ({ ...d, path: e.target.value }))}
            placeholder={navigator.userAgent.includes("Windows") ? "C:\\Users\\you\\projects\\my-app" : "/home/you/projects/my-app"}
            spellCheck={false}
            aria-describedby="project-path-help"
          />
          <button type="button" className="btn" onClick={browse}>
            <FolderOpen size={15} aria-hidden />
            Browse
          </button>
        </div>
        <p id="project-path-help" className="help">
          The agent creates and changes files only in this folder, on the daemon computer.
        </p>
      </div>
      <div className="field">
        <label htmlFor="project-name">Name</label>
        <input
          id="project-name"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder={draft.path.trim() ? folderName(draft.path.trim()) : "My app"}
          maxLength={80}
        />
      </div>
      {isNew && (
        <label className="checkbox project-create">
          <input type="checkbox" checked={draft.create} onChange={(e) => setDraft((d) => ({ ...d, create: e.target.checked }))} />
          Create the folder if it does not exist
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <span className="spacer" />
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving && <LoaderCircle size={14} className="spin" aria-hidden />}
          {isNew ? "Add the project" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** The project chip of the prompt box: a menu to select, add, change, or remove a project. */
function ProjectMenu({
  projects,
  selected,
  onSelect,
  onAdd,
  onEdit,
  onDelete,
}: {
  projects: ProjectItem[] | null;
  selected: ProjectItem | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: (p: ProjectItem) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);

  useEffect(() => {
    if (!open) return;
    setConfirmRemove(null);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  const hint = selected && projects ? (parentHints(projects.map((p) => ({ key: p.id, name: p.name, path: p.path }))).get(selected.id) ?? null) : null;

  if (projects !== null && projects.length === 0) {
    return (
      <button type="button" className="prompt-chip" onClick={onAdd}>
        <FolderPlus size={13} aria-hidden />
        Add a project
      </button>
    );
  }

  return (
    <div className="project-menu" ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button
        type="button"
        className={`prompt-chip${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={selected ? `The project folder: ${selected.path}` : "Select a project"}
        disabled={projects === null}
      >
        {projects === null ? <LoaderCircle size={13} className="spin" aria-hidden /> : <Folder size={13} aria-hidden />}
        <span className="prompt-chip-text">
          {selected?.name ?? "Loading the projects"}
          {selected && hint && <span className="project-hint"> · {hint}</span>}
        </span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && projects && (
        <div className="menu project-dropdown up" role="menu" aria-label="Projects">
          {projects.map((p) => {
            const checked = p.id === selected?.id;
            return (
              <div key={p.id} className="project-menu-row">
                <button type="button" role="menuitemradio" aria-checked={checked} onClick={close(() => onSelect(p.id))}>
                  <span className="menu-check">{checked && <Check size={14} aria-hidden />}</span>
                  <span className="project-text">
                    <span className="project-name">{p.name}</span>
                    <span className="project-path mono" title={p.path}>
                      {p.path}
                    </span>
                    {!p.exists && (
                      <span className="project-missing">
                        <TriangleAlert size={12} aria-hidden /> The folder does not exist.
                      </span>
                    )}
                  </span>
                  <span className="project-count">{p.sessions === 1 ? "1 session" : `${p.sessions} sessions`}</span>
                </button>
                {confirmRemove === p.id ? (
                  <button type="button" className="project-remove" onClick={close(() => onDelete(p.id))} title="Remove from the list. The folder and its files stay.">
                    <Trash2 size={13} aria-hidden />
                    Remove
                  </button>
                ) : (
                  <>
                    <button type="button" className="project-row-icon" onClick={close(() => onEdit(p))} aria-label={`Edit ${p.name}`} title="Edit">
                      <Pencil size={13} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="project-row-icon"
                      onClick={() => setConfirmRemove(p.id)}
                      aria-label={`Remove ${p.name} from the list`}
                      title="Remove from the list. The folder and its files stay."
                    >
                      <X size={13} aria-hidden />
                    </button>
                  </>
                )}
              </div>
            );
          })}
          <div className="menu-sep" role="separator" />
          <button type="button" role="menuitem" onClick={close(onAdd)}>
            <FolderPlus size={14} aria-hidden />
            Add a project
          </button>
        </div>
      )}
    </div>
  );
}

export function SessionStart({
  projects,
  busy,
  error,
  onStart,
  prefScope,
  onBrowse,
  models,
  onRequestModels,
  onManageProviders,
  onSaveProject,
  onDeleteProject,
  selectProject,
  commands,
  onRequestCommands,
  recentSessions,
  fileMatches,
  onFindFiles,
  branches,
  onRequestBranches,
  startRequest = 0,
  onAddFiles,
  folderChosen = true,
  onChooseFolder,
  view = "code",
}: {
  // false: the app just opened. The recent folders show in the center until the user selects one.
  folderChosen?: boolean;
  onChooseFolder?: () => void;
  view?: ViewMode; // The IDE view shows the folder block in the editor.
  projects: ProjectItem[] | null; // null: loading.
  busy: boolean;
  error: string | null;
  // prompt: the first task or command, or null for none. mode: the permission mode of the new session.
  // worktree: work in a new git worktree that starts from base (null: the current commit), or null.
  onStart: (cwd: string, model: string, prompt: Submission | null, mode: PermissionMode, worktree: { base: string | null } | null) => void;
  branches: (GitBranches & { cwd: string }) | null; // The branches of the last folder that the screen asked for.
  onRequestBranches: (cwd: string) => void;
  // The prompt box is the same as in a session: the / menu and the @ menu of the selected project.
  commands: CommandItem[] | null;
  onRequestCommands: (cwd: string) => void;
  recentSessions: MentionSession[]; // The sessions of all folders. The "@" menu shows those of the project first.
  fileMatches: { query: string; items: string[] } | null;
  onFindFiles: (query: string, cwd: string) => void;
  prefScope: string; // The project and the model are remembered for each connection.
  onBrowse: (current: string) => Promise<string | null>; // The native dialog, or the remote folder picker.
  models: ModelList | null; // The models of the connections that are on. null: loading.
  onRequestModels: () => void;
  onManageProviders: () => void;
  onSaveProject: (draft: ProjectDraft) => Promise<string>;
  onDeleteProject: (id: string) => void;
  selectProject?: { id: string; key: number } | null; // A project to select now: a new key selects it again.
  // A new number starts an empty session in the selected project, with the selected model, mode,
  // and worktree choice (the switch to the IDE view). It waits until the project list is loaded.
  startRequest?: number;
  onAddFiles?: (cwd: string) => Promise<string | null>; // Ctrl+U in the prompt box: references to files.
}) {
  const [selectedId, setSelectedId] = useState(() => loadPref(`project.${prefScope}`, ""));
  const [form, setForm] = useState<{ draft: ProjectDraft; key: number } | null>(null);
  const selected = projects?.find((p) => p.id === selectedId) ?? projects?.[0] ?? null;
  const modelKey = (id: string | undefined) => (id ? `model.${prefScope}.${id}` : `model.${prefScope}`);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>(() => lastMode(prefScope)); // The mode of the last session.
  const noProjects = projects !== null && projects.length === 0;
  // With no project, the form to add one is open: a session needs a project.
  const shownForm = form ?? (noProjects ? { draft: NEW_PROJECT, key: 0 } : null);

  // Each project remembers its model. A project with no model uses the last model of the connection.
  useEffect(() => {
    setModel(loadPref(modelKey(selected?.id), loadPref(`model.${prefScope}`, "")));
  }, [selected?.id]);

  // Each project remembers its worktree choice. The chip shows only for a folder in a git repository.
  const worktreeKey = `worktree.${prefScope}.${selected?.id ?? ""}`;
  const [worktree, setWorktree] = useState<WorktreeChoice>(() => loadWorktreeChoice(worktreeKey));
  useEffect(() => {
    setWorktree(loadWorktreeChoice(worktreeKey));
    if (selected?.exists) onRequestBranches(selected.path);
  }, [selected?.id, selected?.exists]);
  const changeWorktree = (choice: WorktreeChoice) => {
    setWorktree(choice);
    savePref(worktreeKey, JSON.stringify(choice));
  };
  const branchInfo = selected && branches?.cwd === selected.path ? branches : null;

  const select = (id: string) => {
    setSelectedId(id);
    savePref(`project.${prefScope}`, id);
  };

  // The folder block shows until the user selects a folder. With no project, the form to add one shows.
  const picking = !folderChosen && !noProjects && !form;
  const [pickError, setPickError] = useState<string | null>(null);
  const pick = (id: string) => {
    select(id);
    setPickError(null);
    onChooseFolder?.();
  };
  // "New project…": the location of a new folder. It stays the same for each new folder, until the user
  // changes it. With no saved location, it is the parent folder of the newest project.
  const locationKey = `newProject.location.${prefScope}`;
  const [location, setLocation] = useState(() => loadPref(locationKey, ""));
  const shownLocation = location || (projects?.length ? parentFolder(recentFolders(projects)[0].path) : "");
  const changeLocation = (next: string) => {
    setLocation(next);
    savePref(locationKey, next.trim());
  };
  const createProject = async (name: string, where: string) => {
    const path = joinFolder(where, name);
    if (projects?.some((p) => samePath(p.path, path))) throw new Error(`A project already uses this folder: ${path}`);
    const id = await onSaveProject({ name, path, create: true });
    savePref(locationKey, where);
    setLocation(where);
    pick(id);
  };

  /** "Open folder…": a folder from the dialog. A folder that is not a saved project becomes one. */
  const openFolder = async () => {
    setPickError(null);
    const folder = await onBrowse("");
    if (!folder) return;
    const known = projects?.find((p) => samePath(p.path, folder));
    try {
      pick(known?.id ?? (await onSaveProject({ name: folderName(folder), path: folder, create: false })));
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (selectProject) select(selectProject.id);
  }, [selectProject?.key]);

  const openForm = (draft: ProjectDraft) => setForm((f) => ({ draft, key: (f?.key ?? 0) + 1 }));

  const saveForm = async (draft: ProjectDraft) => {
    const id = await onSaveProject(draft);
    setForm(null);
    pick(id);
  };

  const canStart = !busy && selected !== null && selected.exists;

  /** Start a session. It returns false: the box keeps the text, for a new try after an error. */
  const start = (s: Submission): boolean => {
    if (!canStart) return false;
    savePref(modelKey(selected.id), model.trim());
    savePref(`model.${prefScope}`, model.trim());
    saveLastMode(prefScope, mode);
    const base = worktree.base && branchInfo?.branches.includes(worktree.base) ? worktree.base : null;
    onStart(selected.path, model.trim(), s.kind === "prompt" && !s.text.trim() ? null : s, mode,
      worktree.on && branchInfo?.repo ? { base } : null);
    return false;
  };

  // The switch to the IDE view: start an empty session, so that the files show at once. Before the
  // user selects a folder, the request waits: the editor shows the folder block. A switch back to
  // the Code view cancels the request.
  const handledStart = useRef(startRequest);
  useEffect(() => {
    if (startRequest === handledStart.current) return;
    if (view !== "ide") {
      handledStart.current = startRequest;
      return;
    }
    if (!canStart || picking) return;
    handledStart.current = startRequest;
    start({ kind: "prompt", text: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start reads the current choices.
  }, [startRequest, canStart, picking, view]);

  const folderBlock = (
    <RecentFolders
      projects={projects}
      selectedId={selected?.id ?? null}
      onPick={pick}
      onOpenFolder={() => void openFolder()}
      location={shownLocation}
      onLocationChange={changeLocation}
      onBrowse={onBrowse}
      onCreate={createProject}
      error={pickError}
    />
  );

  // The IDE view before the user selects a folder: an empty editor with the folder block in its center.
  if (picking && view === "ide") {
    return (
      <div className="ide-start">
        <section className="pane-group pane-window ide-start-pane" aria-labelledby="ide-start-title">
          <div className="win-head">
            <div className="win-panes">
              <span className="win-pane active">
                <Code2 size={13} aria-hidden />
                Editor
              </span>
            </div>
          </div>
          <div className="pane-body ide-start-body">
            <h1 id="ide-start-title" className="ide-start-title">Choose a folder to work in</h1>
            {folderBlock}
          </div>
        </section>
      </div>
    );
  }

  return (
    // As in Claude: the folder block (or the project form) in the center, and the prompt box at the
    // bottom of the window, where it stays in the session.
    <div className="start-screen session-start">
      <section className="start-center" aria-labelledby="start-title">
        <h1 id="start-title" className="sr-only">
          {picking ? "Choose a folder to work in" : "New session"}
        </h1>
        {picking && folderBlock}
        {shownForm && (
          <div className="start-project-form">
            <ProjectForm
              key={shownForm.key}
              initial={shownForm.draft}
              onSave={saveForm}
              onCancel={noProjects ? null : () => setForm(null)}
              onBrowse={onBrowse}
            />
          </div>
        )}
      </section>

      <div className="composer start-composer">
        <div className="column">
          {selected && !selected.exists && (
            <p className="start-help">
              <span className="project-missing">
                <TriangleAlert size={12} aria-hidden /> The folder of {selected.name} does not exist. Edit the project or select another.
              </span>
            </p>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <PromptBox
            onAddFiles={onAddFiles && selected ? () => onAddFiles(selected.path) : undefined}
            running={false}
            disabled={!selected}
            busy={busy}
            sendBlocked={!canStart}
            sendEmpty
            inputId="start-input"
            label="The first task for the agent"
            placeholder={selected ? "Describe a task or ask a question" : "Add a project first."}
            sendLabel={{ empty: "Start the session (Enter)", text: "Start the session with this task (Enter)" }}
            boxClassName="start-box"
            focusKey={form || picking ? null : selected?.id}
            commands={commands}
            onRequestCommands={() => selected?.exists && onRequestCommands(selected.path)}
            sessions={selected ? mentionOrder(recentSessions, selected.path) : recentSessions}
            fileMatches={fileMatches}
            onFindFiles={(query) => selected?.exists && onFindFiles(query, selected.path)}
            onSubmit={start}
            onInterrupt={() => {}}
            onCycleMode={() => setMode(nextMode(mode))} // Shift+Tab changes the mode, as in a session.
            below={
              <>
                <div className="prompt-below-left">
                  <ModeMenu mode={mode} onChange={setMode} />
                  <ProjectMenu
                    projects={projects}
                    selected={selected}
                    onSelect={pick}
                    onAdd={() => openForm(NEW_PROJECT)}
                    onEdit={(p) => openForm({ id: p.id, name: p.name, path: p.path, create: false })}
                    onDelete={onDeleteProject}
                  />
                  <WorktreeMenu choice={worktree} info={branchInfo} onChange={changeWorktree} />
                </div>
                <ModelMenu
                  value={model}
                  models={models}
                  allowDefault
                  alignRight
                  up
                  onOpen={onRequestModels}
                  onSelect={setModel}
                  onManage={onManageProviders}
                />
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
