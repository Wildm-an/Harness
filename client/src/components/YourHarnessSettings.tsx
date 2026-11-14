// Settings > Your Harness: the global instructions of the user, the instructions of each project, and
// the memory of the agent. The memory
// rows follow the "Memory" settings of Claude: "Search and reference chats", "Generate memory from
// chats", "Include sensitive topics in memory", "Your memory" (Manage), "Import memory from other AI
// providers", and "Export memory". Each project has its own memory (daemon memory.py).

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy, Download, LoaderCircle, NotebookPen, Plus, Trash2, Upload } from "lucide-react";
import { BackLink } from "./BackLink";
import type { DaemonConnection } from "../daemon/connection";
import type { MemoryFact, MemoryItem, MemoryType, ProjectItem, UserSettings } from "../daemon/protocol";
import { saveBase64File } from "../lib/tauri";
import { useFormIntoView } from "../lib/formFocus";
import { ConfirmDialog } from "./ConfirmDialog";
import { INSTRUCTION_FIELDS, Row, Switch, TextAreaField } from "./SettingsDialog";
import { NewOutputStyleDialog, OutputStyleSelect, useOutputStyles } from "./OutputStyle";
import { RowsPending } from "./Skeleton";

export const MEMORY_TYPES: [MemoryType, string, string][] = [
  ["user", "User", "Who you are: your role, knowledge, and preferences."],
  ["feedback", "Feedback", "How the agent must work or answer."],
  ["project", "Project", "Goals, decisions, and dates that the code does not show."],
  ["reference", "Reference", "Links and outside resources."],
];

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The name of a memory from a text: lowercase words joined with "-", as the daemon makes them. */
export function memoryName(text: string): string {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 6).join("-").slice(0, 48).replace(/-+$/, "");
}

/** The problem of a memory form, or null. */
export function memoryProblem(d: { name: string; description: string; content: string }): string | null {
  if (!NAME_RE.test(d.name.trim())) return "Use 1-64 lowercase letters, numbers, or -. Start with a letter or a number.";
  if (!d.description.trim()) return "Give a one-line description.";
  if (d.description.trim().length > 200) return "Make the description 200 characters or less.";
  if (!d.content.trim()) return "Give the content of the memory.";
  return null;
}

interface MemoryData {
  cwd: string;
  path: string;
  items: MemoryItem[];
  importPrompt: string;
}

/** The memory of one project: the list from the daemon, and the requests to change it. */
function useMemory(conn: DaemonConnection, cwd: string | null, connected: boolean) {
  const [data, setData] = useState<MemoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<MemoryFact[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; key: number } | null>(null);
  const [imported, setImported] = useState<{ count: number; key: number } | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "memory") {
          if (msg.cwd !== cwdRef.current) return;
          setData({ cwd: msg.cwd, path: msg.path, items: msg.items, importPrompt: msg.import_prompt });
          setBusy(false);
          setError(null);
          if (msg.saved) {
            const name = msg.saved;
            setSaved((s) => ({ name, key: (s?.key ?? 0) + 1 }));
          }
          if (msg.imported !== undefined) {
            const count = msg.imported;
            setImported((s) => ({ count, key: (s?.key ?? 0) + 1 }));
          }
        } else if (msg.type === "memory.parsed") {
          setParsed(msg.items);
          setBusy(false);
        } else if (msg.type === "memory.export") {
          if (msg.cwd !== cwdRef.current) return;
          setBusy(false);
          saveBase64File(msg.name, msg.data, { name: "Zip archive", extensions: ["zip"] }).then(
            (path) => path && setNotice(`Exported ${msg.count} ${msg.count === 1 ? "memory" : "memories"} to ${path}.`),
            (e) => setError(errorText(e)),
          );
        } else if (msg.type === "error" && msg.ref?.startsWith("memory.")) {
          setBusy(false);
          setError(msg.message);
        }
      }),
    [conn],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    setNotice(null);
    if (!cwd || !connected) return;
    try {
      conn.send({ type: "memory.list", cwd });
    } catch {
      // Not connected. The page shows the note.
    }
  }, [conn, cwd, connected]);

  const send = (msg: Parameters<DaemonConnection["send"]>[0]) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      conn.send(msg);
    } catch (e) {
      setBusy(false);
      setError(errorText(e));
    }
  };

  return {
    data: data && data.cwd === cwd ? data : null,
    error,
    busy,
    parsed,
    notice,
    saved,
    imported,
    clearParsed: () => setParsed(null),
    save: (item: MemoryItem, oldName?: string) =>
      cwd &&
      send({ type: "memory.save", cwd, name: item.name.trim(), old_name: oldName, description: item.description.trim(), memory_type: item.type, content: item.content.trim() }),
    remove: (name: string) => cwd && send({ type: "memory.delete", cwd, name }),
    parse: (text: string) => send({ type: "memory.parse", text }),
    importFacts: (items: MemoryFact[]) => cwd && send({ type: "memory.import", cwd, items }),
    exportZip: () => cwd && send({ type: "memory.export", cwd }),
  };
}

