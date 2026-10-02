import { useState } from "react";
import { FolderOpen, LoaderCircle, Puzzle, RefreshCw, RotateCw, ShieldAlert, Trash2, TriangleAlert, X } from "lucide-react";
import type { DshBundle, DshRow, PluginBundle, PluginKind, PluginRow, PluginsStatus } from "../daemon/protocol";
import { Switch } from "./ProvidersScreen";

const STATE_TEXT: Record<PluginRow["state"], string> = {
  active: "On",
  disabled: "Off",
  failed: "Failed",
  idle: "Not loaded",
  pending: "Waiting",
};

/**
 * A DeepSeek install that waits for the user: build scripts to approve (keys), or the mirror registry
 * to use because the npm registry cannot be reached (mirror). useMirror: the install uses the mirror.
 */
export interface PendingInstall {
  source: string;
  keys: string[];
  mirror?: string;
  useMirror: boolean;
}

/** The options of an install that the user approved. */
export interface InstallOptions {
  approvedBuilds?: string[];
  useMirror?: boolean;
}

/** True if the text is a git source, the same test as the daemon (plugins/install.py). */
export function isGitSource(source: string): boolean {
  const s = source.trim();
  return /^(https?:\/\/|ssh:\/\/|git@|github:)/.test(s) || s.endsWith(".git");
}

/** The row title: the id, and the module when it is not the same. */
export function rowLabel(row: PluginRow): string {
  return row.id === row.name ? row.id : `${row.id} (${row.name})`;
}

/** A row of a DeepSeek bundle in the shape of a Harness row, for the shared list. */
export function dshRow(row: DshRow, bundle: string): PluginRow {
  return {
    id: row.id,
    name: row.name,
    bundle,
    state: row.state === "disposed" ? "disabled" : row.state,
    error: row.error,
    disabled: row.disabled,
    config: null,
    layer: "",
    overrides: [],
    inject: [],
    provide: [],
    tools: [],
    commands: [],
  };
}

/** A DeepSeek bundle in the shape of a Harness bundle, for the shared list. */
export function dshBundle(bundle: DshBundle): PluginBundle {
  const problems = [bundle.problem, bundle.client ? "The bundle has a UI half. Harness does not load plugin UI yet." : null];
  return {
    name: bundle.name,
    dir: bundle.dir,
    enabled: bundle.enabled,
    source: null,
    problem: problems.filter(Boolean).join(" ") || null,
    version: bundle.version ?? undefined,
    description: bundle.description,
    icon: bundle.icon ?? null,
    rows: bundle.rows.map((r) => dshRow(r, bundle.name)),
  };
}

function RowItem({ row, bundleOn, onSet }: { row: PluginRow; bundleOn: boolean; onSet: (id: string, enabled: boolean) => void }) {
  const parts = [
    row.tools.length ? `Tools: ${row.tools.join(", ")}` : null,
    row.commands.length ? `Commands: ${row.commands.map((c) => `/${c}`).join(", ")}` : null,
    row.provide.length ? `Provides: ${row.provide.join(", ")}` : null,
  ].filter(Boolean);
  const from = row.overrides.length ? `Changed in: ${row.overrides.join(", ")}` : null;
  return (
    <li className={`plugin-row state-${row.state}`}>
      <div className="plugin-row-text">
        <span className="plugin-row-name">
          <span className="mono">{rowLabel(row)}</span>
          <span className={`badge plugin-state ${row.state}`}>{STATE_TEXT[row.state]}</span>
        </span>
        {parts.length > 0 && <span className="help">{parts.join(" · ")}</span>}
        {from && <span className="help">{from}</span>}
        {row.error && (
          <span className={row.state === "pending" ? "plugin-warn" : "plugin-error"} role="alert">
            <TriangleAlert size={12} aria-hidden /> {row.error}
          </span>
        )}
      </div>
      <Switch checked={!row.disabled && bundleOn} label={`The plugin ${row.id} is on`} onChange={(next) => onSet(row.id, next)} />
    </li>
  );
}

