import { useEffect, useRef, useState } from "react";
import { Check, Copy, Globe, KeyRound, LoaderCircle, Lock, Monitor, Pencil, Play, Plug, Plus, RefreshCw, Square, Trash2, TriangleAlert } from "lucide-react";
import { SecretInput, SecretTextArea } from "./SecretInput";
import type { HostInfo } from "../daemon/protocol";
import {
  describe,
  loadSshSecret,
  loadToken,
  newConnectionId,
  validate,
  type Connection,
  type ConnectionSecrets,
  type SshAuth,
} from "../lib/connections";
import { isTauri, SERVER_DAEMON_EVENT, SERVER_DAEMON_PORT, serverDaemon, type ServerInfo } from "../lib/tauri";
import { useFormIntoView } from "../lib/formFocus";
import { useConfirm } from "./ConfirmDialog";

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
  onSave: (c: Connection, secrets: ConnectionSecrets) => Promise<void>;
  onCancel: () => void;
  onTest: (c: Connection, secrets: ConnectionSecrets) => Promise<HostInfo>;
}) {
  // The desktop app connects only through an SSH tunnel (the user asked for this). A saved direct
  // connection becomes an SSH connection when the user edits it. A normal browser cannot open an SSH
  // tunnel, so it keeps a direct connection.
  const [c, setC] = useState<Connection>(() => ({ ...initial, kind: isTauri() ? "ssh" : "direct" }));
  const [token, setToken] = useState("");
  // The SSH login: a pasted private key (empty: the keys of this computer), or a password.
  const [sshKey, setSshKey] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const auth: SshAuth = c.sshAuth ?? "key";
  const secrets = (): ConnectionSecrets => ({ token, sshKey, sshPassword });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ state: "idle" });

  // Edit: the field shows the saved token (hidden until "Show the token"), so the user can copy it.
  useEffect(() => {
    if (!hasToken) return;
    let live = true;
    loadToken(initial.id).then(
      (saved) => live && saved && setToken((typed) => typed || saved),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [hasToken, initial.id]);

  // Edit: the fields show the saved SSH key and password, hidden until "Show".
  useEffect(() => {
    if (isNew) return;
    let live = true;
    void loadSshSecret(initial.id, "key").then((saved) => live && saved && setSshKey((typed) => typed || saved), () => undefined);
    void loadSshSecret(initial.id, "password").then(
      (saved) => live && saved && setSshPassword((typed) => typed || saved),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [isNew, initial.id]);

  const update = (patch: Partial<Connection>) => {
    setC((prev) => ({ ...prev, ...patch }));
    setTest({ state: "idle" });
  };
  const numberOrUndefined = (v: string) => (v.trim() === "" ? undefined : Number(v));

  const check = () => {
    const found = validate(c, token, !hasToken, sshPassword);
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const runTest = async () => {
    if (!check()) return;
    setTest({ state: "busy" });
    try {
      setTest({ state: "ok", host: await onTest(c, secrets()) });
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
      await onSave(
        { ...c, name: c.name.trim(), host: c.host.trim(), sshUser: c.sshUser?.trim() || undefined, sshAuth: auth },
        secrets(),
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const describedBy = (field: string) => (errors[field] ? `cf-${field}-error` : undefined);
  const intoView = useFormIntoView();

  return (
    <form ref={intoView} className="panel connection-form" onSubmit={submit} noValidate autoComplete="off">
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

      <p className="help">
        {c.kind === "ssh"
          ? "The app opens an SSH tunnel to the daemon, which listens on 127.0.0.1 of the remote computer."
          : "A normal browser cannot open an SSH tunnel, so it connects to the daemon address directly. Never expose the daemon to the internet."}
      </p>

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
          <div className="field">
            <span className="field-label" id="cf-auth-label">
              Log in with
            </span>
            <div className="segmented wide" role="radiogroup" aria-labelledby="cf-auth-label">
              {(["key", "password"] as SshAuth[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={auth === kind}
                  aria-pressed={auth === kind}
                  onClick={() => update({ sshAuth: kind })}
                >
                  {kind === "key" ? <KeyRound size={14} aria-hidden /> : <Lock size={14} aria-hidden />}
                  {kind === "key" ? "SSH key" : "Password"}
                </button>
              ))}
            </div>
          </div>
          {auth === "key" ? (
            <Field
              id="cf-sshkey"
              label="Private key"
              help={
                c.identityFile && !sshKey.trim()
                  ? `Optional. Paste the whole private key. With no key here, the app uses the key file ${c.identityFile}.`
                  : "Optional. Paste the whole private key, for example the text of ~/.ssh/id_ed25519. With no key here, the app uses the keys of this computer. The app keeps the key in the keychain."
              }
            >
              <SecretTextArea
                what="the private key"
                id="cf-sshkey"
                value={sshKey}
                onChange={(e) => {
                  setSshKey(e.target.value);
                  setTest({ state: "idle" });
                }}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              />
            </Field>
          ) : (
            <Field
              id="cf-sshpassword"
              label="Password"
              error={errors.sshPassword}
              help="The password of the SSH user on the remote computer. The app keeps it in the keychain."
            >
              <SecretInput
                what="the password"
                id="cf-sshpassword"
                className="mono"
                autoComplete="off"
                value={sshPassword}
                onChange={(e) => {
                  setSshPassword(e.target.value);
                  setTest({ state: "idle" });
                }}
                aria-invalid={!!errors.sshPassword}
                aria-describedby={describedBy("sshPassword")}
              />
            </Field>
          )}
        </>
      )}

      <Field
        id="cf-token"
        label="Token"
        error={errors.token}
        help={
          hasToken
            ? "The saved token. Type a new token to replace it."
            : isTauri()
              ? "The app keeps the token in the keychain of your operating system."
              : "Without the desktop app, the token is kept only until this tab closes."
        }
      >
        <SecretInput
          what="the token"
          copy
          id="cf-token"
          className="mono"
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
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving} data-form-cancel>
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
  embedded = false,
}: {
  embedded?: boolean; // In the Settings dialog: no Back button, and no space of a full screen.
  connections: Connection[];
  currentId: string | null; // The connection that is open now.
  connectingId: string | null;
  error: { id: string; message: string } | null;
  tokenIds: Set<string>; // Connections with a saved token.
  canReturn: boolean; // The current connection is open.
  hasSession: boolean;
  onConnect: (c: Connection) => void;
  onSave: (c: Connection, secrets: ConnectionSecrets) => Promise<void>;
  onDelete: (c: Connection) => void;
  onTest: (c: Connection, secrets: ConnectionSecrets) => Promise<HostInfo>;
  onReturn: () => void;
}) {
  const [editing, setEditing] = useState<{ connection: Connection; isNew: boolean } | null>(null);
  const confirm = useConfirm(); // Delete asks first in a dialog (rule R7).

  const startAdd = () =>
    // An SSH tunnel is the default. A normal browser cannot open SSH tunnels, so it uses a direct connection.
    setEditing({
      connection: { id: newConnectionId(), name: "", kind: isTauri() ? "ssh" : "direct", host: "", port: 8765 },
      isNew: true,
    });

  const Title = embedded ? "h2" : "h1";
  return (
    <div className={embedded ? "settings-embed" : "start-screen"}>
      <section className="panel connections" aria-labelledby="connections-title">
        <div className="panel-head">
          {/* In Settings the dialog has the h1 (audit C5). */}
          <Title id="connections-title">Computers</Title>
          {canReturn && !embedded && (
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
                  {c.kind === "direct" && isTauri() && (
                    <span className="help">A direct connection. Edit it to connect through an SSH tunnel.</span>
                  )}
                  {error?.id === c.id && (
                    <span className="field-error" role="alert">
                      {error.message}
                    </span>
                  )}
                </div>
                <div className="connection-actions">
                  {c.kind !== "local" && (
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
                          onClick={() =>
                            confirm.ask({
                              title: `Delete the connection ${c.name}?`,
                              text: "Harness forgets this computer and its saved token. The daemon on the computer does not change.",
                              confirmLabel: "Delete",
                              onConfirm: () => onDelete(c),
                            })
                          }
                          aria-label={`Delete ${c.name}`}
                          title="Delete"
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </>
                    )}
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
          onSave={async (c, secrets) => {
            await onSave(c, secrets);
            setEditing(null);
          }}
        />
      )}

      {isTauri() && <ServerDaemonPanel />}
      {confirm.dialog}
    </div>
  );
}

type ServerState =
  | { state: "stopped" }
  | { state: "busy" }
  | { state: "running"; info: ServerInfo }
  | { state: "error"; message: string };

/** "21:52" for today, else the date and the time. */
function connectedAt(since: number): string {
  const date = new Date(since);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * "Remote daemon on this computer": one button starts the daemon of this app for other computers (the
 * user asked for a button, not the steps of a manual start). While it runs, "Show token" shows the
 * token that the other computers need, "New token" replaces it, and a list shows the computers that
 * are connected now.
 */
function ServerDaemonPanel() {
  const [server, setServer] = useState<ServerState>({ state: "busy" });
  const [tokenShown, setTokenShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const acting = useRef(false); // A start, a stop, or a new token runs: the events do not change the state.
  const confirm = useConfirm();
  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | null = null;
    const refresh = () => {
      if (acting.current) return;
      serverDaemon("status").then(
        (info) => live && !acting.current && setServer(info ? { state: "running", info } : { state: "stopped" }),
        () => live && !acting.current && setServer({ state: "stopped" }),
      );
    };
    refresh();
    // A computer connects or disconnects, or "Stop remote daemon" in the tray menu.
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen(SERVER_DAEMON_EVENT, refresh).then((stop) => (live ? (unlisten = stop) : stop())),
    );
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  const run = async (action: "start" | "stop" | "new-token") => {
    acting.current = true;
    setServer({ state: "busy" });
    if (action !== "new-token") setTokenShown(false);
    try {
      const info = await serverDaemon(action);
      setServer(info ? { state: "running", info } : { state: "stopped" });
    } catch (e) {
      setServer({ state: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      acting.current = false;
    }
  };

  const askNewToken = () =>
    confirm.ask({
      title: "Make a new token?",
      text: "The daemon restarts with a new token. The computers that use the old token lose the connection, and they cannot connect again. Give the new token only to the computers that you trust.",
      confirmLabel: "Make new token",
      onConfirm: () => void run("new-token"),
    });

  const copy = (token: string) => {
    void navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const running = server.state === "running";
  return (
    <section className="panel remote-help" aria-labelledby="remote-help-title">
      <div className="server-head">
        <div className="server-head-text">
          <h2 id="remote-help-title">Remote daemon on this computer</h2>
          <p className="help">
            Let your other computers work on this computer. They connect through an SSH tunnel, so this computer needs an SSH
            server that accepts their key.
          </p>
        </div>
        <button
          type="button"
          className={`btn btn-small${running ? "" : " btn-primary"}`}
          onClick={() => void run(running ? "stop" : "start")}
          disabled={server.state === "busy"}
        >
          {server.state === "busy" ? (
            <LoaderCircle size={14} className="spin" aria-hidden />
          ) : running ? (
            <Square size={13} aria-hidden />
          ) : (
            <Play size={14} aria-hidden />
          )}
          {running ? "Stop remote daemon" : "Start remote daemon"}
        </button>
      </div>
      <div className="server-status">
        {server.state === "running" ? (
          <>
            <span className="ok" role="status">
              <Check size={14} aria-hidden /> The daemon runs on this computer, at 127.0.0.1:{server.info.port}. Other computers
              connect through an SSH tunnel. It stops when you quit Harness.
            </span>
            <div className="server-token">
              <button type="button" className="btn btn-small" onClick={() => setTokenShown((v) => !v)} aria-expanded={tokenShown}>
                <KeyRound size={14} aria-hidden />
                {tokenShown ? "Hide token" : "Show token"}
              </button>
              <button type="button" className="btn btn-small" onClick={askNewToken}>
                <RefreshCw size={14} aria-hidden />
                New token
              </button>
            </div>
            {tokenShown && (
              <span className="key-field server-token-field">
                <input className="mono" readOnly value={server.info.token} aria-label="Token" onFocus={(e) => e.target.select()} />
                <button
                  type="button"
                  className="icon-btn ghost key-field-btn"
                  onClick={() => copy(server.info.token)}
                  aria-label="Copy the token"
                  title={copied ? "Copied" : "Copy the token"}
                >
                  {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
                </button>
              </span>
            )}
            <div className="server-clients">
              <span className="server-clients-title" id="server-clients-title">
                Connected computers ({server.info.connections.length})
              </span>
              {server.info.connections.length === 0 ? (
                <span className="help">No computer is connected.</span>
              ) : (
                <ul aria-labelledby="server-clients-title">
                  {server.info.connections.map((c) => (
                    <li key={c.id}>
                      <Monitor size={14} aria-hidden />
                      <span className="server-client-name">{c.name ?? c.peer ?? "Unknown computer"}</span>
                      <span className="server-client-desc">
                        {[c.name && c.peer, c.app && `Harness ${c.app}`, `connected at ${connectedAt(c.since)}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : server.state === "error" ? (
          <span className="field-error" role="alert">
            {server.message}
          </span>
        ) : (
          <span className="help">The daemon listens on 127.0.0.1:{SERVER_DAEMON_PORT}. It stops when you quit Harness.</span>
        )}
      </div>
      {confirm.dialog}
    </section>
  );
}
