// Settings > Agents, as the Providers settings of T3 Code (the user asked for this): a list of the agents at the
// left, and the detail of the selected agent at the right. An agent runs the agent loop of new sessions.
// "Harness" is the built-in loop (daemon agent.py). The other agents connect through ACP, the Agent Client
// Protocol (daemon acp.py). The list comes from the daemon (acp_harnesses.py): the ACP registry, and the custom
// agents of the user. "Download" and "Update" get an agent from the ACP registry (daemon acp_install.py). The
// sign-in state and the usage of a subscription come from daemon agent_auth.py.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpCircle, Download, ExternalLink, LoaderCircle, LogIn, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { DaemonConnection } from "../daemon/connection";
import type { AgentProgram, ClientMessage, HarnessItem, HarnessProgress, UserSettings } from "../daemon/protocol";
import { openLink } from "../lib/openLink";
import { formatDateTime, formatTime } from "../lib/timeFormat";
import { AgentIcon, BUILTIN_AGENT, UsageBars, agentStatus, type AgentTone } from "./AgentBits";
import { AgentSignInTerminal } from "./AgentSignInTerminal";
import { BackLink } from "./BackLink";
import { ConfirmDialog } from "./ConfirmDialog";
import { Switch } from "./Switch";
import { impliedModel, listedModels } from "./AgentPicker";

const STATUS_TEXT: Record<HarnessItem["status"], string> = {
  downloaded: "Downloaded",
  installed: "Installed",
  npx: "Runs with npx",
  uvx: "Runs with uvx",
  missing: "Not installed",
};

const BUILTIN_DESCRIPTION = "The built-in agent loop, with your providers, local models, and all Harness tools.";

/** The id of the operating harness in the user settings. No value is the built-in loop. */
export function currentHarness(values: UserSettings | null): string {
  return values?.operating_harness || BUILTIN_AGENT;
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

/** The ACP agents in the left list: the enabled agents, sorted. The selected agent stays in the list after
 * its switch goes off, so the row does not go away under the pointer. */
export function listedAgents(items: HarnessItem[], selected: string | null = null): HarnessItem[] {
  return sortHarnesses(items.filter((h) => h.enabled || h.id === selected));
}

/** An agent with an update: a newer version of the Harness download, or of the program that the user installed. */
export function agentHasUpdate(h: Pick<HarnessItem, "download" | "update" | "program">): boolean {
  return (!!h.download && h.update) || !!h.program?.update;
}

/** The agents for "Update all": a Harness download with a newer version, and no download that runs now. */
export function downloadUpdates(items: HarnessItem[], progress: Record<string, HarnessProgress> = {}): HarnessItem[] {
  return items.filter((h) => h.download && h.update && !h.busy && !progress[h.id]);
}

/** The enabled agents with an update: the dot on "Agents" in the Settings nav. */
export function agentUpdateCount(items: HarnessItem[] | null): number {
  return (items ?? []).filter((h) => h.enabled && agentHasUpdate(h)).length;
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

type ModelItem = Pick<HarnessItem, "id" | "name" | "models" | "native_model" | "provider_models" | "provider_model">;

/** The Model select of an agent: its own models ("native:<id>"), then the models of the providers
 * ("provider:<provider>/<model>"). The value "" is the default. null: the agent has no model choice. */
/** The choices of "Auto mode model": the models of each provider. A saved model that the list does not have stays. */
export function autoModelGroups(models: { provider: string; model: string }[], current: string | null): { provider: string; values: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), `${m.provider}/${m.model}`]);
  if (current && ![...groups.values()].some((v) => v.includes(current))) {
    const provider = current.slice(0, Math.max(0, current.indexOf("/")));
    groups.set(provider, [current, ...(groups.get(provider) ?? [])]);
  }
  return [...groups].map(([provider, values]) => ({ provider, values }));
}

