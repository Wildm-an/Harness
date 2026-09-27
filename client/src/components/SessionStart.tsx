import { useEffect, useState } from "react";
import { Clock, Folder, FolderOpen, FolderPlus, LoaderCircle, Pencil, Play, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import type { ProjectItem, SessionSummary } from "../daemon/protocol";
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
      <h2 className="form-title">{isNew ? "New project" : `Edit ${initial.name}`}</h2>
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
  onStart: (cwd: string, model: string) => void;
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
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const selected = projects?.find((p) => p.id === selectedId) ?? projects?.[0] ?? null;
  const modelKey = (id: string | undefined) => (id ? `model.${prefScope}.${id}` : `model.${prefScope}`);
  const [model, setModel] = useState("");

  // Each project remembers its model. A project with no model uses the last model of the connection.
  useEffect(() => {
    setModel(loadPref(modelKey(selected?.id), loadPref(`model.${prefScope}`, "")));
    if (selected) onListSessions(selected.path);
  }, [selected?.id, selected?.sessions]);

  const select = (id: string) => {
    setSelectedId(id);
    savePref(`project.${prefScope}`, id);
    setConfirmRemove(null);
  };

  const openForm = (draft: ProjectDraft) => setForm((f) => ({ draft, key: (f?.key ?? 0) + 1 }));

  const saveForm = async (draft: ProjectDraft) => {
    const id = await onSaveProject(draft);
    setForm(null);
    select(id);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || busy) return;
    savePref(modelKey(selected.id), model.trim());
    savePref(`model.${prefScope}`, model.trim());
    onStart(selected.path, model.trim());
  };

  const noProjects = projects !== null && projects.length === 0;
  const recent = selected && sessions.cwd === selected.path ? sessions.items : [];

  return (
    <div className="start-screen">
      <section className="panel start-form" aria-labelledby="start-title">
        <h1 id="start-title">Start a session</h1>

        <div className="list-head">
          <span id="projects-label">Projects</span>
          <button type="button" className="btn btn-small" onClick={() => openForm({ name: "", path: "", create: true })} disabled={!!form && !form.draft.id}>
            <Plus size={14} aria-hidden />
            New
          </button>
        </div>

        {projects === null ? (
          <p className="pane-empty">
            <LoaderCircle size={16} className="spin" aria-hidden /> Loading the projects.
          </p>
        ) : noProjects && !form ? (
          <div className="project-empty">
            <p>Add a project: a folder for the agent. The agent creates and changes files only in this folder.</p>
            <button type="button" className="btn btn-primary" onClick={() => openForm({ name: "", path: "", create: true })}>
              <FolderPlus size={15} aria-hidden />
              Add a project
            </button>
          </div>
        ) : (
          <ul className="project-list" role="radiogroup" aria-labelledby="projects-label">
            {projects.map((p) => {
              const checked = p.id === selected?.id;
              return (
                <li key={p.id} className={`project-row${checked ? " selected" : ""}`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    className="project-main"
                    onClick={() => select(p.id)}
                  >
                    <span className={`project-dot${checked ? " on" : ""}`} aria-hidden />
                    <Folder size={15} aria-hidden className="project-icon" />
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
                  <div className="project-actions">
                    {confirmRemove === p.id ? (
                      <>
                        <button type="button" className="btn btn-danger btn-small" onClick={() => onDeleteProject(p.id)}>
                          <Trash2 size={13} aria-hidden />
                          Remove
                        </button>
                        <button type="button" className="icon-btn ghost" onClick={() => setConfirmRemove(null)} aria-label="Keep the project" title="Keep">
                          <X size={14} aria-hidden />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="icon-btn ghost"
                          onClick={() => openForm({ id: p.id, name: p.name, path: p.path, create: false })}
                          aria-label={`Edit ${p.name}`}
                          title="Edit"
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="icon-btn ghost"
                          onClick={() => setConfirmRemove(p.id)}
                          aria-label={`Remove ${p.name} from the list`}
                          title="Remove from the list. The folder and its files stay."
                        >
                          <X size={14} aria-hidden />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {form && (
          <ProjectForm
            key={form.key}
            initial={form.draft}
            onSave={saveForm}
            onCancel={noProjects ? null : () => setForm(null)}
            onBrowse={onBrowse}
          />
        )}

        <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="model">Model</label>
          <input
            id="model"
            className="mono"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="local-ollama/qwen2.5-coder:7b"
            spellCheck={false}
            aria-describedby="model-help"
            list="model-options"
          />
          <datalist id="model-options">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p id="model-help" className="help">
            Use <code>provider/model</code>. Leave empty to use <code>default_model</code>.{" "}
            <button type="button" className="link-btn" onClick={onManageProviders}>
              Manage the providers
            </button>
          </p>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-wide" disabled={busy || !selected || !selected.exists}>
          {busy ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Play size={15} aria-hidden />}
          {selected ? `Start a session in ${selected.name}` : "Start session"}
        </button>
        </form>
      </section>

      {recent.length > 0 && selected && (
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