/** The instructions of one project from the settings: the text from the daemon, and the request to save it. */
function useProjectInstructions(conn: DaemonConnection, cwd: string | null, connected: boolean) {
  const [data, setData] = useState<{ cwd: string; path: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState(0); // It goes up after each save that the daemon did.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "project_instructions") {
          if (msg.cwd !== cwdRef.current) return;
          setData({ cwd: msg.cwd, path: msg.path, text: msg.text ?? "" });
          setError(null);
          if (msg.saved) setSavedKey((k) => k + 1);
        } else if (msg.type === "error" && msg.ref?.startsWith("project_instructions.")) {
          setError(msg.message);
        }
      }),
    [conn],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    if (!cwd || !connected) return;
    try {
      conn.send({ type: "project_instructions.get", cwd });
    } catch {
      // Not connected. The page shows the note.
    }
  }, [conn, cwd, connected]);

  return {
    data: data && data.cwd === cwd ? data : null,
    error,
    savedKey,
    save: (text: string) => {
      if (!cwd) return;
      setError(null);
      try {
        conn.send({ type: "project_instructions.set", cwd, text: text || null });
      } catch (e) {
        setError(errorText(e));
      }
    },
  };
}

/** The project of the project rows. The Project instructions and the Memory section show the same choice. */
function ProjectSelect({ id, cwd, choices, projectName, disabled, onChange }: {
  id: string;
  cwd: string | null;
  choices: ProjectItem[];
  projectName: string;
  disabled: boolean;
  onChange: (path: string) => void;
}) {
  return (
    <select id={id} value={cwd ?? ""} disabled={disabled || choices.length === 0} onChange={(e) => onChange(e.target.value)}>
      {choices.length === 0 && <option value="">No projects yet</option>}
      {cwd && !choices.some((p) => p.path === cwd) && <option value={cwd}>{projectName}</option>}
      {choices.map((p) => (
        <option key={p.id} value={p.path} title={p.path}>
          {choices.some((o) => o !== p && o.name === p.name) ? `${p.name} · ${p.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? p.path}` : p.name}
        </option>
      ))}
    </select>
  );
}

type View = "main" | "manage" | "import";

