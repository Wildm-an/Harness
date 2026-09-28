import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock,
  Cpu,
  Folder,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { ProjectItem, SessionSummary } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";

function relativeTime(seconds: number): string {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(seconds * 1000).toLocaleDateString();
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
        <span className="prompt-chip-text">{selected?.name ?? "Loading the projects"}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {open && projects && (
        <div className="menu project-dropdown" role="menu" aria-label="Projects">
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

const MAX_HEIGHT_PX = 320;

export function SessionStart({
  projects,
  sessions,
  busy,
  error,
  onStart,
  onResume,
  prefScope,
  onBrowse,
  models,
  onManageProviders,
  onSaveProject,
  onDeleteProject,
  onListSessions,
}: {
  projects: ProjectItem[] | null; // null: loading.
  sessions: { cwd: string | null; items: SessionSummary[] };
  busy: boolean;
  error: string | null;
  onStart: (cwd: string, model: string, prompt: string) => void; // prompt: the first task, or "" for none.
  onResume: (id: string) => void;
  prefScope: string; // The project and the model are remembered for each connection.
  onBrowse: (current: string) => Promise<string | null>; // The native dialog, or the remote folder picker.
  models: string[]; // provider/model suggestions from the providers that are on.
  onManageProviders: () => void;
  onSaveProject: (draft: ProjectDraft) => Promise<string>;
  onDeleteProject: (id: string) => void;
  onListSessions: (cwd: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(() => loadPref(`project.${prefScope}`, ""));
  const [form, setForm] = useState<{ draft: ProjectDraft; key: number } | null>(null);
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const selected = projects?.find((p) => p.id === selectedId) ?? projects?.[0] ?? null;
  const modelKey = (id: string | undefined) => (id ? `model.${prefScope}.${id}` : `model.${prefScope}`);
  const [model, setModel] = useState("");
  const noProjects = projects !== null && projects.length === 0;
  // With no project, the form to add one is open: a session needs a project.
  const shownForm = form ?? (noProjects ? { draft: NEW_PROJECT, key: 0 } : null);

  // Each project remembers its model. A project with no model uses the last model of the connection.
  useEffect(() => {
    setModel(loadPref(modelKey(selected?.id), loadPref(`model.${prefScope}`, "")));
    if (selected) onListSessions(selected.path);
  }, [selected?.id, selected?.sessions]);

  useEffect(() => {
    if (selected && !form) area.current?.focus();
  }, [selected?.id, form]);

  // Grow the text box with its content, up to a limit.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "";
    if (el.value) el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const select = (id: string) => {
    setSelectedId(id);
    savePref(`project.${prefScope}`, id);
  };

  const openForm = (draft: ProjectDraft) => setForm((f) => ({ draft, key: (f?.key ?? 0) + 1 }));

  const saveForm = async (draft: ProjectDraft) => {
    const id = await onSaveProject(draft);
    setForm(null);
    select(id);
  };

  const canStart = !busy && selected !== null && selected.exists;

  const start = () => {
    if (!canStart) return;
    savePref(modelKey(selected.id), model.trim());
    savePref(`model.${prefScope}`, model.trim());
    onStart(selected.path, model.trim(), text.trim());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      start();
    }
  };

  const recent = selected && sessions.cwd === selected.path ? sessions.items : [];

  return (
    <div className="start-screen">
      <section className="start-hero" aria-labelledby="start-title">
        <h1 id="start-title">What do you want to work on?</h1>

        <form
          className="prompt-box start-box"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <label htmlFor="start-input" className="sr-only">
            The first task for the agent
          </label>
          <textarea
            id="start-input"
            ref={area}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!selected}
            placeholder={selected ? `Describe a task for ${selected.name}.` : "Add a project first."}
            spellCheck={false}
          />
          <div className="prompt-tools">
            <div className="prompt-tools-left">
              <ProjectMenu
                projects={projects}
                selected={selected}
                onSelect={select}
                onAdd={() => openForm(NEW_PROJECT)}
                onEdit={(p) => openForm({ id: p.id, name: p.name, path: p.path, create: false })}
                onDelete={onDeleteProject}
              />
              <label className="prompt-chip model-field" title="The model: provider/model. Leave it empty to use default_model.">
                <Cpu size={13} aria-hidden />
                <span className="sr-only">Model</span>
                <input
                  className="mono"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="Default model"
                  size={Math.min(Math.max(model.length, 13), 36)}
                  spellCheck={false}
                  list="model-options"
                />
              </label>
              <datalist id="model-options">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <button
              type="submit"
              className="icon-btn send"
              disabled={!canStart}
              aria-label={text.trim() ? "Start the session with this task (Enter)" : "Start the session (Enter)"}
              title={text.trim() ? "Start the session with this task (Enter)" : "Start the session (Enter)"}
            >
              {busy ? <LoaderCircle size={16} className="spin" aria-hidden /> : <ArrowUp size={16} aria-hidden />}
            </button>
          </div>
        </form>

        <p className="start-help">
          {selected && !selected.exists ? (
            <span className="project-missing">
              <TriangleAlert size={12} aria-hidden /> The folder of {selected.name} does not exist. Edit the project or select another.
            </span>
          ) : (
            <>
              <kbd>Enter</kbd> starts the session. <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line.{" "}
            </>
          )}{" "}
          <button type="button" className="link-btn" onClick={onManageProviders}>
            Manage the providers
          </button>
        </p>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

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

      {recent.length > 0 && selected && !shownForm && (
        <section className="panel recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Recent sessions in {selected.name}</h2>
          <ul>
            {recent.map((s) => (
              <li key={s.id}>
                <button type="button" className="recent-item" onClick={() => onResume(s.id)} disabled={busy}>
                  <span className="recent-title">{s.title ?? "Untitled session"}</span>
                  <span className="recent-meta">
                    <span className="mono">{`${s.provider}/${s.model}`}</span>
                    <span>
                      <Clock size={12} aria-hidden /> {relativeTime(s.updated_at)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
