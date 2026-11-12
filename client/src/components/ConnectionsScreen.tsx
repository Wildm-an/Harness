import { useEffect, useRef, useState } from "react";
import { Check, Copy, Globe, KeyRound, LoaderCircle, Monitor, Pencil, Play, Plug, Plus, RefreshCw, Square, Trash2, TriangleAlert } from "lucide-react";
import { SecretInput } from "./SecretInput";
import type { HostInfo } from "../daemon/protocol";
import { describe, loadToken, newConnectionId, validate, type Connection, type ConnectionKind } from "../lib/connections";
import { isTauri, SERVER_DAEMON_EVENT, SERVER_DAEMON_PORT, serverDaemon, tailscaleAddress, type ServerInfo } from "../lib/tauri";
import { loadPref, savePref } from "../lib/prefs";
import { Switch } from "./Switch";
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
  onSave: (c: Connection, token: string) => Promise<void>;
  onDelete: (c: Connection) => void;
  onTest: (c: Connection, token: string) => Promise<HostInfo>;
  onReturn: () => void;
}) {
  const [editing, setEditing] = useState<{ connection: Connection; isNew: boolean } | null>(null);
  const confirm = useConfirm(); // Delete asks first in a dialog (rule R7).

  const startAdd = () =>
    setEditing({ connection: { id: newConnectionId(), name: "", kind: "direct", host: "", port: 8765 }, isNew: true });

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
            <div className="server-command">
              <pre className="tool-pre">python -m harness_daemon --port {SERVER_DAEMON_PORT}</pre>
              {isTauri() && <ServerDaemonControl />}
            </div>
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
      {confirm.dialog}
    </div>
  );
}

type ServerState =
  | { state: "stopped" }
  | { state: "busy" }
  | { state: "running"; info: ServerInfo }
  | { state: "error"; message: string };

const TAILSCALE_PREF = "serverDaemon.tailscale";

/** "127.0.0.1 (SSH tunnel) and 100.64.0.5 (Tailscale)". */
function listenText(hosts: string[], tailscaleIp: string | null): string {
  return hosts
    .map((h) => (h === "127.0.0.1" ? "127.0.0.1 (SSH tunnel)" : h === tailscaleIp ? `${h} (Tailscale)` : h))
    .join(" and ");
}

/** "21:52" for today, else the date and the time. */
function connectedAt(since: number): string {
  const date = new Date(since);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The play button of the start command: it starts the daemon of this app on this computer, for other
 * computers. While it runs, "Show token" shows the token that the other computers need, "New token"
 * replaces it, and a list shows the computers that are connected now.
 */
function ServerDaemonControl() {
  const [server, setServer] = useState<ServerState>({ state: "busy" });
  const [tokenShown, setTokenShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const acting = useRef(false); // A start, a stop, or a new token runs: the events do not change the state.
  const confirm = useConfirm();
  // Also listen on the Tailscale address, so other computers of the tailnet can connect directly.
  const [tailscaleIp, setTailscaleIp] = useState<string | null>(null);
  const [useTailscale, setUseTailscale] = useState(() => loadPref(TAILSCALE_PREF, "1") === "1");

  useEffect(() => {
    let live = true;
    void tailscaleAddress().then((ip) => live && setTailscaleIp(ip));
    return () => {
      live = false;
    };
  }, []);

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
      // A new token keeps the addresses of the daemon that runs.
      const tailscale =
        action === "new-token" && server.state === "running" ? server.info.hosts.length > 1 : useTailscale && !!tailscaleIp;
      const info = await serverDaemon(action, tailscale);
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
    <>
      <button
        type="button"
        className="icon-btn ghost server-command-btn"
        onClick={() => void run(running ? "stop" : "start")}
        disabled={server.state === "busy"}
        aria-label={running ? "Stop remote daemon" : "Start the daemon on this computer"}
        title={running ? "Stop remote daemon" : "Start on this computer"}
      >
        {server.state === "busy" ? (
          <LoaderCircle size={14} className="spin" aria-hidden />
        ) : running ? (
          <Square size={13} aria-hidden />
        ) : (
          <Play size={14} aria-hidden />
        )}
      </button>
      <div className="server-status">
        {server.state === "running" ? (
          <>
            <span className="ok" role="status">
              <Check size={14} aria-hidden /> The daemon runs on this computer, on port {server.info.port}, at{" "}
              {listenText(server.info.hosts, tailscaleIp)}. It stops when you quit Harness.
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
          <span className="help">The play button starts the daemon of this app on this computer. It stops when you quit Harness.</span>
        )}
        {tailscaleIp && (
          <div className="server-tailscale">
            <Switch
              checked={running ? server.info.hosts.includes(tailscaleIp) : useTailscale}
              label="Also listen on Tailscale"
              disabled={server.state !== "stopped" && server.state !== "error"}
              onChange={(on) => {
                setUseTailscale(on);
                savePref(TAILSCALE_PREF, on ? "1" : "0");
              }}
            />
            <span>
              Also listen on Tailscale (<span className="mono">{tailscaleIp}</span>)
              <span className="help">
                {running
                  ? " Stop the daemon to change this."
                  : " Other computers connect to this address. Windows can ask to let the daemon through the firewall: allow it."}
              </span>
            </span>
          </div>
        )}
      </div>
      {confirm.dialog}
    </>
  );
}
