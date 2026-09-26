import { useState } from "react";
import { Check, Globe, KeyRound, LoaderCircle, Monitor, Pencil, Plug, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import type { HostInfo } from "../daemon/protocol";
import { describe, newConnectionId, validate, type Connection, type ConnectionKind } from "../lib/connections";
import { isTauri } from "../lib/tauri";

const ICONS = { local: Monitor, direct: Globe, ssh: KeyRound };

type TestState = { state: "idle" } | { state: "busy" } | { state: "ok"; host: HostInfo } | { state: "error"; message: string };

function Field({
  id,
  label,
  error,
  help,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      ) : (
        help && <p className="help">{help}</p>
      )}
    </div>
  );
}

function ConnectionForm({
  initial,
  isNew,
  hasToken,
  onSave,
  onCancel,
  onTest,
}: {
  initial: Connection;
  isNew: boolean;
  hasToken: boolean; // A token for this connection is in the keychain.
  onSave: (c: Connection, token: string) => Promise<void>;
  onCancel: () => void;
  onTest: (c: Connection, token: string) => Promise<HostInfo>;
}) {
  const [c, setC] = useState<Connection>(initial);
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ state: "idle" });

  const update = (patch: Partial<Connection>) => {
    setC((prev) => ({ ...prev, ...patch }));
    setTest({ state: "idle" });
  };
  const numberOrUndefined = (v: string) => (v.trim() === "" ? undefined : Number(v));

  const check = () => {
    const found = validate(c, token, !hasToken);
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const runTest = async () => {
    if (!check()) return;
    setTest({ state: "busy" });
    try {
      setTest({ state: "ok", host: await onTest(c, token) });
    } catch (e) {
      setTest({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!check()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ ...c, name: c.name.trim(), host: c.host.trim(), sshUser: c.sshUser?.trim() || undefined }, token);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const describedBy = (field: string) => (errors[field] ? `cf-${field}-error` : undefined);

  return (
    <form className="panel connection-form" onSubmit={submit} noValidate autoComplete="off">
      <h2 className="form-title">{isNew ? "Add a remote daemon" : `Edit ${initial.name}`}</h2>

      <Field id="cf-name" label="Name" error={errors.name}>
        <input
          id="cf-name"
          value={c.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Build server"
          aria-invalid={!!errors.name}
          aria-describedby={describedBy("name")}
        />
      </Field>

      <div className="field">
        <span className="field-label" id="cf-kind-label">
          Connect through
        </span>
        <div className="segmented wide" role="radiogroup" aria-labelledby="cf-kind-label">
          {(["direct", "ssh"] as ConnectionKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={c.kind === kind}
              aria-pressed={c.kind === kind}
              onClick={() => update({ kind })}
            >
              {kind === "direct" ? <Globe size={14} aria-hidden /> : <KeyRound size={14} aria-hidden />}
              {kind === "direct" ? "Direct (Tailscale or LAN)" : "SSH tunnel"}
            </button>
          ))}
        </div>
        <p className="help">
          {c.kind === "direct"
            ? "The client connects to the daemon address. Use a private network such as Tailscale. Never expose the daemon to the internet."
            : "The app opens an SSH tunnel to the daemon, which listens on 127.0.0.1 of the remote host. SSH must log in with a key, with no password prompt."}
        </p>
      </div>

      <div className="field-grid">
        <Field id="cf-host" label={c.kind === "ssh" ? "SSH host" : "Daemon host"} error={errors.host}>
          <input
            id="cf-host"
            className="mono"
            value={c.host}
            onChange={(e) => update({ host: e.target.value })}
            placeholder={c.kind === "ssh" ? "build-box" : "build-box.tailnet.ts.net"}
            spellCheck={false}
            aria-invalid={!!errors.host}
            aria-describedby={describedBy("host")}
          />
        </Field>
        <Field id="cf-port" label="Daemon port" error={errors.port}>
          <input
            id="cf-port"
            className="mono"
            inputMode="numeric"
            value={Number.isNaN(c.port) || c.port === 0 ? "" : String(c.port)}
            onChange={(e) => update({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
            placeholder="8765"
            aria-invalid={!!errors.port}
            aria-describedby={describedBy("port")}
          />
        </Field>
      </div>

      {c.kind === "ssh" && (
        <>
          <div className="field-grid">
            <Field id="cf-user" label="SSH user" error={errors.sshUser} help="Optional. The default comes from your SSH config.">
              <input
                id="cf-user"
                className="mono"
                value={c.sshUser ?? ""}
                onChange={(e) => update({ sshUser: e.target.value })}
                spellCheck={false}
                aria-invalid={!!errors.sshUser}
                aria-describedby={describedBy("sshUser")}
              />
            </Field>
            <Field id="cf-sshport" label="SSH port" error={errors.sshPort}>
              <input
                id="cf-sshport"
                className="mono"
                inputMode="numeric"
                value={c.sshPort === undefined ? "" : String(c.sshPort)}
                onChange={(e) => update({ sshPort: numberOrUndefined(e.target.value.replace(/\D/g, "")) })}
                placeholder="22"
                aria-invalid={!!errors.sshPort}
                aria-describedby={describedBy("sshPort")}
              />
            </Field>
          </div>
          <Field id="cf-identity" label="Identity file" help="Optional. The private key file, for example ~/.ssh/id_ed25519.">
            <input
              id="cf-identity"
              className="mono"
              value={c.identityFile ?? ""}
              onChange={(e) => update({ identityFile: e.target.value })}
              spellCheck={false}
            />
          </Field>
        </>
      )}

      <Field
        id="cf-token"
        label="Token"
        error={errors.token}
        help={
          hasToken
            ? "Leave empty to keep the saved token."
            : isTauri()
              ? "The app keeps the token in the keychain of your operating system."
              : "Without the desktop app, the token is kept only until this tab closes."
        }
      >
        <input
          id="cf-token"
          className="mono"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setTest({ state: "idle" });
          }}
          aria-invalid={!!errors.token}
          aria-describedby={describedBy("token")}
        />
      </Field>

      <div className="test-result" role="status">
        {test.state === "busy" && (
          <span>
            <LoaderCircle size={14} className="spin" aria-hidden /> Testing the connection.
          </span>
        )}
        {test.state === "ok" && (
          <span className="ok">
            <Check size={14} aria-hidden /> Connected to {test.host.hostname} ({test.host.platform}) as {test.host.user}.
          </span>
        )}
        {test.state === "error" && (
          <span className="bad">
            <TriangleAlert size={14} aria-hidden /> {test.message}
          </span>
        )}
      </div>
      {saveError && (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      )}

      <div className="form-actions">
        <button type="button" className="btn" onClick={runTest} disabled={test.state === "busy" || saving}>
          <Plug size={14} aria-hidden />
          Test
        </button>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving && <LoaderCircle size={14} className="spin" aria-hidden />}
          Save
        </button>
      </div>
    </form>
  );
}

export function ConnectionsScreen({
  connections,
  currentId,
  connectingId,
  error,
  tokenIds,
  canReturn,
  hasSession,
  onConnect,
  onSave,
  onDelete,
  onTest,
  onReturn,
}: {
  connections: Connection[];
  currentId: string | null; // The connection that is open now.
  connectingId: string | null;
  error: { id: string; message: string } | null;
  tokenIds: Set<string>; // Connections with a saved token.
  canReturn: boolean; // The current connection is open.
  hasSession: boolean;
  onConnect: (c: Connection) => void;
  onSave: (c: Connection, token: string) => Promise<void>;
  onDelete: (c: Connection) => void;
  onTest: (c: Connection, token: string) => Promise<HostInfo>;
  onReturn: () => void;
}) {
  const [editing, setEditing] = useState<{ connection: Connection; isNew: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const startAdd = () =>
    setEditing({ connection: { id: newConnectionId(), name: "", kind: "direct", host: "", port: 8765 }, isNew: true });

  return (
    <div className="start-screen">
      <section className="panel connections" aria-labelledby="connections-title">
        <div className="panel-head">
          <h1 id="connections-title">Connections</h1>
          {canReturn && (
            <button type="button" className="btn btn-ghost" onClick={onReturn}>
              {hasSession ? "Back to the session" : "Back"}
            </button>
          )}
        </div>
        <ul className="connection-list">
          {connections.map((c) => {
            const Icon = ICONS[c.kind];
            const current = c.id === currentId;
            const busy = c.id === connectingId;
            const unavailable = c.kind === "local" && !isTauri();
            return (
              <li key={c.id} className={`connection${current ? " current" : ""}`}>
                <Icon size={18} aria-hidden className="connection-icon" />
                <div className="connection-text">
                  <span className="connection-name">
                    {c.name}
                    {current && <span className="badge ok">Connected</span>}
                  </span>
                  <span className="connection-desc mono">{describe(c)}</span>
                  {unavailable && <span className="help">The local daemon needs the desktop app.</span>}
                  {c.kind !== "local" && !tokenIds.has(c.id) && <span className="help">No saved token. Edit the connection.</span>}
                  {error?.id === c.id && (
                    <span className="field-error" role="alert">
                      {error.message}
                    </span>
                  )}
                </div>
                <div className="connection-actions">
                  {c.kind !== "local" &&
                    (confirmDelete === c.id ? (
                      <>
                        <button type="button" className="btn btn-danger btn-small" onClick={() => onDelete(c)}>
                          <Trash2 size={14} aria-hidden />
                          Delete
                        </button>
                        <button
                          type="button"
                          className="icon-btn ghost"
                          onClick={() => setConfirmDelete(null)}
                          aria-label="Keep the connection"
                          title="Keep"
                        >
                          <X size={14} aria-hidden />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="icon-btn ghost"
                          onClick={() => setEditing({ connection: c, isNew: false })}
                          aria-label={`Edit ${c.name}`}
                          title="Edit"
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="icon-btn ghost"
                          onClick={() => setConfirmDelete(c.id)}
                          aria-label={`Delete ${c.name}`}
                          title="Delete"
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </>
                    ))}
                  <button
                    type="button"
                    className={`btn btn-small${current ? "" : " btn-primary"}`}
                    onClick={() => onConnect(c)}
                    disabled={busy || unavailable || connectingId !== null}
                  >
                    {busy ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Plug size={14} aria-hidden />}
                    {current ? "Reconnect" : "Connect"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        {!editing && (
          <button type="button" className="btn btn-wide add-connection" onClick={startAdd}>
            <Plus size={15} aria-hidden />
            Add a remote daemon
          </button>
        )}
      </section>

      {editing && (
        <ConnectionForm
          key={editing.connection.id}
          initial={editing.connection}
          isNew={editing.isNew}
          hasToken={tokenIds.has(editing.connection.id)}
          onTest={onTest}
          onCancel={() => setEditing(null)}
          onSave={async (c, token) => {
            await onSave(c, token);
            setEditing(null);
          }}
        />
      )}

      <section className="panel remote-help" aria-labelledby="remote-help-title">
        <h2 id="remote-help-title">Start a daemon on a remote computer</h2>
        <ol>
          <li>
            Install the daemon on the remote computer, then start it:
            <pre className="tool-pre">python -m harness_daemon --port 8765</pre>
          </li>
          <li>
            The daemon prints its token. The token is also in <code>~/.harness/daemon-token</code> on that computer.
          </li>
          <li>
            For an SSH tunnel, keep the default address <code>127.0.0.1</code>. For Tailscale, add{" "}
            <code>--host</code> with the Tailscale address of the computer.
          </li>
        </ol>
      </section>
    </div>
  );
}