export function YourHarnessSettings({
  values,
  connected,
  error,
  onSet,
  conn,
  projects,
  currentProject,
}: {
  values: UserSettings | null; // null: loading, or not connected.
  connected: boolean;
  error: string | null; // The daemon did not save a setting.
  onSet: (changes: Partial<UserSettings>) => void;
  conn: DaemonConnection;
  projects: ProjectItem[] | null;
  currentProject: string | null; // The project of the open session.
}) {
  const off = !connected || values === null;
  const loading = connected && values === null; // The values of the daemon have not arrived yet.
  const [view, setView] = useState<View>("main");
  const [status, setStatus] = useState<"" | "saving" | "saved">("");
  const set = (changes: Partial<UserSettings>) => {
    setStatus("saving");
    onSet(changes);
  };
  // The project of the project rows: the project of the session, else the last project that was used.
  const choices = [...(projects ?? [])].sort((a, b) => b.last_used - a.last_used);
  const [project, setProject] = useState<string | null>(null);
  const cwd = project ?? currentProject ?? choices[0]?.path ?? null;
  const memory = useMemory(conn, cwd, connected);
  const notes = useProjectInstructions(conn, cwd, connected);
  const styles = useOutputStyles(conn, connected);
  const [newStyle, setNewStyle] = useState(false);
  useEffect(() => {
    if (styles.created) setNewStyle(false); // The new style is the output style now.
  }, [styles.created]);

  useEffect(() => {
    if (status !== "saving") return;
    setStatus("saved");
    const timer = window.setTimeout(() => setStatus(""), 1500);
    return () => window.clearTimeout(timer);
  }, [values, notes.savedKey]);
  useEffect(() => {
    if (error || notes.error) setStatus("");
  }, [error, notes.error]);
  const projectName = choices.find((p) => p.path === cwd)?.name ?? cwd?.split(/[\\/]/).filter(Boolean).pop() ?? "";

  useEffect(() => {
    if (memory.imported) setView("manage");
  }, [memory.imported]);

  if (view === "manage" && cwd) {
    return <ManageMemory projectName={projectName} memory={memory} onBack={() => setView("main")} />;
  }
  if (view === "import" && cwd) {
    return <ImportMemory projectName={projectName} memory={memory} onBack={() => setView("main")} />;
  }

  const memoryOff = values?.auto_memory === false;
  const count = memory.data?.items.length;

  return (
    <div className="settings-page">
      <div className="settings-page-head">
        <h2 className="settings-page-title">Your Harness</h2>
        <span className="settings-status" aria-live="polite">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!connected && <p className="help settings-note">Connect to a computer to change the settings of its daemon.</p>}

      <h3 className="settings-section">Global instructions</h3>
      <p className="help settings-note">
        The agent that you talk to follows these instructions in all projects. A subagent does not get them: its agent tells it how to act. The project instructions can change them for one project. A change applies at the next turn.
      </p>
      <Row label="Output style" help="How the agent structures its replies, in all projects." htmlFor="setting-output-style">
        <OutputStyleSelect
          id="setting-output-style"
          value={values?.output_style ?? "default"}
          items={styles.items}
          disabled={off}
          onChange={(id) => set({ output_style: id })}
          onNew={() => {
            styles.clearError();
            setNewStyle(true);
          }}
        />
      </Row>
      {styles.created?.note && (
        <p className="help settings-note" role="status">
          {styles.created.note}
        </p>
      )}
      {styles.error && !newStyle && (
        <p className="form-error" role="alert">
          {styles.error}
        </p>
      )}
      {newStyle && (
        <NewOutputStyleDialog busy={styles.creating} error={styles.error} onCreate={styles.create} onClose={() => setNewStyle(false)} />
      )}
      {INSTRUCTION_FIELDS.map(([key, label, help, placeholder]) => (
        <div key={key} className="setting-block">
          <label className="setting-label" htmlFor={`setting-${key}`}>
            {label}
          </label>
          <span className="setting-help">{help}</span>
          {loading ? (
            <span className="skeleton skeleton-textarea" aria-busy="true" aria-label="Loading" />
          ) : (
            <TextAreaField id={`setting-${key}`} value={values?.[key] ?? ""} placeholder={placeholder} disabled={off} onSave={(v) => set({ [key]: v || null })} />
          )}
        </div>
      ))}

      <h3 className="settings-section">Project instructions</h3>
      <p className="help settings-note">
        The agents of one project follow these instructions, with the global instructions. Each project has its own text. Harness keeps the text out of the project folder. A HARNESS.md, AGENTS.md, or CLAUDE.md file in the project folder also applies. A change applies at the next turn.
      </p>
      <Row label="Project" help="The instructions below apply to this project only. The Memory rows use the same project." htmlFor="setting-instructions-project">
        <ProjectSelect id="setting-instructions-project" cwd={cwd} choices={choices} projectName={projectName} disabled={off} onChange={setProject} />
      </Row>
      <div className="setting-block">
        <label className="setting-label" htmlFor="setting-project-instructions">
          {projectName ? `Instructions for ${projectName}` : "Instructions for the project"}
        </label>
        <span className="setting-help">Rules for this project, for example its commands and its code style.</span>
        {connected && cwd && !notes.data && !notes.error ? (
          <span className="skeleton skeleton-textarea" aria-busy="true" aria-label="Loading" />
        ) : (
          <TextAreaField
            key={cwd ?? ""}
            id="setting-project-instructions"
            value={notes.data?.text ?? ""}
            placeholder="e.g. Use pnpm, not npm. Run the tests before you stop."
            disabled={off || !notes.data}
            rows={5}
            onSave={(v) => {
              setStatus("saving");
              notes.save(v);
            }}
          />
        )}
        {notes.data && <span className="setting-help mono">{notes.data.path}</span>}
      </div>
      {notes.error && (
        <p className="form-error" role="alert">
          {notes.error}
        </p>
      )}

      <h3 className="settings-section">Memory</h3>
      {/* The switches show gray bars until the values arrive (rule R8). */}
      <RowsPending.Provider value={loading}>
      <Row label="Search and reference chats" help="Allow the agent to search for relevant details in the past sessions of the same project.">
        <Switch checked={values?.chat_search !== false} label="Search and reference chats" disabled={off} onChange={(on) => set({ chat_search: on })} />
      </Row>
      <Row label="Generate memory from chats" help="Allow the agent to keep notes about you and the project between sessions. /memory lists them.">
        <Switch checked={!memoryOff} label="Generate memory from chats" disabled={off} onChange={(on) => set({ auto_memory: on })} />
      </Row>
      <Row
        label="Include sensitive topics in memory"
        help="Allow the agent to save details about sensitive topics like health conditions or religious beliefs to memory."
        title={memoryOff ? "Available when Generate memory from chats is on" : undefined}
      >
        <Switch
          checked={values?.memory_sensitive === true}
          label="Include sensitive topics in memory"
          disabled={off || memoryOff}
          onChange={(on) => set({ memory_sensitive: on })}
        />
      </Row>
      </RowsPending.Provider>
      <Row label="Project" help="Each project has its own memory. The rows below apply to this project." htmlFor="setting-memory-project">
        <ProjectSelect id="setting-memory-project" cwd={cwd} choices={choices} projectName={projectName} disabled={off} onChange={setProject} />
      </Row>
      <Row
        label="Your memory"
        help={count === undefined ? "See, add, edit, or delete what's in memory." : `See, add, edit, or delete what's in memory. ${count} ${count === 1 ? "memory" : "memories"} now.`}
      >
        <button type="button" className="btn btn-small" disabled={off || !cwd} onClick={() => setView("manage")}>
          Manage
        </button>
      </Row>
      <Row
        label="Import memory from other AI providers"
        help="Bring relevant context and data from another AI provider to Harness. Harness gives a prompt that you can use to get the memory from your other account."
      >
        <button type="button" className="btn btn-small" disabled={off || !cwd} onClick={() => setView("import")}>
          Start import
        </button>
      </Row>
      <Row label="Export memory" help="Download your memory as a .zip of Markdown files.">
        <button type="button" className="btn btn-small" disabled={off || !cwd || memory.busy} onClick={() => memory.exportZip()}>
          {memory.busy ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Download size={14} aria-hidden />}
          Export
        </button>
      </Row>
      {memory.notice && (
        <p className="help settings-note" role="status">
          {memory.notice}
        </p>
      )}
      {memory.error && (
        <p className="form-error" role="alert">
          {memory.error}
        </p>
      )}
    </div>
  );
}