export function modelChoices(
  item: ModelItem,
  providerModels: { provider: string; model: string }[],
): { value: string; defaultLabel: string | null; groups: { label: string; options: { value: string; label: string }[] }[] } | null {
  // As the picker (and T3 Code): the models that the agent gives, with no "Default" (the user asked for this), and
  // the Harness providers first. With no choice, the model that new sessions use is selected.
  const listed = listedModels(item.models);
  const own = listed.length > 0 || item.native_model !== null;
  if (!own && !item.provider_models) return null;
  const groups: { label: string; options: { value: string; label: string }[] }[] = [];
  if (item.provider_models) {
    for (const g of modelGroups(providerModels, item.provider_model)) {
      groups.push({ label: g.provider, options: g.values.map((v) => ({ value: `provider:${v}`, label: v.slice(g.provider.length + 1) })) });
    }
  }
  if (own) {
    const options = listed.map((m) => ({ value: `native:${m.id}`, label: m.name || m.id }));
    // A saved model that the agent did not give in its last session stays as a choice.
    if (item.native_model && !listed.some((m) => m.id === item.native_model)) {
      options.unshift({ value: `native:${item.native_model}`, label: item.native_model });
    }
    groups.push({ label: item.name, options });
  }
  const implied = impliedModel(item.models);
  const value =
    item.provider_models && item.provider_model
      ? `provider:${item.provider_model}`
      : item.native_model
        ? `native:${item.native_model}`
        : implied
          ? `native:${implied}`
          : "";
  // "{name} settings" only while the agent gave no models: then the agent uses its own settings.
  const defaultLabel = listed.length ? null : `${item.name} settings`;
  return { value, defaultLabel, groups };
}

/** The messages for a choice of the Model select. Only one model applies: a provider model clears the own
 * model of the agent, and the other way. */
export function modelChange(item: ModelItem, value: string): ClientMessage[] {
  const id = item.id;
  if (value.startsWith("provider:")) {
    const msgs: ClientMessage[] = [{ type: "harnesses.model", id, model: value.slice("provider:".length) }];
    if (item.native_model) msgs.push({ type: "harnesses.native_model", id, model: null });
    return msgs;
  }
  if (value.startsWith("native:")) {
    const msgs: ClientMessage[] = [{ type: "harnesses.native_model", id, model: value.slice("native:".length) }];
    if (item.provider_model) msgs.push({ type: "harnesses.model", id, model: null });
    return msgs;
  }
  const msgs: ClientMessage[] = [];
  if (item.provider_models) msgs.push({ type: "harnesses.model", id, model: null });
  if (item.models.length > 0 || item.native_model) msgs.push({ type: "harnesses.native_model", id, model: null });
  return msgs;
}

/** "Checked 3:20 PM" today, else "Checked Nov 20, 7:00 PM". */
export function checkedText(seconds: number, now = new Date()): string {
  if (!seconds) return "";
  const at = new Date(seconds * 1000);
  return at.toDateString() === now.toDateString() ? `Checked ${formatTime(at)}` : `Checked ${formatDateTime(at)}`;
}

interface Draft {
  id: string | null; // null: a new agent.
  name: string;
  command: string;
}

