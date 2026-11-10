// Settings > Operating Harness: the harness that runs the agent loop of new sessions. "Harness" is the
// built-in loop (daemon agent.py). The other harnesses connect through ACP, the Agent Client Protocol
// (daemon acp.py). The list comes from the daemon (acp_harnesses.py): the ACP registry, and the custom
// harnesses of the user. "Download" and "Update" get a harness from the ACP registry (daemon acp_install.py).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpCircle, Check, Download, ExternalLink, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { DaemonConnection } from "../daemon/connection";
import type { HarnessItem, HarnessProgress, UserSettings } from "../daemon/protocol";
import { openLink } from "../lib/openLink";
import { ConfirmDialog } from "./ConfirmDialog";

export const BUILTIN_HARNESS = "harness";

const STATUS_TEXT: Record<HarnessItem["status"], string> = {
  downloaded: "Downloaded",
  installed: "Installed",
  npx: "Runs with npx",
  uvx: "Runs with uvx",
  missing: "Not installed",
};

/** The id of the operating harness in the user settings. No value is the built-in loop. */
export function currentHarness(values: UserSettings | null): string {
  return values?.operating_harness || BUILTIN_HARNESS;
}

/** The harnesses that match the filter: each word is in the name, the description, or the command. */
export function filterHarnesses(items: HarnessItem[], filter: string): HarnessItem[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((h) => {
    const text = `${h.name} ${h.description} ${h.command}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The order of the list: the built-in loop is not in it. The custom harnesses come last. */
export function sortHarnesses(items: HarnessItem[]): HarnessItem[] {
  return [...items].sort((a, b) => Number(a.custom) - Number(b.custom) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** The Recommended group (in the order of the daemon), and the other harnesses (sorted). */
export function splitHarnesses(items: HarnessItem[]): { recommended: HarnessItem[]; others: HarnessItem[] } {
  const recommended = items.filter((h) => h.recommended !== null).sort((a, b) => (a.recommended ?? 0) - (b.recommended ?? 0));
  return { recommended, others: sortHarnesses(items.filter((h) => h.recommended === null)) };
}

/** The download button of a harness row: "busy" (a download runs), "update", "download", or null. A harness
 * on the PATH gets no "Download": the user installed it. */
export function harnessAction(h: HarnessItem, progress?: HarnessProgress | null): "busy" | "update" | "download" | null {
  if (progress || h.busy) return "busy";
  if (h.download) return h.update ? "update" : null;
  return h.can_download && h.status !== "installed" ? "download" : null;
}

/** The choices of the Model menu of a harness: the models of each provider, by provider. A saved model
 * that the list does not have (its provider is off or does not answer) stays as a choice. */
export function modelGroups(models: { provider: string; model: string }[], current: string | null): { provider: string; values: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const values = groups.get(m.provider) ?? [];
    values.push(`${m.provider}/${m.model}`);
    groups.set(m.provider, values);
  }
  if (current && ![...groups.values()].some((v) => v.includes(current))) {
    const provider = current.split("/")[0];
    groups.set(provider, [current, ...(groups.get(provider) ?? [])]);
  }
  return [...groups].map(([provider, values]) => ({ provider, values }));
}

/** The text of a running download: the percent when the size is known, else the stage. */
export function progressText(p: HarnessProgress): string {
  if (p.stage === "Downloading" && p.total > 0) return `Downloading ${Math.min(100, Math.floor((p.received / p.total) * 100))}%`;
  return `${p.stage}…`;
}

interface Draft {
  id: string | null; // null: a new harness.
  name: string;
  command: string;
}

export function OperatingHarnessSettings({ conn, connected, values, error, onSet }: {
  conn: DaemonConnection;
  connected: boolean;
  values: UserSettings | null;
  error: string | null; // The error of the last setting change.
  onSet: (values: Partial<UserSettings>) => void;
}) {
  const [items, setItems] = useState<HarnessItem[] | null>(null);
  const [path, setPath] = useState("");
  const [filter, setFilter] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [listFailed, setListFailed] = useState(false); // The list request failed: no skeleton rows, and "Try again".
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirm, setConfirm] = useState<HarnessItem | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<HarnessItem | null>(null);
  // The running downloads (harnesses.progress), by harness id. The list replaces them when it comes.
  const [progress, setProgress] = useState<Record<string, HarnessProgress>>({});
  // The models of the Harness providers (models.list), for the Model menu. null: not loaded yet.
  const [models, setModels] = useState<{ provider: string; model: string }[] | null>(null);
  const [checking, setChecking] = useState(false);
  const saving = useRef(false); // A save was sent: the next list closes the form.
  const current = currentHarness(values);

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "harnesses") {
          setItems(msg.items);
          setPath(msg.path);
          setChecking(false);
          setListFailed(false);
          setProgress({});
          if (saving.current) {
            saving.current = false;
            setDraft(null);
          }
        } else if (msg.type === "models") {
          setModels(msg.items);
        } else if (msg.type === "harnesses.progress") {
          const { stage, received, total } = msg;
          setProgress((p) => ({ ...p, [msg.id]: { stage, received, total } }));
        } else if (msg.type === "error" && msg.ref?.startsWith("harnesses.")) {
          saving.current = false;
          setChecking(false);
          setProblem(msg.message);
          if (msg.ref === "harnesses.list") setListFailed(true);
        }
      }),
    [conn],
  );

  const send = (msg: Parameters<DaemonConnection["send"]>[0]) => {
    setProblem(null);
    try {
      conn.send(msg);
    } catch (e) {
      setChecking(false);
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (connected) {
      send({ type: "harnesses.list" });
      send({ type: "models.list" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send uses only the connection.
  }, [conn, connected]);

  // With no filter, the Recommended group comes first. A filter shows one list of all the harnesses.
  const groups = useMemo(() => splitHarnesses(items ?? []), [items]);
  const shown = useMemo(() => filterHarnesses(sortHarnesses(items ?? []), filter), [items, filter]);
  const filtering = filter.trim() !== "";
  const sections: { label: string | null; list: HarnessItem[] }[] = filtering
    ? [{ label: null, list: shown }]
    : [
        { label: "Recommended", list: groups.recommended },
        { label: "More harnesses", list: groups.others },
      ];
  const choose = (id: string) => {
    if (id === current) return;
    onSet({ operating_harness: id === BUILTIN_HARNESS ? null : id });
  };
  const selected = current === BUILTIN_HARNESS ? null : items?.find((h) => h.id === current) ?? null;

  const download = (h: HarnessItem) => {
    setProgress((p) => ({ ...p, [h.id]: { stage: "Starting", received: 0, total: 0 } }));
    send({ type: "harnesses.install", id: h.id });
  };

  const saveDraft = () => {
    if (!draft) return;
    if (!draft.name.trim()) return setProblem("Give a name.");
    if (!draft.command.trim()) return setProblem("Give the command that starts the harness in ACP mode.");
    saving.current = true;
    send({ type: "harnesses.save", name: draft.name.trim(), command: draft.command.trim(), ...(draft.id ? { id: draft.id } : {}) });
  };

  return (
    <div className="settings-page harness-page">
      <div className="settings-page-head">
        <h2 className="settings-page-title">Operating Harness</h2>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-small"
          disabled={!connected || checking}
          onClick={() => {
            setChecking(true);
            send({ type: "harnesses.list", refresh: true });
          }}
          title="Look for the installed programs and the updates again"
        >
          <RefreshCw size={14} aria-hidden /> Check again
        </button>
      </div>
      <p className="setting-help harness-intro">
        The operating harness runs the agent loop: the model, the tools, and the context. Harness uses its own loop by
        default. Another harness connects through the Agent Client Protocol (ACP), and Harness shows its work in the
        chat. Applies to new sessions.
      </p>
      {!connected && <p className="settings-note setting-help">Connect to a computer to choose the harness.</p>}
      {(error || problem) && (
        <p className="settings-note harness-error" role="alert">
          {problem ?? error}
        </p>
      )}
      {selected && (
        <p className="settings-note setting-help">
          New sessions run in {selected.name}.{" "}
          {selected.provider_model
            ? `It uses the model ${selected.provider_model} of your providers.`
            : "It uses its own model settings."}{" "}
          The model menu of a session shows the models of {selected.name}.
        </p>
      )}
      {selected?.provider_models && (
        <div className="setting-row harness-model-row">
          <div className="setting-text">
            <label htmlFor="harness-model">Model</label>
            <span className="setting-help">
              Use a model of your providers in {selected.name}, or the model settings of {selected.name}. Applies to new
              sessions.{selected.provider_note ? ` ${selected.provider_note}` : ""}
            </span>
          </div>
          <div className="setting-control">
            <select
              id="harness-model"
              value={selected.provider_model ?? ""}
              disabled={!connected}
              onChange={(e) => send({ type: "harnesses.model", id: selected.id, model: e.target.value || null })}
            >
              <option value="">{selected.name} settings</option>
              {modelGroups(models ?? [], selected.provider_model).map((g) => (
                <optgroup key={g.provider} label={g.provider}>
                  {g.values.map((v) => (
                    <option key={v} value={v}>
                      {v.slice(g.provider.length + 1)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="harness-list" role="radiogroup" aria-label="Operating harness">
        <HarnessRow
          id={BUILTIN_HARNESS}
          name="Harness"
          description="The built-in agent loop, with your providers, local models, and all Harness tools."
          badge="Built in"
          command={null}
          checked={current === BUILTIN_HARNESS}
          disabled={!connected}
          onChoose={choose}
        />
      </div>

      <div className="harness-tools">
        <h3 className="settings-section">ACP harnesses{items ? ` · ${items.length}` : ""}</h3>
        <span className="spacer" />
        <input
          type="search"
          className="setting-text-input"
          placeholder="Filter"
          aria-label="Filter the harnesses"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {items === null && listFailed ? (
        <p className="harness-empty">
          Couldn't load the list of harnesses.{" "}
          <button
            type="button"
            className="btn btn-small"
            disabled={!connected}
            onClick={() => {
              setListFailed(false);
              setProblem(null);
              send({ type: "harnesses.list" });
            }}
          >
            <RefreshCw size={13} aria-hidden /> Try again
          </button>
        </p>
      ) : items === null ? (
        connected && (
          <div className="harness-list" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="harness-row harness-skeleton" />
            ))}
          </div>
        )
      ) : (
        sections.map(({ label, list }) => (
          <div key={label ?? "all"} className="harness-group">
            {label && list.length > 0 && <h4 className="harness-group-title">{label}</h4>}
            <div className="harness-list" role="radiogroup" aria-label={label ?? "ACP harnesses"}>
              {filtering && list.length === 0 && <p className="setting-help harness-empty">No harness matches the filter.</p>}
              {list.map((h) => (
                <HarnessRow
                  key={h.id}
                  id={h.id}
                  name={h.name}
                  description={h.reason || h.description}
                  localModels={h.local_models}
                  badge={STATUS_TEXT[h.status]}
                  badgeTitle={h.detail}
                  ready={h.status !== "missing"}
                  command={h.command}
                  license={h.license}
                  version={h.download ? h.download.version : undefined}
                  model={h.provider_model ?? undefined}
                  website={h.website}
                  checked={current === h.id}
                  disabled={!connected}
                  onChoose={choose}
                  actions={
                    <>
                      <DownloadControl
                        item={h}
                        progress={progress[h.id] ?? h.busy}
                        disabled={!connected}
                        onDownload={() => download(h)}
                        onRemove={() => setConfirmRemove(h)}
                      />
                      {h.custom && (
                        <>
                          <button type="button" className="icon-btn ghost" aria-label={`Edit ${h.name}`} title="Edit" onClick={() => setDraft({ id: h.id, name: h.name, command: h.command })}>
                            <Pencil size={14} aria-hidden />
                          </button>
                          <button type="button" className="icon-btn ghost" aria-label={`Delete ${h.name}`} title="Delete" onClick={() => setConfirm(h)}>
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          </div>
        ))
      )}

      <h3 className="settings-section">Custom harness</h3>
      {draft ? (
        <div className="setting-block harness-form">
          <label className="harness-field">
            <span className="setting-label">Name</span>
            <input className="setting-text-input" value={draft.name} maxLength={60} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="harness-field">
            <span className="setting-label">Command</span>
            <input
              className="setting-text-input mono"
              value={draft.command}
              placeholder="omp --mode acp"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && saveDraft()}
            />
            <span className="setting-help">The command that starts the harness in ACP mode on the daemon computer.</span>
          </label>
          <div className="harness-form-actions">
            <button type="button" className="btn btn-small" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-small btn-primary" disabled={!connected} onClick={saveDraft}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-label">Add a harness that is not in the list</span>
            <span className="setting-help">
              Give a name and the command that starts it in ACP mode.{path ? ` Saved in ${path}.` : ""}
            </span>
          </div>
          <div className="setting-control">
            <button type="button" className="btn btn-small" disabled={!connected} onClick={() => setDraft({ id: null, name: "", command: "" })}>
              <Plus size={14} aria-hidden /> Add custom harness
            </button>
          </div>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={`Delete ${confirm.name}?`}
          confirmLabel="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            send({ type: "harnesses.delete", id: confirm.id });
            setConfirm(null);
          }}
        >
          The harness goes from the list. Its sessions stay, but they cannot run until you add it again.
          {confirm.id === current && " New sessions use the built-in loop of Harness."}
        </ConfirmDialog>
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={`Delete the download of ${confirmRemove.name}?`}
          confirmLabel="Delete"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            send({ type: "harnesses.uninstall", id: confirmRemove.id });
            setConfirmRemove(null);
          }}
        >
          Harness deletes the files that it downloaded. The harness stays in the list, and you can download it again.
        </ConfirmDialog>
      )}
    </div>
  );
}

/** "Download", "Update", or the progress of a running download, and "Delete the download". */
function DownloadControl({ item, progress, disabled, onDownload, onRemove }: {
  item: HarnessItem;
  progress: HarnessProgress | null;
  disabled: boolean;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const action = harnessAction(item, progress);
  const version = item.latest ? ` ${item.latest}` : "";
  return (
    <>
      {action === "busy" && progress && (
        <span className="harness-progress" role="status" aria-live="polite">
          <LoaderCircle size={13} className="spin" aria-hidden /> {progressText(progress)}
        </span>
      )}
      {action === "download" && (
        <button type="button" className="btn btn-small harness-download" disabled={disabled} title={`Download ${item.name}${version}`} onClick={onDownload}>
          <Download size={14} aria-hidden /> Download
        </button>
      )}
      {action === "update" && (
        <button type="button" className="btn btn-small harness-download" disabled={disabled} title={`Update ${item.name} to version ${item.latest}`} onClick={onDownload}>
          <ArrowUpCircle size={14} aria-hidden /> Update
        </button>
      )}
      {item.download && action !== "busy" && (
        <button type="button" className="icon-btn ghost" disabled={disabled} aria-label={`Delete the download of ${item.name}`} title="Delete the download" onClick={onRemove}>
          <Trash2 size={14} aria-hidden />
        </button>
      )}
    </>
  );
}

function HarnessRow({ id, name, description, localModels = false, badge, badgeTitle, ready = true, command, license, version, model, website, checked, disabled, onChoose, actions }: {
  id: string;
  name: string;
  description: string;
  localModels?: boolean;
  badge: string;
  badgeTitle?: string;
  ready?: boolean;
  command: string | null;
  license?: string;
  version?: string; // The version of the download.
  model?: string; // The model of a Harness provider.
  website?: string;
  checked: boolean;
  disabled: boolean;
  onChoose: (id: string) => void;
  actions?: ReactNode;
}) {
  return (
    <div className={`harness-row${checked ? " checked" : ""}`}>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        className="harness-choice"
        disabled={disabled}
        onClick={() => onChoose(id)}
      >
        <span className="harness-radio" aria-hidden>
          {checked && <Check size={12} />}
        </span>
        <span className="harness-text">
          <span className="harness-name">
            {name}
            <span className={`harness-badge${ready ? " ready" : ""}`} title={badgeTitle}>
              {badge}
            </span>
            {localModels && (
              <span className="harness-badge" title="It can use a local model server, for example the llama-server of the Local models page.">
                Local models
              </span>
            )}
          </span>
          <span className="setting-help">{description}</span>
          {command && (
            <span className="harness-meta">
              <code>{command}</code>
              {version && <span>Version {version}</span>}
              {model && <span>Model {model}</span>}
              {license && <span>{license}</span>}
            </span>
          )}
        </span>
      </button>
      <span className="harness-actions">
        {actions}
        {website && (
          <button type="button" className="icon-btn ghost" aria-label={`Open the website of ${name}`} title={website} onClick={() => openLink(website)}>
            <ExternalLink size={14} aria-hidden />
          </button>
        )}
      </span>
    </div>
  );
}
