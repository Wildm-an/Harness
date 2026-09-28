import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Cpu,
  KeyRound,
  LoaderCircle,
  Plug,
  Plus,
  Server,
  Settings,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { KeyMode, ModelContext, ProviderFields, ProviderItem, ProviderKind, ProviderTestResult } from "../daemon/protocol";
import { contextSourceText, formatTokens } from "../lib/context";
import { isTauri } from "../lib/tauri";

/** Common OpenAI-compatible endpoints. The user can change each value. */
export const PRESETS: { label: string; name: string; base_url: string; kind: ProviderKind; needsKey: boolean }[] = [
  { label: "OpenAI", name: "openai", base_url: "https://api.openai.com/v1", kind: "openai", needsKey: true },
  { label: "OpenRouter", name: "openrouter", base_url: "https://openrouter.ai/api/v1", kind: "openai", needsKey: true },
  { label: "Ollama", name: "ollama", base_url: "http://localhost:11434/v1", kind: "ollama", needsKey: false },
  { label: "llama-server", name: "llama-server", base_url: "http://localhost:8080/v1", kind: "openai", needsKey: false },
  { label: "LM Studio", name: "lm-studio", base_url: "http://localhost:1234/v1", kind: "openai", needsKey: false },
];

type KeyTab = "keychain" | "env" | "none";

export interface ProviderSave {
  fields: ProviderFields;
  key: KeyMode;
  apiKeyEnv?: string;
  newKey: string | null; // A key that the user typed. The app keeps it in the keychain.
}

/** The key setting to send for a form. Returns an error text if the form needs a key. */
export function keyModeFor(
  tab: KeyTab,
  typed: string,
  env: string,
  current: ProviderItem["key"] | null,
): { key: KeyMode; error?: string } {
  if (tab === "keychain") {
    if (typed.trim()) return { key: "client" };
    // No new key: keep a saved key (in the keychain, or plain text in the file).
    if (current && (current.source === "client" || current.source === "file")) return { key: "keep" };
    return { key: "client", error: "Enter the API key, or select “No key”." };
  }
  if (tab === "env") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.trim())) return { key: "env", error: "Enter the name of an environment variable, for example OPENAI_API_KEY." };
    return { key: current?.source === "env" && current.env === env.trim() ? "keep" : "env" };
  }
  return { key: current?.source === "none" ? "keep" : "none" };
}

/** A one-line description of where the key comes from. */
export function keyLabel(key: ProviderItem["key"]): { text: string; warn: boolean } {
  switch (key.source) {
    case "client":
      return key.set ? { text: "Key in the keychain", warn: false } : { text: "Key not sent. Enter it again.", warn: true };
    case "env":
      return key.set ? { text: `Key from $${key.env}`, warn: false } : { text: `$${key.env} is not set on the daemon`, warn: true };
    case "file":
      return { text: "Key in plain text in providers.json", warn: true };
    default:
      return { text: "No key", warn: false };
  }
}

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={checked ? "On. Click to turn off." : "Off. Click to turn on."}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden />
    </button>
  );
}

/** The tooltip of a model in the test result: the model, and its context length with the source. */
export function modelTitle(spec: string, context: ModelContext | undefined, checked: boolean): string {
  const lines = [`Use ${spec}.`];
  if (context) {
    lines.push(`Context: ${context.length} tokens. ${contextSourceText(context.source)}`);
    if (context.warning) lines.push(context.warning);
  } else if (checked) {
    lines.push("The endpoint did not give the context length. The harness uses a default. Set context_length in providers.json.");
  }
  return lines.join("\n");
}