export function AgentsSettings({ conn, connected, values, error, onSet, onShowProviders }: {
  conn: DaemonConnection;
  connected: boolean;
  values: UserSettings | null;
  error: string | null; // The error of the last setting change.
  onSet: (values: Partial<UserSettings>) => void;
  onShowProviders?: () => void; // Opens Settings > Providers. No value: no "Show providers" button.
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
  // The model of Auto mode for the agents of other harnesses (auto_mode.model). null: none, so Auto mode asks.
  const [autoModel, setAutoModel] = useState<string | null>(null);
  const [checking, setChecking] = useState(false); // "Check again" of the page runs.
  const current = currentHarness(values);
  const [selected, setSelected] = useState<string>(current);
  const [adding, setAdding] = useState(false); // The right pane shows "Add agent".
  const [signingIn, setSigningIn] = useState<string | null>(null); // The agent with the sign-in terminal.
  const [authBusy, setAuthBusy] = useState<string | null>(null); // The agent whose sign-in state Harness reads again.
  const [updatingProgram, setUpdatingProgram] = useState<string | null>(null); // The agent with the update terminal.
  const [programBusy, setProgramBusy] = useState<string | null>(null); // The agent whose version Harness reads again.
  const chose = useRef(false); // The user selected a row. Before that, the selection follows the setting.
  const saving = useRef(false); // A save was sent: the next list closes the form.
  const enableNew = useRef<string | null>(null); // The name of a new custom agent: the next list enables it.
  const signingRef = useRef<string | null>(null);
  signingRef.current = signingIn;

  const send = (msg: ClientMessage) => {
    setProblem(null);
    try {
      conn.send(msg);
    } catch (e) {
      setChecking(false);
      setAuthBusy(null);
      setProblem(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(
    () =>
      conn.onMessage((msg) => {
        if (msg.type === "harnesses") {
          setItems(msg.items);
          setAutoModel(msg.auto_model ?? null);
          setPath(msg.path);
          setChecking(false);
          setListFailed(false);
          setProgress({});
          // The list after a sign-in has the new state. "Checking the sign-in…" ends.
          if (!signingRef.current) setAuthBusy(null);
          setProgramBusy(null);
          if (saving.current) {
            saving.current = false;
            setDraft(null);
          }
          const name = enableNew.current;
          if (name) {
            enableNew.current = null;
            const added = msg.items.find((h) => h.custom && h.name === name);
            if (added) {
              chose.current = true;
              setSelected(added.id);
              setAdding(false);
              if (!added.enabled) send({ type: "agents.enable", id: added.id, enabled: true });
            }
          }
        } else if (msg.type === "models") {
          setModels(msg.items);
        } else if (msg.type === "harnesses.progress") {
          const { stage, received, total } = msg;
          setProgress((p) => ({ ...p, [msg.id]: { stage, received, total } }));
        } else if (msg.type === "error" && (msg.ref?.startsWith("harnesses.") || msg.ref?.startsWith("agents."))) {
          saving.current = false;
          enableNew.current = null;
          setChecking(false);
          setAuthBusy(null);
          setProgramBusy(null);
          setProblem(msg.message);
          if (msg.ref === "harnesses.list") setListFailed(true);
          if (msg.ref === "agents.signin") setSigningIn(null); // The sign-in did not start.
          if (msg.ref === "agents.update_program") setUpdatingProgram(null); // The update did not start.
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send uses only the connection.
    [conn],
  );

  useEffect(() => {
    if (connected) {
      send({ type: "harnesses.list" });
      send({ type: "models.list" });
    } else {
      setSigningIn(null);
      setUpdatingProgram(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- send uses only the connection.
  }, [conn, connected]);

  // The settings load after the page opens: the operating harness is selected first.
  useEffect(() => {
    if (!chose.current) setSelected(current);
  }, [current]);

  // With no filter, the Recommended group comes first. A filter shows one list of all the agents.
  const groups = useMemo(() => splitHarnesses(items ?? []), [items]);
  const shown = useMemo(() => filterHarnesses(sortHarnesses(items ?? []), filter), [items, filter]);
  const listed = useMemo(() => listedAgents(items ?? [], selected), [items, selected]);
  const filtering = filter.trim() !== "";
  const sections: { label: string | null; list: HarnessItem[] }[] = filtering
    ? [{ label: null, list: shown }]
    : [
        { label: "Recommended", list: groups.recommended },
        { label: "More agents", list: groups.others },
      ];
  const item = selected === BUILTIN_AGENT ? null : items?.find((h) => h.id === selected) ?? null;

  const select = (id: string) => {
    chose.current = true;
    setSelected(id);
    setAdding(false);
    if (draft?.id && draft.id !== id) setDraft(null);
  };
  const useForNew = (id: string) => {
    if (id === current) return;
    onSet({ operating_harness: id === BUILTIN_AGENT ? null : id });
    const h = items?.find((x) => x.id === id);
    if (h && !h.enabled) send({ type: "agents.enable", id, enabled: true });
  };
  const enable = (h: HarnessItem, on: boolean) => send({ type: "agents.enable", id: h.id, enabled: on });
  const download = (h: HarnessItem) => {
    setProgress((p) => ({ ...p, [h.id]: { stage: "Starting", received: 0, total: 0 } }));
    send({ type: "harnesses.install", id: h.id });
  };
  const checkAuth = (h: HarnessItem) => {
    setAuthBusy(h.id);
    send({ type: "agents.check", id: h.id });
  };
  const checkProgram = (h: HarnessItem) => {
    setProgramBusy(h.id);
    send({ type: "agents.check", id: h.id });
  };
  const updates = downloadUpdates(items ?? [], progress);
  const updateAll = () => {
    setProgress((p) => ({ ...p, ...Object.fromEntries(updates.map((h) => [h.id, { stage: "Waiting", received: 0, total: 0 }])) }));
    send({ type: "harnesses.update_all" });
  };
  const saveDraft = () => {
    if (!draft) return;
    if (!draft.name.trim()) return setProblem("Give a name.");
    if (!draft.command.trim()) return setProblem("Give the command that starts the agent in ACP mode.");
    saving.current = true;
    if (!draft.id) enableNew.current = draft.name.trim();
    send({ type: "harnesses.save", name: draft.name.trim(), command: draft.command.trim(), ...(draft.id ? { id: draft.id } : {}) });
  };

  const draftForm = (
    <div className="setting-block harness-form">
      <label className="harness-field">
        <span className="setting-label">Name</span>
        <input className="setting-text-input" value={draft?.name ?? ""} maxLength={60} autoFocus onChange={(e) => draft && setDraft({ ...draft, name: e.target.value })} />
      </label>
      <label className="harness-field">
        <span className="setting-label">Command</span>
        <input
          className="setting-text-input mono"
          value={draft?.command ?? ""}
          placeholder="omp --mode acp"
          spellCheck={false}
          onChange={(e) => draft && setDraft({ ...draft, command: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && saveDraft()}
        />
        <span className="setting-help">The command that starts the agent in ACP mode on the daemon computer.</span>
      </label>
      <div className="harness-form-actions">
        <button type="button" className="btn btn-small" data-form-cancel onClick={() => setDraft(null)}>
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" disabled={!connected} onClick={saveDraft}>
          Save
        </button>
      </div>
    </div>
  );

  const listProblem = (
    <p className="harness-empty">
      Couldn't load the list of agents.{" "}
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
  );

  const customButtons = (h: HarnessItem) =>
    h.custom && (
      <>
        <button type="button" className="icon-btn ghost" aria-label={`Edit ${h.name}`} title="Edit" onClick={() => setDraft({ id: h.id, name: h.name, command: h.command })}>
          <Pencil size={14} aria-hidden />
        </button>
        <button type="button" className="icon-btn ghost" aria-label={`Delete ${h.name}`} title="Delete" onClick={() => setConfirm(h)}>
          <Trash2 size={14} aria-hidden />
        </button>
      </>
    );

  const websiteButton = (name: string, website: string) =>
    website && (
      <button type="button" className="icon-btn ghost" aria-label={`Open the website of ${name}`} title={website} onClick={() => openLink(website)}>
        <ExternalLink size={14} aria-hidden />
      </button>
    );

  return (
    <div className="settings-page agents-page">
      <div className="settings-page-head">
        <h2 className="settings-page-title">Agents</h2>
        <span className="spacer" />
        {updates.length > 0 && (
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={!connected}
            onClick={updateAll}
            title={`Download the new version of ${updates.map((h) => h.name).join(", ")}`}
          >
            <ArrowUpCircle size={14} aria-hidden /> Update all ({updates.length})
          </button>
        )}
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
        An agent runs the agent loop: the model, the tools, and the context. Harness is the built-in agent. Other agents
        connect through the Agent Client Protocol (ACP), and Harness shows their work in the chat. Applies to new sessions.
      </p>
      <div className="setting-row agents-auto-model">
        <div className="setting-text">
          <label htmlFor="agents-auto-model">Auto mode model</label>
          <span className="setting-help">
            In Auto mode, this model checks the actions of the other agents, as it does for Harness: their own model
            is not in Harness. With no model, Auto mode asks you for each action that needs a permission.
          </span>
        </div>
        <div className="setting-control">
          <select
            id="agents-auto-model"
            value={autoModel ?? ""}
            disabled={!connected}
            onChange={(e) => send({ type: "agents.auto_model", model: e.target.value || null })}
          >
            <option value="">None: ask me</option>
            {autoModelGroups(models ?? [], autoModel).map((g) => (
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
      <div className="setting-row agents-auto-update">
        <div className="setting-text">
          <span className="setting-label">Update agents automatically</span>
          <span className="setting-help">
            Harness downloads the new version of each enabled agent that it downloaded, when one comes out. An agent that
            you installed yourself updates with its own command: see Updates in its pane.
          </span>
        </div>
        <div className="setting-control">
          <Switch
            checked={values?.agents_auto_update === true}
            label="Update agents automatically"
            disabled={!connected || values === null}
            onChange={(on) => onSet({ agents_auto_update: on })}
          />
        </div>
      </div>
      {!connected && <p className="settings-note setting-help">Connect to a computer to choose the agent.</p>}
      {(error || problem) && (
        <p className="settings-note harness-error" role="alert">
          {problem ?? error}
        </p>
      )}

      <div className="agents-panes">
        <nav className="agents-list" aria-label="Agents">
          <AgentRow
            id={BUILTIN_AGENT}
            name="Harness"
            tone="ok"
            headline="Built in"
            isDefault={current === BUILTIN_AGENT}
            selected={!adding && selected === BUILTIN_AGENT}
            onSelect={() => select(BUILTIN_AGENT)}
          />
          {items === null && listFailed
            ? listProblem
            : items === null
              ? connected && (
                  <div aria-busy="true" aria-label="Loading the agents">
                    {[0, 1].map((i) => (
                      <div key={i} className="agents-row-skeleton" />
                    ))}
                  </div>
                )
              : listed.map((h) => {
                  const status = agentStatus(h);
                  return (
                    <AgentRow
                      key={h.id}
                      id={h.id}
                      name={h.name}
                      icon={h.icon}
                      version={h.download?.version ?? h.program?.version ?? undefined}
                      update={agentHasUpdate(h)}
                      tone={status.tone}
                      headline={status.headline}
                      isDefault={current === h.id}
                      selected={!adding && selected === h.id}
                      onSelect={() => select(h.id)}
                      enabled={h.enabled}
                      disabled={!connected}
                      onEnable={(on) => enable(h, on)}
                    />
                  );
                })}
          <button type="button" className={`agents-add-row${adding ? " selected" : ""}`} aria-current={adding || undefined} disabled={!connected} onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden /> Add agent
          </button>
        </nav>

        <section className="agents-detail" aria-label={adding ? "Add agent" : item?.name ?? "Harness"}>
          {adding ? (
            <>
              <BackLink to="Agents" onClick={() => setAdding(false)} />
              <div className="harness-tools">
                <h3 className="settings-section">Add agent{items ? ` · ${items.length}` : ""}</h3>
                <span className="spacer" />
                <input
                  type="search"
                  className="setting-text-input"
                  placeholder="Filter"
                  aria-label="Filter the agents"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              {items === null && listFailed ? (
                listProblem
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
                    <div className="harness-list" aria-label={label ?? "Agents"}>
                      {filtering && list.length === 0 && <p className="setting-help harness-empty">No agent matches the filter.</p>}
                      {list.map((h) => (
                        <div key={h.id} className="harness-row agents-add-item">
                          <AgentIcon id={h.id} name={h.name} icon={h.icon} size={20} />
                          <span className="harness-text">
                            <span className="harness-name">
                              {h.name}
                              <span className={`harness-badge${h.status !== "missing" ? " ready" : ""}`} title={h.detail}>
                                {STATUS_TEXT[h.status]}
                              </span>
                              {h.local_models && (
                                <span className="harness-badge" title="It can use a local model server, for example the llama-server of the Local models page.">
                                  Local models
                                </span>
                              )}
                            </span>
                            <span className="setting-help">{h.reason || h.description}</span>
                            <span className="harness-meta">
                              <code>{h.command}</code>
                              {h.download && <span>Version {h.download.version}</span>}
                              {h.license && <span>{h.license}</span>}
                            </span>
                          </span>
                          <span className="harness-actions">
                            <DownloadControl
                              item={h}
                              progress={progress[h.id] ?? h.busy}
                              disabled={!connected}
                              onDownload={() => download(h)}
                              onRemove={() => setConfirmRemove(h)}
                            />
                            {customButtons(h)}
                            {websiteButton(h.name, h.website)}
                            {h.enabled ? (
                              <button type="button" className="btn btn-small" title={`${h.name} is in the list`} onClick={() => select(h.id)}>
                                Show
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-small btn-primary"
                                disabled={!connected}
                                title={`Show ${h.name} in the list and in the agent picker`}
                                onClick={() => {
                                  send({ type: "agents.enable", id: h.id, enabled: true });
                                  select(h.id);
                                }}
                              >
                                Add
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
              {draft?.id && items?.some((h) => h.id === draft.id) && (
                <>
                  <h3 className="settings-section">Edit {items.find((h) => h.id === draft.id)?.name}</h3>
                  {draftForm}
                </>
              )}

              <h3 className="settings-section">Custom agent</h3>
              {draft && !draft.id ? (
                draftForm
              ) : (
                <div className="setting-row">
                  <div className="setting-text">
                    <span className="setting-label">Add an agent that is not in the list</span>
                    <span className="setting-help">Give a name and the command that starts it in ACP mode.{path ? ` Saved in ${path}.` : ""}</span>
                  </div>
                  <div className="setting-control">
                    <button type="button" className="btn btn-small" disabled={!connected} onClick={() => setDraft({ id: null, name: "", command: "" })}>
                      <Plus size={14} aria-hidden /> Add custom agent
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : selected === BUILTIN_AGENT || !item ? (
            <>
              <div className="agents-detail-head">
                <AgentIcon id={BUILTIN_AGENT} name="Harness" size={24} />
                <h3 className="agents-detail-title">Harness</h3>
                <span className="harness-badge ready">Built in</span>
              </div>
              <p className="setting-help">{BUILTIN_DESCRIPTION}</p>
              <h4 className="agents-section-title">Status</h4>
              <StatusLine tone="ok" headline="Available" />
              <h4 className="agents-section-title">Model</h4>
              <div className="agents-inline">
                <span className="setting-help">Harness uses the models of your providers and your local models. The model menu of a session chooses the model.</span>
                {onShowProviders && (
                  <button type="button" className="btn btn-small" onClick={onShowProviders}>
                    Show providers
                  </button>
                )}
              </div>
              <UseForNew isDefault={current === BUILTIN_AGENT} disabled={!connected} onUse={() => useForNew(BUILTIN_AGENT)} />
            </>
          ) : (
            <AgentDetail
              key={item.id}
              item={item}
              conn={conn}
              connected={connected}
              isDefault={current === item.id}
              providerModels={models ?? []}
              progress={progress[item.id] ?? item.busy}
              signingIn={signingIn === item.id}
              authBusy={authBusy === item.id}
              editForm={draft?.id === item.id ? draftForm : null}
              customButtons={customButtons(item)}
              websiteButton={websiteButton(item.name, item.website)}
              onSend={send}
              onUse={() => useForNew(item.id)}
              onDownload={() => download(item)}
              onRemoveDownload={() => setConfirmRemove(item)}
              onSignIn={() => {
                setProblem(null);
                setSigningIn(item.id);
              }}
              onCancelSignIn={() => send({ type: "agents.signin.cancel", id: item.id })}
              onSignInExit={() => {
                setSigningIn(null);
                setAuthBusy(item.id); // "Checking the sign-in…" until the next list.
              }}
              onCheck={() => checkAuth(item)}
              updatingProgram={updatingProgram === item.id}
              programBusy={programBusy === item.id}
              onUpdateProgram={() => {
                setProblem(null);
                setUpdatingProgram(item.id);
              }}
              onCancelUpdate={() => send({ type: "agents.signin.cancel", id: item.id })}
              onUpdateExit={() => {
                setUpdatingProgram(null);
                setProgramBusy(item.id); // "Checking the version…" until the next list.
              }}
              onCheckProgram={() => checkProgram(item)}
            />
          )}
        </section>
      </div>

      {confirm && (
        <ConfirmDialog
          title={`Delete ${confirm.name}?`}
          confirmLabel="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            send({ type: "harnesses.delete", id: confirm.id });
            if (selected === confirm.id) setSelected(BUILTIN_AGENT);
            setConfirm(null);
          }}
        >
          The agent goes from the list. Its sessions stay, but they cannot run until you add it again.
          {confirm.id === current && " New sessions use Harness, the built-in agent."}
        </ConfirmDialog>
      )}
      {confirmRemove && (
        <ConfirmDialog
          title={`Uninstall ${confirmRemove.name}?`}
          confirmLabel="Uninstall"
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            send({ type: "harnesses.uninstall", id: confirmRemove.id });
            setConfirmRemove(null);
          }}
        >
          Harness deletes the files that it downloaded. The agent stays in the list, and you can download it again.
        </ConfirmDialog>
      )}
    </div>
  );
}

/** A row of the left list: the icon, the name, the version, the status line, and the switch. */
function AgentRow({ id, name, icon, version, update, tone, headline, isDefault, selected, onSelect, enabled, disabled, onEnable }: {
  id: string;
  name: string;
  icon?: string | null;
  version?: string;
  update?: boolean; // A newer version is available: an arrow after the version.
  tone: AgentTone;
  headline: string;
  isDefault: boolean;
  selected: boolean;
  onSelect: () => void;
  enabled?: boolean; // No value: the built-in agent, with no switch.
  disabled?: boolean;
  onEnable?: (on: boolean) => void;
}) {
  return (
    <div className={`agents-row${selected ? " selected" : ""}`}>
      <button type="button" className="agents-row-main" aria-current={selected || undefined} onClick={onSelect}>
        <AgentIcon id={id} name={name} icon={icon} size={20} />
        <span className="agents-row-text">
          <span className="agents-row-name">
            <span className="agents-row-label">{name}</span>
            {version && <span className="agents-row-version">v{version}</span>}
            {update && <ArrowUpCircle size={12} className="agents-row-update" role="img" aria-label="Update available" />}
            {isDefault && (
              <span className="agents-default" title="New sessions use this agent">
                Default
              </span>
            )}
          </span>
          <StatusLine tone={tone} headline={headline} small />
        </span>
      </button>
      {enabled !== undefined && onEnable && <Switch checked={enabled} label={`Enable ${name}`} disabled={disabled} onChange={onEnable} />}
    </div>
  );
}

function StatusLine({ tone, headline, small = false }: { tone: AgentTone; headline: string; small?: boolean }) {
  return (
    <span className={`agents-status${small ? " small" : ""}`}>
      <span className={`agents-dot ${tone}`} aria-hidden />
      {headline}
    </span>
  );
}

function UseForNew({ isDefault, disabled, onUse }: { isDefault: boolean; disabled: boolean; onUse: () => void }) {
  return (
    <div className="agents-use">
      {isDefault ? (
        <span className="setting-help">New sessions use this agent.</span>
      ) : (
        <button type="button" className="btn btn-small btn-primary" disabled={disabled} onClick={onUse}>
          Use for new sessions
        </button>
      )}
    </div>
  );
}

/** The detail of an ACP agent in the right pane. */
function AgentDetail({
  item,
  conn,
  connected,
  isDefault,
  providerModels,
  progress,
  signingIn,
  authBusy,
  editForm,
  customButtons,
  websiteButton,
  onSend,
  onUse,
  onDownload,
  onRemoveDownload,
  onSignIn,
  onCancelSignIn,
  onSignInExit,
  onCheck,
  updatingProgram,
  programBusy,
  onUpdateProgram,
  onCancelUpdate,
  onUpdateExit,
  onCheckProgram,
}: {
  item: HarnessItem;
  conn: DaemonConnection;
  connected: boolean;
  isDefault: boolean;
  providerModels: { provider: string; model: string }[];
  progress: HarnessProgress | null;
  signingIn: boolean;
  authBusy: boolean;
  editForm: ReactNode;
  customButtons: ReactNode;
  websiteButton: ReactNode;
  onSend: (msg: ClientMessage) => void;
  onUse: () => void;
  onDownload: () => void;
  onRemoveDownload: () => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onSignInExit: () => void;
  onCheck: () => void;
  updatingProgram: boolean;
  programBusy: boolean;
  onUpdateProgram: () => void;
  onCancelUpdate: () => void;
  onUpdateExit: () => void;
  onCheckProgram: () => void;
}) {
  const status = agentStatus(item);
  const auth = item.auth;
  const choices = modelChoices(item, providerModels);
  const modelId = `agent-model-${item.id}`;
  return (
    <>
      <div className="agents-detail-head">
        <AgentIcon id={item.id} name={item.name} icon={item.icon} size={24} />
        <h3 className="agents-detail-title">{item.name}</h3>
        <span className={`harness-badge${item.status !== "missing" ? " ready" : ""}`} title={item.detail}>
          {STATUS_TEXT[item.status]}
        </span>
        {item.local_models && (
          <span className="harness-badge" title="It can use a local model server, for example the llama-server of the Local models page.">
            Local models
          </span>
        )}
        <span className="spacer" />
        {websiteButton}
        {customButtons}
      </div>
      <p className="setting-help">{item.reason || item.description}</p>
      <div className="harness-meta agents-meta">
        <code>{item.command}</code>
        {item.download && <span>Version {item.download.version}</span>}
        {item.license && <span>{item.license}</span>}
        <DownloadControl item={item} progress={progress} disabled={!connected} onDownload={onDownload} onRemove={onRemoveDownload} />
      </div>
      {editForm}

      <h4 className="agents-section-title">Status</h4>
      <StatusLine tone={status.tone} headline={status.headline} />
      {status.detail && <p className="setting-help agents-status-detail">{status.detail}</p>}

      {item.can_sign_in && (
        <>
          <h4 className="agents-section-title">Account</h4>
          {!auth ? (
            <span className="skeleton agents-auth-skeleton" role="status" aria-label="Checking the sign-in" />
          ) : signingIn ? (
            <div className="agents-signin">
              <p className="setting-help">{auth.signin_help || "The agent opens a sign-in page in your browser. If it asks for a code, paste it here."}</p>
              <AgentSignInTerminal conn={conn} id={item.id} name={item.name} onExit={onSignInExit} />
              <div className="harness-form-actions">
                <button type="button" className="btn btn-small" onClick={onCancelSignIn}>
                  Cancel
                </button>
              </div>
            </div>
          ) : authBusy ? (
            <p className="setting-help agents-checking" role="status">
              <LoaderCircle size={13} className="spin" aria-hidden /> Checking the sign-in…
            </p>
          ) : auth.install_url ? (
            // The sign-in needs a program that is not on this computer. The page shows no download of it: only the
            // ACP adapter downloads and uninstalls here (the user asked for this).
            <p className="setting-help">{auth.detail}</p>
          ) : auth.status === "authenticated" ? (
            <div className="agents-inline">
              <span className="agents-signed-in">Signed in · {auth.label}</span>
              <span className="spacer" />
              <button type="button" className="btn btn-small" disabled={!connected} onClick={onSignIn}>
                Change account
              </button>
              <button type="button" className="btn btn-small" disabled={!connected} title="Read the sign-in state and the usage again" onClick={onCheck}>
                <RefreshCw size={13} aria-hidden /> Check again
              </button>
            </div>
          ) : (
            <div className="agents-inline">
              <span className="setting-help">{auth.detail || "Sign in to use this agent."}</span>
              <span className="spacer" />
              <button type="button" className="btn btn-small btn-primary" disabled={!connected} onClick={onSignIn}>
                <LogIn size={14} aria-hidden /> Sign in
              </button>
              {auth.status === "unknown" && (
                <button type="button" className="btn btn-small" disabled={!connected} title="Read the sign-in state and the usage again" onClick={onCheck}>
                  <RefreshCw size={13} aria-hidden /> Check again
                </button>
              )}
            </div>
          )}
        </>
      )}

      {item.program && (
        <ProgramUpdates
          item={item}
          program={item.program}
          conn={conn}
          connected={connected}
          updating={updatingProgram}
          busy={programBusy}
          onUpdate={onUpdateProgram}
          onCancel={onCancelUpdate}
          onExit={onUpdateExit}
          onCheck={onCheckProgram}
        />
      )}

      {auth && Boolean(auth.usage?.length || auth.usage_error) && (
        <>
          <h4 className="agents-section-title">Usage</h4>
          <UsageBars auth={auth} />
          {auth.checked_at > 0 && <p className="setting-help agents-checked">{checkedText(auth.checked_at)}</p>}
        </>
      )}

      {choices && (
        <>
          <h4 className="agents-section-title">
            <label htmlFor={modelId}>Model</label>
          </h4>
          <div className="agents-model">
            <select
              id={modelId}
              value={choices.value}
              disabled={!connected}
              onChange={(e) => modelChange(item, e.target.value).forEach(onSend)}
            >
              {choices.defaultLabel && <option value="">{choices.defaultLabel}</option>}
              {choices.groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="setting-help">
              Applies to new sessions.{item.provider_models && item.provider_note ? ` ${item.provider_note}` : ""}
            </span>
          </div>
        </>
      )}

      <UseForNew isDefault={isDefault} disabled={!connected} onUse={onUse} />
    </>
  );
}

/** The text of the version state of a program: "Version 0.23.2 is available.", "Up to date.", or null. */
export function programStateText(program: AgentProgram): string | null {
  if (program.update && program.latest) return `Version ${program.latest} is available.`;
  if (program.error) return program.error;
  if (program.version && program.latest) return "Up to date.";
  return null;
}

/** The Updates section of an agent whose program the user installed: its version, the newest version, "Update"
 * (its own update command in a terminal on the page), and "Check for updates". */
function ProgramUpdates({ item, program, conn, connected, updating, busy, onUpdate, onCancel, onExit, onCheck }: {
  item: HarnessItem;
  program: AgentProgram;
  conn: DaemonConnection;
  connected: boolean;
  updating: boolean;
  busy: boolean;
  onUpdate: () => void;
  onCancel: () => void;
  onExit: () => void;
  onCheck: () => void;
}) {
  const state = programStateText(program);
  return (
    <>
      <h4 className="agents-section-title">Updates</h4>
      {updating ? (
        <div className="agents-signin">
          <p className="setting-help">
            Harness runs <code>{program.command}</code> on the daemon computer. If it asks a question, answer it here.
          </p>
          <AgentSignInTerminal conn={conn} id={item.id} name={program.label} kind="update" onExit={onExit} />
          <div className="harness-form-actions">
            <button type="button" className="btn btn-small" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : busy ? (
        <p className="setting-help agents-checking" role="status">
          <LoaderCircle size={13} className="spin" aria-hidden /> Checking the version…
        </p>
      ) : (
        <div className="agents-inline agents-program">
          <span className="agents-program-text">
            <span>
              {program.label} {program.version ? `${program.version}` : ""}
            </span>
            {state && <span className={`setting-help${program.update ? " agents-update-note" : ""}`}>{state}</span>}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className={`btn btn-small${program.update ? " btn-primary" : ""}`}
            disabled={!connected}
            title={`Run ${program.command} on the daemon computer`}
            onClick={onUpdate}
          >
            <ArrowUpCircle size={14} aria-hidden /> Update
          </button>
          <button type="button" className="btn btn-small" disabled={!connected} title="Read the version and the newest version again" onClick={onCheck}>
            <RefreshCw size={13} aria-hidden /> Check for updates
          </button>
        </div>
      )}
      {!updating && program.checked && <p className="setting-help agents-checked">{checkedText(program.checked)}</p>}
    </>
  );
}

/** "Download", "Update", or the progress of a running download, and "Uninstall" (only a Harness download). */
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
        <button type="button" className="btn btn-small harness-uninstall" disabled={disabled} title={`Uninstall ${item.name}: delete the files that Harness downloaded`} onClick={onRemove}>
          <Trash2 size={14} aria-hidden /> Uninstall
        </button>
      )}
    </>
  );
}