function BundleItem({
  bundle,
  busy,
  onSetBundle,
  onSetPlugin,
  onRemove,
  onUpdate,
}: {
  bundle: PluginBundle;
  busy: boolean;
  onSetBundle: (name: string, enabled: boolean) => void;
  onSetPlugin: (id: string, enabled: boolean) => void;
  onRemove: (name: string) => void;
  onUpdate: (source: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <li className={`connection plugin-bundle${bundle.enabled ? "" : " off"}`}>
      {bundle.icon ? (
        <img className="connection-icon plugin-icon" src={bundle.icon} alt="" width={18} height={18} />
      ) : (
        <Puzzle size={18} aria-hidden className="connection-icon" />
      )}
      <div className="connection-text">
        <span className="connection-name">
          {bundle.name}
          {bundle.version && <span className="badge mono">{bundle.version}</span>}
          {!bundle.enabled && <span className="badge">Off</span>}
        </span>
        {bundle.description && <span className="plugin-desc">{bundle.description}</span>}
        {bundle.source && (
          <span className="connection-desc mono" title={bundle.source}>
            {bundle.source}
          </span>
        )}
        {bundle.problem && (
          <span className="plugin-error" role="alert">
            <TriangleAlert size={12} aria-hidden /> {bundle.problem}
          </span>
        )}
        {bundle.rows.length > 0 && (
          <ul className="plugin-rows" aria-label={`The plugins of ${bundle.name}`}>
            {bundle.rows.map((row) => (
              <RowItem key={row.id} row={row} bundleOn={bundle.enabled} onSet={onSetPlugin} />
            ))}
          </ul>
        )}
      </div>
      <div className="connection-actions">
        {confirm ? (
          <>
            <button type="button" className="btn btn-danger btn-small" onClick={() => onRemove(bundle.name)} disabled={busy}>
              Remove
            </button>
            <button type="button" className="icon-btn ghost" onClick={() => setConfirm(false)} aria-label="Keep the plugin" title="Keep">
              <X size={16} aria-hidden />
            </button>
          </>
        ) : (
          <>
            {bundle.source && (
              <button
                type="button"
                className="icon-btn ghost"
                onClick={() => onUpdate(bundle.source!)}
                disabled={busy}
                aria-label={`Update ${bundle.name}`}
                title="Install again from the source"
              >
                <RotateCw size={16} aria-hidden />
              </button>
            )}
            <button type="button" className="icon-btn ghost" onClick={() => setConfirm(true)} disabled={busy} aria-label={`Remove ${bundle.name}`} title="Remove">
              <Trash2 size={16} aria-hidden />
            </button>
            <Switch checked={bundle.enabled} label={`${bundle.name} is on`} onChange={(next) => onSetBundle(bundle.name, next)} />
          </>
        )}
      </div>
    </li>
  );
}

const PLACEHOLDER: Record<PluginKind, string> = {
  harness: "A folder, or a git URL (https://…, github:user/repo#tag)",
  deepseek: "An npm name (dsh-plugin-guide), a git URL, a folder, or a .tgz file",
};

export function PluginsScreen({
  embedded = false,
  status,
  error,
  busy,
  pendingInstall,
  hasSession,
  onInstall,
  onRemove,
  onSetBundle,
  onSetPlugin,
  onReload,
  onBrowse,
  onDismissPending,
  onReturn,
}: {
  embedded?: boolean; // In the Settings dialog: no Back button, and no space of a full screen.
  status: PluginsStatus | null;
  error: string | null;
  busy: boolean;
  pendingInstall: PendingInstall | null;
  hasSession: boolean;
  onInstall: (source: string, replace: boolean, kind: PluginKind, options?: InstallOptions) => void;
  onRemove: (name: string, kind: PluginKind) => void;
  onSetBundle: (name: string, enabled: boolean, kind: PluginKind) => void;
  onSetPlugin: (id: string, enabled: boolean, kind: PluginKind) => void;
  onReload: () => void;
  onBrowse: (initial?: string) => Promise<string | null>;
  onDismissPending: () => void;
  onReturn: () => void;
}) {
  const [source, setSource] = useState("");
  const [kind, setKind] = useState<PluginKind>("harness");
  const deepseek = status?.deepseek;

  const install = (e: React.FormEvent) => {
    e.preventDefault();
    if (source.trim()) onInstall(source.trim(), false, kind);
  };
  const browse = async () => {
    const picked = await onBrowse(source.trim() && !isGitSource(source) ? source.trim() : undefined);
    if (picked) setSource(picked);
  };

  return (
    <div className={embedded ? "settings-embed plugins-screen" : "start-screen plugins-screen"}>
      <section className="panel connections plugins" aria-labelledby="plugins-title">
        <div className="panel-head">
          <h1 id="plugins-title">
            <Puzzle size={20} aria-hidden /> Plugins
          </h1>
          <span className="spacer" />
          {!embedded && (
            <button type="button" className="btn btn-ghost" onClick={onReturn}>
              {hasSession ? "Back to the session" : "Back"}
            </button>
          )}
        </div>
        <p className="help providers-intro">
          Plugins add tools, / commands, skills, prompt text, hooks, MCP servers, and model providers. Harness plugins are in{" "}
          <code>{status?.paths.plugins ?? "~/.harness/plugins"}</code>. DeepSeek Harness plugins are in{" "}
          <code>{deepseek?.home ?? "~/.harness/dsh"}</code>. Plugin code runs in the daemon with your rights. Install only
          plugins that you trust.
        </p>

        <form className="plugin-install" onSubmit={install}>
          <div className="segmented" role="radiogroup" aria-label="Plugin kind">
            {(["harness", "deepseek"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} disabled={busy}>
                {k === "harness" ? "Harness" : "DeepSeek"}
              </button>
            ))}
          </div>
          <label htmlFor="plugin-source" className="sr-only">
            {kind === "harness" ? "A plugin folder or a git URL" : "An npm name, a git URL, a folder, or a .tgz file"}
          </label>
          <input
            id="plugin-source"
            className="mono"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={PLACEHOLDER[kind]}
            spellCheck={false}
            disabled={busy}
          />
          <button type="button" className="icon-btn ghost" onClick={() => void browse()} disabled={busy} aria-label="Select a folder" title="Select a folder">
            <FolderOpen size={16} aria-hidden />
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !source.trim()}>
            {busy && <LoaderCircle size={14} className="spin" aria-hidden />}
            Install
          </button>
        </form>

        {pendingInstall?.mirror && (
          <div className="notice-bar warn plugin-builds" role="alert">
            <ShieldAlert size={14} aria-hidden />
            <div>
              <p>
                The npm registry cannot be reached. You can install from the mirror registry instead. A third party runs the
                mirror, and it gets the name of the package.
              </p>
              <ul className="mono">
                <li>{pendingInstall.mirror}</li>
              </ul>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost btn-small" onClick={onDismissPending} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={() => onInstall(pendingInstall.source, false, "deepseek", { useMirror: true })}
                  disabled={busy}
                >
                  Use the mirror and install
                </button>
              </div>
            </div>
          </div>
        )}
        {pendingInstall && pendingInstall.keys.length > 0 && (
          <div className="notice-bar warn plugin-builds" role="alert">
            <ShieldAlert size={14} aria-hidden />
            <div>
              <p>
                The install needs to run the build scripts of these packages. The scripts run on the daemon computer with your
                rights.
              </p>
              <ul className="mono">
                {pendingInstall.keys.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost btn-small" onClick={onDismissPending} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={() =>
                    onInstall(pendingInstall.source, false, "deepseek", { approvedBuilds: pendingInstall.keys, useMirror: pendingInstall.useMirror })
                  }
                  disabled={busy}
                >
                  Allow the scripts and install
                </button>
              </div>
            </div>
          </div>
        )}
        {error && !pendingInstall && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {status && !status.loaded && (
          <p className="help">No session is open. The list shows the installed plugins. Their code runs when a session starts.</p>
        )}
        {status?.warnings.map((w) => (
          <p key={w} className="notice-bar warn">
            <TriangleAlert size={14} aria-hidden /> {w}
          </p>
        ))}

        <div className="list-head">
          <span>Harness plugins</span>
          {status?.loaded && (
            <button type="button" className="icon-btn ghost" onClick={onReload} disabled={busy} aria-label="Load the plugins again" title="Load the plugins again, after a change to a plugin file">
              <RefreshCw size={16} aria-hidden />
            </button>
          )}
        </div>
        {status === null ? (
          <p className="pane-empty">
            <LoaderCircle size={16} className="spin" aria-hidden /> Loading the plugins.
          </p>
        ) : status.bundles.length === 0 ? (
          <p className="help">No Harness plugins yet. Install a plugin folder or a git repository with a plugin.json file.</p>
        ) : (
          <ul className="connection-list plugin-list">
            {status.bundles.map((b) => (
              <BundleItem
                key={b.name + b.dir}
                bundle={b}
                busy={busy}
                onSetBundle={(name, on) => onSetBundle(name, on, "harness")}
                onSetPlugin={(id, on) => onSetPlugin(id, on, "harness")}
                onRemove={(name) => onRemove(name, "harness")}
                onUpdate={(src) => onInstall(src, true, "harness")}
              />
            ))}
          </ul>
        )}
        {status && status.orphans.length > 0 && (
          <>
            <div className="list-head">
              <span>Rows of Harness plugins that are not installed</span>
            </div>
            <ul className="plugin-rows">
              {status.orphans.map((row) => (
                <RowItem key={row.id} row={row} bundleOn onSet={(id, on) => onSetPlugin(id, on, "harness")} />
              ))}
            </ul>
          </>
        )}

        <div className="list-head">
          <span>DeepSeek Harness plugins{deepseek?.runtime ? ` · runtime ${deepseek.runtime}` : ""}</span>
        </div>
        {deepseek && !deepseek.available ? (
          <p className="notice-bar warn">
            <TriangleAlert size={14} aria-hidden /> {deepseek.reason}
          </p>
        ) : deepseek?.error ? (
          <p className="form-error" role="alert">
            {deepseek.error}
          </p>
        ) : !deepseek || deepseek.bundles.length === 0 ? (
          <p className="help">No DeepSeek Harness plugins yet. Select "DeepSeek" above, and install a bundle by its npm name.</p>
        ) : (
          <ul className="connection-list plugin-list">
            {deepseek.bundles.map((b) => (
              <BundleItem
                key={b.name}
                bundle={dshBundle(b)}
                busy={busy}
                onSetBundle={(name, on) => onSetBundle(name, on, "deepseek")}
                onSetPlugin={(id, on) => onSetPlugin(id, on, "deepseek")}
                onRemove={(name) => onRemove(name, "deepseek")}
                onUpdate={() => undefined}
              />
            ))}
          </ul>
        )}
        {deepseek?.warnings.map((w) => (
          <p key={w} className="notice-bar warn">
            <TriangleAlert size={14} aria-hidden /> {w}
          </p>
        ))}
        {deepseek && deepseek.bundles.length > 0 && (
          <p className="help">
            A DeepSeek tool needs your approval for each call, as an MCP tool does. Change the config of a DeepSeek plugin in{" "}
            <code>{deepseek.user_patch ?? "~/.harness/dsh/cordis.patch.yml"}</code>.
          </p>
        )}

        {status && (
          <p className="help">
            Change the config of a Harness plugin in <code>{status.paths.user_patch}</code>
            {status.paths.project_patch ? (
              <>
                {" "}
                or, for this project only, in <code>{status.paths.project_patch}</code>
              </>
            ) : null}
            .
          </p>
        )}
      </section>
    </div>
  );
}
