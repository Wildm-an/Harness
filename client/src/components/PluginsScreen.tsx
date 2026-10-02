import { useState } from "react";
import { FolderOpen, LoaderCircle, Puzzle, RefreshCw, RotateCw, Trash2, TriangleAlert, X } from "lucide-react";
import type { PluginBundle, PluginRow, PluginsStatus } from "../daemon/protocol";
import { Switch } from "./ProvidersScreen";

const STATE_TEXT: Record<PluginRow["state"], string> = {
  active: "On",
  disabled: "Off",
  failed: "Failed",
  idle: "Not loaded",
  pending: "Waiting",
};

/** True if the text is a git source, the same test as the daemon (plugins/install.py). */
export function isGitSource(source: string): boolean {
  const s = source.trim();
  return /^(https?:\/\/|ssh:\/\/|git@|github:)/.test(s) || s.endsWith(".git");
}

/** The row title: the id, and the module when it is not the same. */
export function rowLabel(row: PluginRow): string {
  return row.id === row.name ? row.id : `${row.id} (${row.name})`;
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

const PLACEHOLDER = "A folder, or a git URL (https://…, github:user/repo#tag)";

export function PluginsScreen({
  embedded = false,
  status,
  error,
  busy,
  hasSession,
  onInstall,
  onRemove,
  onSetBundle,
  onSetPlugin,
  onReload,
  onBrowse,
  onReturn,
}: {
  embedded?: boolean; // In the Settings dialog: no Back button, and no space of a full screen.
  status: PluginsStatus | null;
  error: string | null;
  busy: boolean;
  hasSession: boolean;
  onInstall: (source: string, replace: boolean) => void;
  onRemove: (name: string) => void;
  onSetBundle: (name: string, enabled: boolean) => void;
  onSetPlugin: (id: string, enabled: boolean) => void;
  onReload: () => void;
  onBrowse: (initial?: string) => Promise<string | null>;
  onReturn: () => void;
}) {
  const [source, setSource] = useState("");

  const install = (e: React.FormEvent) => {
    e.preventDefault();
    if (source.trim()) onInstall(source.trim(), false);
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
          Plugins add tools, / commands, skills, prompt text, hooks, MCP servers, and model providers. The plugins are in{" "}
          <code>{status?.paths.plugins ?? "~/.harness/plugins"}</code>. Plugin code runs in the daemon with your rights. Install
          only plugins that you trust.
        </p>

        <form className="plugin-install" onSubmit={install}>
          <label htmlFor="plugin-source" className="sr-only">
            A plugin folder or a git URL
          </label>
          <input
            id="plugin-source"
            className="mono"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={PLACEHOLDER}
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

        {error && (
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
          <span>Installed plugins</span>
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
          <p className="help">No plugins yet. Install a plugin folder or a git repository with a plugin.json file.</p>
        ) : (
          <ul className="connection-list plugin-list">
            {status.bundles.map((b) => (
              <BundleItem
                key={b.name + b.dir}
                bundle={b}
                busy={busy}
                onSetBundle={onSetBundle}
                onSetPlugin={onSetPlugin}
                onRemove={onRemove}
                onUpdate={(src) => onInstall(src, true)}
              />
            ))}
          </ul>
        )}
        {status && status.orphans.length > 0 && (
          <>
            <div className="list-head">
              <span>Rows of plugins that are not installed</span>
            </div>
            <ul className="plugin-rows">
              {status.orphans.map((row) => (
                <RowItem key={row.id} row={row} bundleOn onSet={onSetPlugin} />
              ))}
            </ul>
          </>
        )}

        {status && (
          <p className="help">
            Change the config of a plugin in <code>{status.paths.user_patch}</code>
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