function ModelList({ result, provider, onUse }: { result: ProviderTestResult; provider: string; onUse: (spec: string) => void }) {
  const [filter, setFilter] = useState("");
  const models = result.models ?? [];
  const shown = models.filter((m) => m.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 80);
  return (
    <div className="provider-models">
      {models.length > 8 && (
        <>
          <label htmlFor="pf-filter" className="sr-only">
            Filter the models
          </label>
          <input id="pf-filter" className="mono" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter the models" spellCheck={false} />
        </>
      )}
      <ul aria-label="Models of the endpoint">
        {shown.map((m) => {
          const context = result.contexts?.[m];
          const checked = result.contexts !== undefined; // An older daemon does not check the context.
          return (
            <li key={m}>
              <button
                type="button"
                className="model-chip mono"
                onClick={() => onUse(`${provider}/${m}`)}
                title={modelTitle(`${provider}/${m}`, context, checked)}
              >
                {m}
                {context ? (
                  <span className={`model-ctx${context.warning ? " warn" : ""}`}>
                    {context.warning && <TriangleAlert size={11} aria-hidden />}
                    {formatTokens(context.length)}
                  </span>
                ) : (
                  checked && <span className="model-ctx unknown">?</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {models.length > shown.length && <p className="help">{models.length - shown.length} more. Type to filter.</p>}
      {result.contexts !== undefined && (
        <p className="help">
          The number after each model is its context length in tokens. A <span className="mono">?</span> means that the
          endpoint did not give it. Hover over a model to see where the number came from.
        </p>
      )}
      <p className="help">Click a model to select it. Save the provider first.</p>
    </div>
  );
}

function ProviderForm({
  initial,
  names,
  test,
  busy,
  error,
  onSave,
  onCancel,
  onDelete,
  onTest,
  onUse,
}: {
  initial: ProviderItem | null; // null: a new provider.
  names: string[];
  test: ProviderTestResult | "busy" | null;
  busy: boolean;
  error: string | null;
  onSave: (save: ProviderSave) => void;
  onCancel: () => void;
  onDelete: (name: string) => void;
  onTest: (fields: ProviderFields, newKey: string | null) => void;
  onUse: (spec: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [kind, setKind] = useState<ProviderKind>(initial?.kind ?? "auto");
  const [context, setContext] = useState(initial?.context_length ? String(initial.context_length) : "");
  const [ssh, setSsh] = useState(initial?.ssh ?? "");
  const [tab, setTab] = useState<KeyTab>(
    !initial ? "keychain" : initial.key.source === "env" ? "env" : initial.key.source === "none" ? "none" : "keychain",
  );
  const [typedKey, setTypedKey] = useState("");
  const [env, setEnv] = useState(initial?.key.env ?? "");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [advanced, setAdvanced] = useState(!!(initial?.context_length || initial?.ssh));

  const fields = (): ProviderFields => ({
    name: name.trim(),
    base_url: baseUrl.trim(),
    kind,
    context_length: context.trim() ? Number(context) : null,
    ssh: ssh.trim() || null,
    ...(initial ? { previous_name: initial.name } : {}),
  });

  const check = (withKey: boolean) => {
    const found: Record<string, string> = {};
    const n = name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/.test(n)) found.name = "Use letters, digits, “.”, “_”, or “-”. Start with a letter or a digit.";
    else if (n !== initial?.name && names.includes(n)) found.name = "A provider with this name exists.";
    if (!/^https?:\/\/[^\s/]+/.test(baseUrl.trim())) found.url = "Enter a URL that starts with http:// or https://.";
    if (context.trim() && !(Number(context) > 0 && Number.isInteger(Number(context)))) found.context = "Enter a positive whole number.";
    if (withKey) {
      const mode = keyModeFor(tab, typedKey, env, initial?.key ?? null);
      if (mode.error) found.key = mode.error;
    }
    setProblems(found);
    return Object.keys(found).length === 0;
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!check(true)) return;
    const mode = keyModeFor(tab, typedKey, env, initial?.key ?? null);
    onSave({ fields: fields(), key: mode.key, apiKeyEnv: tab === "env" ? env.trim() : undefined, newKey: tab === "keychain" && typedKey.trim() ? typedKey.trim() : null });
  };

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    if (!name.trim() || PRESETS.some((x) => x.name === name.trim())) setName(p.name);
    setBaseUrl(p.base_url);
    setKind(p.kind);
    setTab(p.needsKey ? "keychain" : "none");
  };

  const describedBy = (field: string) => (problems[field] ? `pf-${field}-error` : undefined);
  const fieldError = (field: string) =>
    problems[field] && (
      <p id={`pf-${field}-error`} className="field-error" role="alert">
        {problems[field]}
      </p>
    );
  const hasClientKey = initial?.key.source === "client";
  const plainText = initial?.key.source === "file";

  return (
    <form className="panel connection-form provider-form" onSubmit={submit} noValidate autoComplete="off">
      <h2 className="form-title">{initial ? `Edit ${initial.name}` : "Add a provider"}</h2>

      {!initial && (
        <div className="field">
          <span className="field-label" id="pf-preset-label">
            Start from
          </span>
          <div className="preset-row" role="group" aria-labelledby="pf-preset-label">
            {PRESETS.map((p) => (
              <button key={p.name} type="button" className="btn btn-small" onClick={() => applyPreset(p)} aria-pressed={baseUrl === p.base_url}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="pf-url">URL</label>
        <input
          id="pf-url"
          className="mono"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.openai.com/v1"
          spellCheck={false}
          aria-invalid={!!problems.url}
          aria-describedby={describedBy("url") ?? "pf-url-help"}
        />
        {fieldError("url") || (
          <p id="pf-url-help" className="help">
            The OpenAI-compatible API address, usually with <code>/v1</code> at the end. The daemon connects to it, so
            <code> localhost</code> is the daemon computer.
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor="pf-name">Name</label>
        <input
          id="pf-name"
          className="mono"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="openai"
          spellCheck={false}
          aria-invalid={!!problems.name}
          aria-describedby={describedBy("name") ?? "pf-name-help"}
        />
        {fieldError("name") || (
          <p id="pf-name-help" className="help">
            Models of this provider are <code>{name.trim() || "name"}/model</code>.
          </p>
        )}
      </div>

      <div className="field">
        <span className="field-label" id="pf-kind-label">
          Server type
        </span>
        <div className="segmented wide" role="radiogroup" aria-labelledby="pf-kind-label">
          {(["auto", "openai", "ollama"] as ProviderKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "auto" ? "Auto" : k === "openai" ? "OpenAI-compatible" : "Ollama"}
            </button>
          ))}
        </div>
        <p className="help">For Ollama, the daemon also reads the context length and the tool support of each model.</p>
      </div>

      <div className="field">
        <span className="field-label" id="pf-key-label">
          API key
        </span>
        <div className="segmented wide" role="radiogroup" aria-labelledby="pf-key-label">
          {(
            [
              ["keychain", "Keychain"],
              ["env", "Environment variable"],
              ["none", "No key"],
            ] as [KeyTab, string][]
          ).map(([t, label]) => (
            <button key={t} type="button" role="radio" aria-checked={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        {tab === "keychain" && (
          <>
            {plainText && (
              <p className="notice-inline warn">
                <TriangleAlert size={14} aria-hidden /> The key is in plain text in providers.json. Enter it here to move it
                to the keychain.
              </p>
            )}
            <label htmlFor="pf-key" className="sr-only">
              API key
            </label>
            <input
              id="pf-key"
              className="mono"
              type="password"
              autoComplete="off"
              value={typedKey}
              onChange={(e) => setTypedKey(e.target.value)}
              placeholder={hasClientKey || plainText ? "Leave empty to keep the saved key" : "sk-..."}
              aria-invalid={!!problems.key}
              aria-describedby={describedBy("key") ?? "pf-key-help"}
            />
            {fieldError("key") || (
              <p id="pf-key-help" className="help">
                {isTauri()
                  ? "The app keeps the key in the keychain of this computer. It sends the key to the daemon when it connects. The daemon keeps it in memory only."
                  : "Without the desktop app, the key is kept only until this tab closes."}
              </p>
            )}
          </>
        )}
        {tab === "env" && (
          <>
            <label htmlFor="pf-env" className="sr-only">
              Environment variable
            </label>
            <input
              id="pf-env"
              className="mono"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder="OPENAI_API_KEY"
              spellCheck={false}
              aria-invalid={!!problems.key}
              aria-describedby={describedBy("key") ?? "pf-env-help"}
            />
            {fieldError("key") || (
              <p id="pf-env-help" className="help">
                The daemon reads the key from this variable on its own computer.
              </p>
            )}
          </>
        )}
        {tab === "none" && <p className="help">For a local server with no key, for example Ollama or llama-server.</p>}
      </div>

      <button type="button" className="link-btn" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
        {advanced ? "Hide the advanced settings" : "Show the advanced settings"}
      </button>
      {advanced && (
        <div className="field-grid provider-advanced">
          <div className="field">
            <label htmlFor="pf-ssh">SSH host</label>
            <input
              id="pf-ssh"
              className="mono"
              value={ssh}
              onChange={(e) => setSsh(e.target.value)}
              placeholder="user@gpu-box"
              spellCheck={false}
              aria-describedby="pf-ssh-help"
            />
            <p id="pf-ssh-help" className="help">
              Optional. The daemon opens an SSH tunnel. The URL is then the address on that host.
            </p>
          </div>
          <div className="field">
            <label htmlFor="pf-context">Context length</label>
            <input
              id="pf-context"
              className="mono"
              inputMode="numeric"
              value={context}
              onChange={(e) => setContext(e.target.value.replace(/\D/g, ""))}
              placeholder="auto"
              aria-invalid={!!problems.context}
              aria-describedby={describedBy("context")}
            />
            {fieldError("context")}
          </div>
        </div>
      )}

      <div className="test-result" role="status">
        {test === "busy" && (
          <span>
            <LoaderCircle size={14} className="spin" aria-hidden /> Testing the connection.
          </span>
        )}
        {test && test !== "busy" && test.ok && (
          <span className="ok">
            <Check size={14} aria-hidden /> Connected in {test.ms} ms. {test.models?.length ?? 0}{" "}
            {test.models?.length === 1 ? "model" : "models"}
            {test.truncated ? " (the list is cut)" : ""}.
          </span>
        )}
        {test && test !== "busy" && !test.ok && (
          <span className="bad">
            <TriangleAlert size={14} aria-hidden /> {test.error}
          </span>
        )}
      </div>
      {test && test !== "busy" && test.ok && (test.models?.length ?? 0) > 0 && <ModelList result={test} provider={name.trim()} onUse={onUse} />}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="btn"
          onClick={() => check(false) && onTest(fields(), tab === "keychain" && typedKey.trim() ? typedKey.trim() : null)}
          disabled={test === "busy" || busy}
        >
          <Plug size={14} aria-hidden />
          Test
        </button>
        {initial &&
          (confirmDelete ? (
            <>
              <button type="button" className="btn btn-danger btn-small" onClick={() => onDelete(initial.name)} disabled={busy}>
                <Trash2 size={14} aria-hidden />
                Delete {initial.name}
              </button>
              <button type="button" className="icon-btn ghost" onClick={() => setConfirmDelete(false)} aria-label="Keep the provider" title="Keep">
                <X size={14} aria-hidden />
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
              <Trash2 size={14} aria-hidden />
              Delete
            </button>
          ))}
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy && <LoaderCircle size={14} className="spin" aria-hidden />}
          Save
        </button>
      </div>
    </form>
  );
}

/** A connection test: running, or its result. ``ref`` names the form that started it. */
export type ProviderTest = { ref: string; busy: true } | (ProviderTestResult & { busy?: false });

export function ProvidersScreen({
  items,
  path,
  host,
  error,
  test,
  hasSession,
  onSave,
  onDelete,
  onEnable,
  onTest,
  onUse,
  onReturn,
}: {
  items: ProviderItem[] | null; // null: loading.
  path: string;
  host: string | null; // The daemon computer.
  error: string | null; // An error for the list, for example a switch that failed.
  test: ProviderTest | null;
  hasSession: boolean;
  onSave: (save: ProviderSave) => Promise<void>; // Resolves when the daemon saved the provider.
  onDelete: (name: string) => Promise<void>;
  onEnable: (name: string, enabled: boolean) => void;
  onTest: (fields: ProviderFields, newKey: string | null, ref: string) => void;
  onUse: (spec: string) => void;
  onReturn: () => void;
}) {
  const [editing, setEditing] = useState<{ item: ProviderItem | null; key: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const names = useMemo(() => (items ?? []).map((i) => i.name), [items]);
  const formRef = editing ? `form-${editing.key}` : "";
  const formTest = test && test.ref === formRef ? (test.busy ? "busy" : test) : null;

  // Close the form if its provider was deleted, for example from another client.
  useEffect(() => {
    if (editing?.item && items && !items.some((i) => i.name === editing.item!.name) && !busy) setEditing(null);
  }, [items]);

  const edit = (item: ProviderItem | null) => {
    setFormError(null);
    setEditing((e) => ({ item, key: (e?.key ?? 0) + 1 }));
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFormError(null);
    try {
      await action();
      setEditing(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="start-screen">
      <section className="panel connections providers" aria-labelledby="providers-title">
        <div className="panel-head">
          <h1 id="providers-title">Connections</h1>
          <button type="button" className="btn btn-ghost" onClick={onReturn}>
            {hasSession ? "Back to the session" : "Back"}
          </button>
        </div>
        <p className="help providers-intro">
          The model endpoints of the daemon{host ? <> on <span className="mono">{host}</span></> : null}. They are in{" "}
          <code>{path || "~/.harness/providers.json"}</code>.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="list-head">
          <span>OpenAI-compatible connections</span>
          <button type="button" className="icon-btn ghost" onClick={() => edit(null)} aria-label="Add a provider" title="Add a provider">
            <Plus size={16} aria-hidden />
          </button>
        </div>
        {items === null ? (
          <p className="pane-empty">
            <LoaderCircle size={16} className="spin" aria-hidden /> Loading the providers.
          </p>
        ) : (
          <ul className="connection-list provider-list">
            {items.map((item) => {
              const key = keyLabel(item.key);
              const Icon = item.kind_resolved === "ollama" ? Server : Cpu;
              return (
                <li key={item.name} className={`connection provider-row${item.enabled ? "" : " off"}`}>
                  <Icon size={18} aria-hidden className="connection-icon" />
                  <div className="connection-text">
                    <span className="connection-name">
                      {item.name}
                      {!item.enabled && <span className="badge">Off</span>}
                    </span>
                    <span className="connection-desc mono" title={item.base_url}>
                      {item.base_url}
                      {item.ssh ? `  via SSH ${item.ssh}` : ""}
                    </span>
                    <span className={`provider-key${key.warn ? " warn" : ""}`}>
                      {key.warn ? <TriangleAlert size={12} aria-hidden /> : <KeyRound size={12} aria-hidden />}
                      {key.text}
                    </span>
                  </div>
                  <div className="connection-actions">
                    <button type="button" className="icon-btn ghost" onClick={() => edit(item)} aria-label={`Settings of ${item.name}`} title="Settings">
                      <Settings size={16} aria-hidden />
                    </button>
                    <Switch checked={item.enabled} label={`${item.name} is on`} onChange={(next) => onEnable(item.name, next)} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {!editing && (
          <button type="button" className="btn btn-wide add-connection" onClick={() => edit(null)}>
            <Plus size={15} aria-hidden />
            Add a provider
          </button>
        )}
      </section>

      {editing && (
        <ProviderForm
          key={editing.key}
          initial={editing.item}
          names={names}
          test={formTest}
          busy={busy}
          error={formError}
          onCancel={() => setEditing(null)}
          onSave={(save) => void run(() => onSave(save))}
          onDelete={(name) => void run(() => onDelete(name))}
          onTest={(fields, newKey) => onTest(fields, newKey, formRef)}
          onUse={onUse}
        />
      )}
    </div>
  );
}