type Memory = ReturnType<typeof useMemory>;

const EMPTY: MemoryItem = { name: "", description: "", type: "user", content: "" };

/** "Your memory" > Manage: the list of the memories of the project, with an editor for each one. */
function ManageMemory({ projectName, memory, onBack }: { projectName: string; memory: Memory; onBack: () => void }) {
  // The memory that the editor shows: its name, or "" for a new memory. null: no editor.
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemoryItem>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const pending = useRef<string | null>(null);

  // Close the editor when the daemon saved the memory.
  useEffect(() => {
    if (memory.saved && pending.current === memory.saved.name) {
      pending.current = null;
      setOpen(null);
    }
  }, [memory.saved]);

  const edit = (item: MemoryItem | null) => {
    setProblem(null);
    setDraft(item ? { ...item } : { ...EMPTY });
    setOpen(item ? item.name : "");
  };

  const submit = () => {
    const found = memoryProblem(draft);
    setProblem(found);
    if (found) return;
    pending.current = draft.name.trim();
    memory.save(draft, open || undefined);
  };

  const items = memory.data?.items ?? null;
  const editor = (
    <MemoryEditor
      draft={draft}
      isNew={open === ""}
      problem={problem ?? memory.error}
      busy={memory.busy}
      onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      onCancel={() => setOpen(null)}
      onSave={submit}
      onDelete={() => setConfirm(open)}
    />
  );

  return (
    <div className="settings-page memory-view">
      <BackLink to="Your Harness" onClick={onBack} />
      <div className="cap-view-head">
        <h2>Your memory</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={() => edit(null)} disabled={open === ""}>
          <Plus size={14} aria-hidden />
          Add memory
        </button>
      </div>
      <p className="help settings-note">
        {projectName}
        {memory.data && <span className="mono"> · {memory.data.path}</span>}
      </p>
      {open === "" && editor}
      {items === null ? (
        memory.error ? (
          <p className="form-error" role="alert">
            {memory.error}
          </p>
        ) : (
          <p className="help settings-note">
            <LoaderCircle size={14} className="spin" aria-hidden /> Loading the memories…
          </p>
        )
      ) : items.length === 0 ? (
        open !== "" && <p className="help settings-note">No memories yet. The agent saves memories as it works, or you can add one.</p>
      ) : (
        <ul className="cap-list memory-list">
          {items.map((item) => (
            <li key={item.name} className="cap-item memory-item">
              <button type="button" className="cap-row" aria-expanded={open === item.name} onClick={() => (open === item.name ? setOpen(null) : edit(item))}>
                <span className="cap-icon" aria-hidden>
                  <NotebookPen size={15} />
                </span>
                <span className="cap-text">
                  <span className="cap-name">{item.name}</span>
                  <span className="cap-desc">{item.description}</span>
                </span>
                <span className="cap-status cap-off">{MEMORY_TYPES.find(([t]) => t === item.type)?.[1] ?? item.type}</span>
                <ChevronRight size={14} aria-hidden className={`cap-go${open === item.name ? " open" : ""}`} />
              </button>
              {open === item.name && editor}
            </li>
          ))}
        </ul>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Delete ${confirm}?`}
          confirmLabel="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            memory.remove(confirm);
            setConfirm(null);
            setOpen(null);
          }}
        >
          The agent no longer sees this memory. The other memories stay.
        </ConfirmDialog>
      )}
    </div>
  );
}

function MemoryEditor({ draft, isNew, problem, busy, onChange, onCancel, onSave, onDelete }: {
  draft: MemoryItem;
  isNew: boolean;
  problem: string | null;
  busy: boolean;
  onChange: (patch: Partial<MemoryItem>) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const typeHelp = MEMORY_TYPES.find(([t]) => t === draft.type)?.[2];
  const intoView = useFormIntoView();
  return (
    <form
      ref={intoView}
      className="memory-editor"
      noValidate
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="field-row">
        <div className="field">
          <label htmlFor="memory-name">Name</label>
          <input
            id="memory-name"
            className="mono"
            value={draft.name}
            placeholder="user-role"
            spellCheck={false}
            maxLength={64}
            onChange={(e) => onChange({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
          />
        </div>
        <div className="field">
          <label htmlFor="memory-type">Type</label>
          <select id="memory-type" value={draft.type} onChange={(e) => onChange({ type: e.target.value as MemoryType })}>
            {MEMORY_TYPES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {typeHelp && <p className="help">{typeHelp}</p>}
      <div className="field">
        <label htmlFor="memory-description">Description</label>
        <input
          id="memory-description"
          value={draft.description}
          placeholder="One line that tells when the memory is useful"
          maxLength={200}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="memory-content">Content</label>
        <textarea
          id="memory-content"
          className="setting-textarea"
          rows={5}
          value={draft.content}
          placeholder="The fact. For a feedback or project memory, add a Why: line and a How to apply: line."
          maxLength={5000}
          onChange={(e) => {
            const content = e.target.value;
            // A new memory gets a name from its first words, until the user types a name.
            onChange(isNew && (draft.name === "" || draft.name === memoryName(draft.content)) ? { content, name: memoryName(content) } : { content });
          }}
        />
      </div>
      {problem && (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
      <div className="form-actions">
        {!isNew && (
          <button type="button" className="btn btn-small btn-danger" onClick={onDelete}>
            <Trash2 size={14} aria-hidden />
            Delete…
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={onCancel} data-form-cancel>
          Cancel
        </button>
        <button type="submit" className="btn btn-small btn-primary" disabled={busy}>
          {busy && <LoaderCircle size={14} className="spin" aria-hidden />}
          {isNew ? "Add memory" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** "Import memory from other AI providers": copy the prompt, paste the reply, check the facts, import. */
function ImportMemory({ projectName, memory, onBack }: { projectName: string; memory: Memory; onBack: () => void }) {
  const [reply, setReply] = useState("");
  const [copied, setCopied] = useState(false);
  const [chosen, setChosen] = useState<boolean[]>([]);
  const prompt = memory.data?.importPrompt ?? "";
  const facts = memory.parsed;

  useEffect(() => memory.clearParsed, []); // A new import starts with no preview.
  useEffect(() => setChosen(facts ? facts.map(() => true) : []), [facts]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const picked = facts ? facts.filter((_, i) => chosen[i]) : [];

  return (
    <div className="settings-page memory-view">
      <BackLink to="Your Harness" onClick={onBack} />
      <div className="cap-view-head">
        <h2>Import memory</h2>
      </div>
      <p className="help settings-note">The memories go to the project {projectName}.</p>

      <div className="setting-block">
        <span className="setting-label">1. Copy this prompt into a chat with your other AI provider</span>
        <pre className="memory-prompt">{prompt || "Loading…"}</pre>
        <button type="button" className="btn btn-small" disabled={!prompt} onClick={() => void copy()}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>

      <div className="setting-block">
        <label className="setting-label" htmlFor="memory-reply">
          2. Paste the reply here
        </label>
        <textarea
          id="memory-reply"
          className="setting-textarea"
          rows={8}
          value={reply}
          placeholder={"[user] I am a data engineer.\n[feedback] Keep answers short."}
          onChange={(e) => setReply(e.target.value)}
        />
        <div className="form-actions">
          <button type="button" className="btn btn-small" disabled={!reply.trim() || memory.busy} onClick={() => memory.parse(reply)}>
            Preview
          </button>
        </div>
      </div>

      {facts && (
        <div className="setting-block">
          <span className="setting-label">3. Choose the memories to import</span>
          {facts.length === 0 ? (
            <p className="help">The reply has no facts. Each fact must be on its own line.</p>
          ) : (
            <ul className="memory-facts">
              {facts.map((fact, i) => (
                <li key={i}>
                  <label>
                    <input type="checkbox" checked={chosen[i] ?? false} onChange={(e) => setChosen((c) => c.map((v, j) => (j === i ? e.target.checked : v)))} />
                    <span className="cap-status cap-off">{MEMORY_TYPES.find(([t]) => t === fact.type)?.[1] ?? fact.type}</span>
                    <span>{fact.content}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="form-actions">
            <button type="button" className="btn btn-small btn-primary" disabled={picked.length === 0 || memory.busy} onClick={() => memory.importFacts(picked)}>
              {memory.busy ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Upload size={14} aria-hidden />}
              Import {picked.length} {picked.length === 1 ? "memory" : "memories"}
            </button>
          </div>
        </div>
      )}
      {memory.error && (
        <p className="form-error" role="alert">
          {memory.error}
        </p>
      )}
    </div>
  );
}
