import { useState } from "react";
import { Clock, FolderOpen, LoaderCircle, Play } from "lucide-react";
import type { SessionSummary } from "../daemon/protocol";
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

export function SessionStart({
  sessions,
  busy,
  error,
  onStart,
  onResume,
  prefScope,
  onBrowse,
}: {
  sessions: SessionSummary[];
  busy: boolean;
  error: string | null;
  onStart: (cwd: string, model: string) => void;
  onResume: (id: string) => void;
  prefScope: string; // The folder and the model are remembered for each connection.
  onBrowse: (current: string) => Promise<string | null>; // The native dialog, or the remote folder picker.
}) {
  const [cwd, setCwd] = useState(() => loadPref(`cwd.${prefScope}`, prefScope === "local" ? loadPref("cwd", "") : ""));
  const [model, setModel] = useState(() => loadPref(`model.${prefScope}`, prefScope === "local" ? loadPref("model", "") : ""));

  const browse = async () => {
    const folder = await onBrowse(cwd.trim());
    if (folder) setCwd(folder);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cwd.trim() || busy) return;
    savePref(`cwd.${prefScope}`, cwd.trim());
    savePref(`model.${prefScope}`, model.trim());
    onStart(cwd.trim(), model.trim());
  };

  return (
    <div className="start-screen">
      <form className="panel start-form" onSubmit={submit}>
        <h1>Start a session</h1>
        <div className="field">
          <label htmlFor="cwd">Project folder</label>
          <div className="field-row">
            <input
              id="cwd"
              className="mono"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={navigator.userAgent.includes("Windows") ?"C:\\Users\\you\\project" : "/home/you/project"}
              spellCheck={false}
              required
            />
            {(
              <button type="button" className="btn" onClick={browse}>
                <FolderOpen size={15} aria-hidden />
                Browse
              </button>
            )}
          </div>
        </div>
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
          />
          <p id="model-help" className="help">
            Use <code>provider/model</code>. The providers come from <code>~/.harness/providers.json</code>. Leave empty
            to use <code>default_model</code>.
          </p>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-wide" disabled={busy || !cwd.trim()}>
          {busy ? <LoaderCircle size={15} className="spin" aria-hidden /> : <Play size={15} aria-hidden />}
          Start session
        </button>
      </form>

      {sessions.length > 0 && (
        <section className="panel recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Recent sessions</h2>
          <ul>
            {sessions.map((s) => (
              <li key={s.id}>
                <button type="button" className="recent-item" onClick={() => onResume(s.id)} disabled={busy}>
                  <span className="recent-title">{s.title ?? "Untitled session"}</span>
                  <span className="recent-meta">
                    <span className="mono" title={s.cwd}>
                      {folderName(s.cwd)}
                    </span>
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
