// The agent and model picker under the prompt box, modeled on the ProviderModelPicker of T3 Code (the user
// asked for this). A rail at the left has one tab for each agent: the built-in loop "Harness" first, then
// the ACP agents that are on (Settings > Agents). The right column has a search field and the models of the
// selected tab. The built-in tab keeps the model menu of the Claude app: the models of the online
// providers, the "Effort" and "Local models" submenus, and "Show providers" (rules C14, C15).
// On the start screen, a model of an ACP tab also makes that agent the agent of new sessions. In a
// session, the agent is fixed: the other tabs are off.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, LoaderCircle, Search, Settings, TriangleAlert } from "lucide-react";
import type { AgentModel, ClientMessage, Effort, HarnessItem, SessionHarness } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { modelName } from "../lib/modelName";
import { AgentIcon, BUILTIN_AGENT, UsageBars, agentReady, agentStatus } from "./AgentBits";
import { DEFAULT_EFFORT, EFFORT_HELP, EFFORT_LEVELS, effortLabel, groupModels, splitModels, type ModelList } from "./ModelMenu";

/** The name of the built-in agent loop in the rail. */
export const BUILTIN_NAME = "Harness";

/** One tab of the rail: the built-in loop, or an ACP agent. */
export interface AgentTab {
  id: string;
  name: string;
  item: HarnessItem | null; // null: the built-in loop, or the agent list did not come yet.
  models: AgentModel[]; // The models of the agent itself. Empty: not known yet.
  nativeModel: string | null; // Start screen: the chosen model of the agent itself. Session: the current model.
  providerModel: string | null; // The chosen model of a Harness provider, "<provider>/<model>".
  providerModels: boolean; // The agent can use a model of a Harness provider.
}

export type RowKind = "default" | "builtin" | "native" | "provider";

/** One model row. ``value``: the built-in spec ("" for "Default model"), the model id of the agent, or "<provider>/<model>". */
export interface PickRow {
  key: string;
  agent: string;
  kind: RowKind;
  value: string;
  label: string;
  sub?: string;
}

/** A group of rows. ``heading``: the heading in the tab (null: none). ``searchHeading``: the heading in the search results. */
export interface PickGroup {
  key: string;
  heading: string | null;
  searchHeading: string;
  rows: PickRow[];
}

const builtinTab: AgentTab = {
  id: BUILTIN_AGENT,
  name: BUILTIN_NAME,
  item: null,
  models: [],
  nativeModel: null,
  providerModel: null,
  providerModels: false,
};

/**
 * The tabs of the rail: the built-in loop first, then each ACP agent that is on, in the order of the list.
 * The agent that runs now (``current``) always has a tab, also when it is off. ``inSession``: the model of
 * ``current`` is the model of the session, not a choice for new sessions.
 */
export function railTabs(items: HarnessItem[] | null, current: SessionHarness | null, inSession: boolean): AgentTab[] {
  const tabs: AgentTab[] = [builtinTab];
  const list = items ?? [];
  for (const item of list) {
    if (!item.enabled && item.id !== current?.id) continue;
    if (inSession && item.id === current?.id) {
      tabs.push({ id: item.id, name: item.name, item, models: current.models ?? [], nativeModel: current.model ?? null, providerModel: null, providerModels: false });
      continue;
    }
    const fallback = item.id === current?.id ? current : null; // The list can be older than user_settings.
    tabs.push({
      id: item.id,
      name: item.name,
      item,
      models: item.models.length ? item.models : (fallback?.models ?? []),
      nativeModel: item.native_model,
      providerModel: item.provider_model,
      providerModels: item.provider_models,
    });
  }
  if (current && !list.some((i) => i.id === current.id)) {
    // The list did not come yet: a tab from the data of the session or of user_settings.
    tabs.push({
      id: current.id,
      name: current.name,
      item: null,
      models: current.models ?? [],
      nativeModel: inSession ? (current.model ?? null) : (current.native_model ?? null),
      providerModel: inSession ? null : (current.model ?? null),
      providerModels: !inSession && !!current.model,
    });
  }
  return tabs;
}

/** True when each word of the query is in the text (no case). An empty query matches all. */
export function matchesQuery(text: string, query: string): boolean {
  const hay = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * The groups of the built-in tab. ``all``: the search list, with the local models and a provider heading on
 * each group. Else the top list: "Default model", then the online models, with a provider heading only
 * when two or more online providers give models.
 */
export function builtinGroups(models: ModelList | null, allowDefault: boolean, local: ReadonlySet<string>, all = false): PickGroup[] {
  const split = splitModels(models?.items ?? [], local);
  const fallback = models?.default ? modelName(models.default) : null;
  const out: PickGroup[] = [];
  if (allowDefault && !all) {
    out.push({
      key: "harness:default",
      heading: null,
      searchHeading: BUILTIN_NAME,
      rows: [{ key: "harness:", agent: BUILTIN_AGENT, kind: "default", value: "", label: fallback ? `Default model (${fallback})` : "Default model" }],
    });
  }
  const groups = groupModels(all ? [...split.online, ...split.local] : split.online);
  for (const g of groups) {
    out.push({
      key: `harness:${g.provider}`,
      heading: all || groups.length > 1 ? g.provider : null,
      searchHeading: g.provider,
      rows: g.models.map((spec) => ({ key: `harness:${spec}`, agent: BUILTIN_AGENT, kind: "builtin", value: spec, label: spec.slice(g.provider.length + 1) })),
    });
  }
  return out;
}

/**
 * The groups of an ACP tab: "Default of {name}" (``withDefault``), the models of the agent itself, then a
 * group for each provider when the agent can use a model of a Harness provider (``providerItems``).
 */
export function agentGroups(tab: AgentTab, providerItems: string[], withDefault: boolean): PickGroup[] {
  const out: PickGroup[] = [];
  const providers = tab.providerModels ? groupModels(providerItems) : [];
  if (withDefault) {
    out.push({
      key: `${tab.id}:default`,
      heading: null,
      searchHeading: tab.name,
      rows: [{ key: `${tab.id}:default`, agent: tab.id, kind: "default", value: "", label: `Default of ${tab.name}` }],
    });
  }
  if (tab.models.length) {
    out.push({
      key: `${tab.id}:own`,
      heading: providers.length ? tab.name : null,
      searchHeading: tab.name,
      rows: tab.models.map((m) => ({ key: `${tab.id}:own:${m.id}`, agent: tab.id, kind: "native", value: m.id, label: m.name, sub: m.description || undefined })),
    });
  }
  for (const g of providers) {
    out.push({
      key: `${tab.id}:p:${g.provider}`,
      heading: g.provider,
      searchHeading: `${tab.name} · ${g.provider}`,
      rows: g.models.map((spec) => ({ key: `${tab.id}:p:${spec}`, agent: tab.id, kind: "provider", value: spec, label: spec.slice(g.provider.length + 1) })),
    });
  }
  return out;
}

/** The search results: the rows of all the groups that match the query, each group with its search heading. */
export function searchGroups(groups: PickGroup[], query: string): PickGroup[] {
  return groups
    .map((g) => ({ ...g, heading: g.searchHeading, rows: g.rows.filter((r) => r.kind !== "default" && matchesQuery(`${r.label} ${r.value}`, query)) }))
    .filter((g) => g.rows.length > 0);
}

/** True when the row is the current choice of its tab. ``builtinValue``: the model of the built-in loop. */
export function rowChecked(row: PickRow, tab: AgentTab, builtinValue: string): boolean {
  if (row.agent === BUILTIN_AGENT) return row.value === builtinValue;
  if (row.kind === "native") return tab.nativeModel === row.value;
  if (row.kind === "provider") return tab.providerModel === row.value;
  return !tab.nativeModel && !tab.providerModel;
}

/** The chip text of an ACP agent: the model name, else the agent name. */
export function agentChipLabel(harness: SessionHarness, inSession: boolean): string {
  if (inSession) return harness.models?.find((m) => m.id === harness.model)?.name ?? harness.name;
  if (harness.native_model) return harness.models?.find((m) => m.id === harness.native_model)?.name ?? harness.native_model;
  if (harness.model) return modelName(harness.model);
  return harness.name;
}

/**
 * The messages for a choice in an ACP tab on the start screen: the agent becomes the agent of new sessions
 * (``currentAgent``: the id of that agent now, null for the built-in loop), and the agent gets the model.
 */
export function agentChoiceMessages(tab: AgentTab, row: PickRow, currentAgent: string | null): ClientMessage[] {
  const out: ClientMessage[] = [];
  if (row.kind === "default") {
    if (tab.nativeModel) out.push({ type: "harnesses.native_model", id: tab.id, model: null });
    if (tab.providerModel) out.push({ type: "harnesses.model", id: tab.id, model: null });
  } else if (row.kind === "native" && tab.nativeModel !== row.value) {
    out.push({ type: "harnesses.native_model", id: tab.id, model: row.value });
  } else if (row.kind === "provider" && tab.providerModel !== row.value) {
    out.push({ type: "harnesses.model", id: tab.id, model: row.value });
  }
  if (currentAgent !== tab.id) out.push({ type: "user_settings.set", values: { operating_harness: tab.id } });
  return out;
}

/** The hover tip of a rail tab: the name, then the status of the agent. */
export function tabTip(tab: AgentTab, lockedTo: string | null): string {
  if (lockedTo !== null && tab.id !== lockedTo) return `${tab.name} is not available in this session. Start a new session to change the agent.`;
  if (!tab.item) return tab.name;
  return `${tab.name}\n${agentStatus(tab.item).headline}`;
}

type Sub = "effort" | "local" | null;

export function AgentPicker({
  value,
  models,
  allowDefault,
  localProviders,
  effort,
  agents,
  current,
  session,
  shortcut = false,
  onRequestModels,
  onRequestAgents,
  onSelect,
  onAgentMessages,
  onSessionModel,
  onManageProviders,
  onManageAgents,
}: {
  value: string; // The model of the built-in loop: "provider/model", or "" for the default model.
  models: ModelList | null; // null: loading.
  allowDefault: boolean; // "Default model": the default_model setting of the daemon.
  localProviders?: ReadonlySet<string>; // The providers on the computer of the daemon: the "Local models" submenu.
  effort?: { value: Effort | null; onChange: (value: Effort) => void }; // The "Effort" submenu. null: High.
  agents: HarnessItem[] | null; // The harnesses of the daemon (harnesses.list). null: not loaded.
  current: SessionHarness | null; // The ACP agent that runs (session) or that runs new sessions (start screen). null: the built-in loop.
  session?: { running: boolean } | null; // Set in a session: the agent is fixed.
  shortcut?: boolean; // Ctrl+Shift+. opens the picker (rule C17).
  onRequestModels: () => void; // A connection can change at any time: the picker asks again when it opens.
  onRequestAgents: () => void;
  onSelect: (spec: string) => void; // A model of the built-in loop. Start screen: the built-in loop also becomes the agent.
  onAgentMessages?: (messages: ClientMessage[]) => void; // Start screen: a choice in an ACP tab.
  onSessionModel?: (model: string) => void; // An ACP session: acp.model.
  onManageProviders: () => void; // Opens the Providers page.
  onManageAgents: () => void; // Opens Settings > Agents.
}) {
  const inSession = !!session;
  const currentId = current?.id ?? BUILTIN_AGENT;
  const [open, setOpen] = useState(false);
  const [tabId, setTabId] = useState(currentId);
  const [query, setQuery] = useState("");
  const [sub, setSub] = useState<Sub>(null);
  const [subFocus, setSubFocus] = useState(false); // The keyboard opened the submenu: its first item gets the focus.
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useOverlay(open);

  const close = () => {
    setOpen(false);
    setSub(null);
  };

  const show = () => {
    setTabId(currentId);
    setQuery("");
    setSub(null);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    onRequestModels();
    onRequestAgents();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Ctrl+Shift+. opens the picker of the prompt box that shows (rule C17).
  const openRef = useRef(open);
  openRef.current = open;
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== "Period") return;
      if (!ref.current || ref.current.getClientRects().length === 0) return; // A hidden prompt box.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (openRef.current) close();
      else showRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shortcut]);

  const tabs = railTabs(agents, current, inSession);
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];

  // Start screen: an agent with no known models gets a model check, so the user can choose the model before the
  // first session (the user asked for this). The daemon starts the agent with no prompt (agents.models).
  // "waiting": the request went, and no list with "probing" came yet: the loading line shows at once.
  const asked = useRef(new Set<string>());
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const item = tab.item;
    if (!open || inSession || !item || item.custom || item.models.length > 0 || item.probing || !agentReady(item)) return;
    if (asked.current.has(item.id)) return;
    asked.current.add(item.id);
    setWaiting((w) => new Set(w).add(item.id));
    onAgentMessages?.([{ type: "agents.models", id: item.id }]);
  }, [open, inSession, tab.item, onAgentMessages]);
  useEffect(() => {
    // The daemon took the request (probing), or the models came: the list shows the state from now on.
    const done = [...waiting].filter((id) => agents?.some((a) => a.id === id && (a.probing || a.models.length > 0)));
    if (done.length) setWaiting((w) => new Set([...w].filter((id) => !done.includes(id))));
  }, [agents, waiting]);
  const lockedTo = inSession ? currentId : null;
  const usable = tabs.filter((t) => lockedTo === null || t.id === lockedTo);
  const local = localProviders ?? new Set<string>();
  const providerItems = models?.items ?? [];
  const searching = query.trim() !== "";

  const groupsOf = (t: AgentTab, all: boolean): PickGroup[] =>
    t.id === BUILTIN_AGENT ? builtinGroups(models, allowDefault, local, all) : agentGroups(t, inSession ? [] : providerItems, !inSession);
  const shown: PickGroup[] = searching ? usable.flatMap((t) => searchGroups(groupsOf(t, true), query.trim())) : groupsOf(tab, false);
  const rows = shown.flatMap((g) => g.rows);
  const keyOf = (row: PickRow) => {
    const at = rows.indexOf(row);
    return at >= 0 && at < 9 ? at + 1 : undefined;
  };
  const tabOf = (row: PickRow) => tabs.find((t) => t.id === row.agent) ?? tab;
  const sessionBusy = inSession && currentId !== BUILTIN_AGENT && !!session?.running;

  // The focus goes to the current row when the picker opens or the tab changes. It stays in the search field.
  useEffect(() => {
    if (!open || document.activeElement === searchRef.current) return;
    const list = ref.current?.querySelector(".agent-picker-list");
    (list?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)') ??
      list?.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
      searchRef.current)?.focus();
  }, [open, tab.id, models !== null, agents !== null]);

  useEffect(() => {
    if (!sub || !subFocus) return;
    const panel = ref.current?.querySelector(".model-submenu");
    (panel?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? panel?.querySelector<HTMLButtonElement>("button"))?.focus();
    setSubFocus(false);
  }, [sub, subFocus]);

  const choose = (row: PickRow) => {
    close();
    const t = tabOf(row);
    if (row.agent === BUILTIN_AGENT) {
      if (inSession) {
        if (row.value !== value) onSelect(row.value);
        return;
      }
      if (current) onAgentMessages?.([{ type: "user_settings.set", values: { operating_harness: null } }]);
      if (current || row.value !== value) onSelect(row.value);
      return;
    }
    if (inSession) {
      if (row.kind === "native" && row.value !== t.nativeModel) onSessionModel?.(row.value);
      return;
    }
    const messages = agentChoiceMessages(t, row, current?.id ?? null);
    if (messages.length) onAgentMessages?.(messages);
  };

  const switchTab = (step: number) => {
    if (inSession || tabs.length < 2) return;
    const at = tabs.findIndex((t) => t.id === tab.id);
    setTabId(tabs[(at + step + tabs.length) % tabs.length].id);
    setSub(null);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const target = e.target as HTMLElement;
    const inSub = !!target.closest(".model-submenu");
    const inSearch = target === searchRef.current;
    if (e.key === "Escape" || (inSub && e.key === "ArrowLeft")) {
      e.preventDefault();
      e.stopPropagation();
      if (sub) {
        const row = sub;
        setSub(null);
        ref.current?.querySelector<HTMLButtonElement>(`[data-sub="${row}"]`)?.focus();
      } else close();
      return;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      switchTab(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    const subRow = target.dataset.sub as Sub | undefined;
    if (!inSub && subRow && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setSub(subRow);
      setSubFocus(true);
      return;
    }
    if (inSearch && e.key === "Enter") {
      e.preventDefault();
      const first = rows.find((r) => !(sessionBusy && r.agent !== BUILTIN_AGENT));
      if (first) choose(first);
      return;
    }
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (!inSub && !inSearch && plain && /^[1-9]$/.test(e.key)) {
      const row = rows[Number(e.key) - 1];
      if (row && !(sessionBusy && row.agent !== BUILTIN_AGENT)) {
        e.preventDefault();
        choose(row);
      }
      return;
    }
    // A letter in the list goes to the search field.
    if (!inSub && !inSearch && plain && e.key.length === 1 && e.key !== " " && !target.closest(".agent-picker-rail")) {
      e.preventDefault();
      setQuery((q) => q + e.key);
      setSub(null);
      searchRef.current?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (target.closest(".agent-picker-rail")) {
      e.preventDefault();
      const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".agent-picker-rail button") ?? [])];
      const at = buttons.indexOf(target as HTMLButtonElement);
      buttons[(at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      return;
    }
    e.preventDefault();
    const items = inSub
      ? [...(ref.current?.querySelectorAll<HTMLElement>(".model-submenu button") ?? [])]
      : [...(ref.current?.querySelectorAll<HTMLElement>(".model-menu-main input, .model-menu-main button:not(:disabled)") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  // The chip.
  const builtinCurrent = currentId === BUILTIN_AGENT;
  const fallback = models?.default ? modelName(models.default) : null;
  const builtinName = value ? modelName(value) : fallback ?? "Default model";
  const shownEffort = builtinCurrent && effort ? effortLabel(effort.value) : null;
  const currentEffort = effort?.value ?? DEFAULT_EFFORT;
  const chipName = current ? agentChipLabel(current, inSession) : builtinName;
  const keyTip = shortcut ? " (Ctrl+Shift+.)" : "";
  const chipTip = current
    ? inSession
      ? `${current.name} runs this session through ACP. Click to see its models${keyTip}`
      : `New sessions run in ${current.name} through ACP. Click to choose the agent and the model${keyTip}`
    : value
      ? `The model: ${value}${shownEffort ? `, effort ${shownEffort}` : ""}. Click to choose the agent and the model${keyTip}`
      : fallback
        ? `The default model: ${models!.default}. Click to choose the agent and the model${keyTip}`
        : `The default model of the daemon. Click to choose the agent and the model${keyTip}`;

  const radio = (row: PickRow, inSub = false) => {
    const checked = rowChecked(row, tabOf(row), value);
    const key = inSub ? undefined : keyOf(row);
    return (
      <button
        key={row.key}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        disabled={sessionBusy && row.agent !== BUILTIN_AGENT}
        title={row.sub}
        onClick={() => choose(row)}
        onMouseEnter={inSub ? undefined : () => setSub(null)}
      >
        <span className="model-menu-name">{row.label}</span>
        <span className="model-menu-end">
          {checked ? <Check size={15} className="model-menu-check" aria-hidden /> : key !== undefined && <kbd className="model-menu-key">{key}</kbd>}
        </span>
      </button>
    );
  };

  const subRowButton = (name: Exclude<Sub, null>, label: string, detail: string | null) => (
    <button
      type="button"
      role="menuitem"
      data-sub={name}
      aria-haspopup="menu"
      aria-expanded={sub === name}
      onClick={() => setSub(sub === name ? null : name)}
      onMouseEnter={() => setSub(name)}
    >
      <span className="model-menu-name">{label}</span>
      <span className="model-menu-end">
        {detail && <span className="model-menu-detail">{detail}</span>}
        <ChevronRight size={15} aria-hidden />
      </span>
    </button>
  );

  const groupList = (groups: PickGroup[]) =>
    groups.map((g) => (
      <div key={g.key} role="group" aria-label={g.heading ?? g.searchHeading}>
        {g.heading && <div className="menu-heading">{g.heading}</div>}
        {g.rows.map((r) => radio(r))}
      </div>
    ));

  const split = splitModels(providerItems, local);
  const selectedLocal = value && split.local.includes(value) ? modelName(value) : null;

  const builtinBody = () =>
    models === null ? (
      <p className="menu-note">
        <LoaderCircle size={14} className="spin" aria-hidden /> Asking the providers for their models.
      </p>
    ) : (
      <>
        {models.items.length === 0 && <p className="menu-note">No provider gives a model.</p>}
        {value && !models.items.includes(value) && (
          <p className="menu-note">
            <TriangleAlert size={13} aria-hidden /> No provider gives {value} now.
          </p>
        )}
        {groupList(shown)}
        {models.errors.map((e) => (
          <p key={e.provider} className="menu-note model-menu-error" title={e.message}>
            <TriangleAlert size={13} aria-hidden /> {e.provider}: {e.message}
          </p>
        ))}
      </>
    );

  const agentBody = (t: AgentTab) => {
    const item = t.item;
    const needsAttention = !!item && (item.status === "missing" || item.auth?.status === "unauthenticated");
    return (
      <>
        {item?.can_sign_in && item.auth?.usage?.length ? (
          <div className="agent-picker-usage">
            <UsageBars auth={item.auth} compact />
          </div>
        ) : null}
        {item && needsAttention && (
          <p className="agent-picker-notice">
            <TriangleAlert size={13} aria-hidden /> {agentStatus(item).detail || agentStatus(item).headline}{" "}
            <button type="button" className="agent-picker-link" onClick={() => { close(); onManageAgents(); }}>
              Open agent settings
            </button>
          </p>
        )}
        {sessionBusy && <p className="menu-note">The agent changes the model only between turns.</p>}
        {groupList(shown)}
        {t.models.length === 0 && (inSession || !(item?.probing || waiting.has(t.id))) && (
          <p className="menu-note">{inSession ? `${t.name} chooses its own model.` : `${t.name} gave no models. Use "Default of ${t.name}".`}</p>
        )}
        {!inSession && t.models.length === 0 && (item?.probing || waiting.has(t.id)) && (
          <p className="menu-note">
            <LoaderCircle size={14} className="spin" aria-hidden /> Asking {t.name} for its models.
          </p>
        )}
        {!inSession && t.providerModels && models === null && (
          <p className="menu-note">
            <LoaderCircle size={14} className="spin" aria-hidden /> Asking the providers for their models.
          </p>
        )}
      </>
    );
  };

  const heading = inSession ? `${tab.name} · this session` : tab.name;

  return (
    <div className="model-menu agent-picker" ref={ref} onKeyDown={onKeyDown}>
      <button
        type="button"
        className={`prompt-chip model-button${open ? " active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : show())}
        title={chipTip}
      >
        <AgentIcon id={currentId} name={current?.name ?? BUILTIN_NAME} icon={agents?.find((a) => a.id === currentId)?.icon} size={14} />
        <span className="prompt-chip-text">{chipName}</span>
        {shownEffort && (
          <>
            {/* A bar separates the model and the effort level (the user asked for this). */}
            <span className="model-button-sep" aria-hidden>
              |
            </span>
            <span className="model-button-effort">{shownEffort}</span>
          </>
        )}
      </button>
      {open && (
        <div className="menu model-dropdown up right agent-picker-dropdown" role="menu" aria-label="Agents and models">
          <div className="agent-picker-rail">
            <div className="agent-picker-tabs" role="tablist" aria-orientation="vertical" aria-label="Agents">
            {tabs.map((t) => {
              const locked = lockedTo !== null && t.id !== lockedTo;
              const notReady = t.item !== null && !agentReady(t.item);
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={t.id === tab.id}
                  aria-disabled={locked || undefined}
                  className={`agent-picker-tab${t.id === tab.id && !searching ? " selected" : ""}${notReady ? " not-ready" : ""}`}
                  title={tabTip(t, lockedTo)}
                  onClick={() => {
                    if (locked) return;
                    setTabId(t.id);
                    setQuery("");
                    setSub(null);
                  }}
                  onMouseEnter={() => setSub(null)}
                >
                  <AgentIcon id={t.id} name={t.name} icon={t.item?.icon} size={20} />
                </button>
              );
            })}
            </div>
            <button
              type="button"
              className="agent-picker-tab agent-picker-manage"
              title="Manage agents"
              aria-label="Manage agents"
              onClick={() => {
                close();
                onManageAgents();
              }}
            >
              <Settings size={16} aria-hidden />
            </button>
          </div>
          <div className="model-menu-main agent-picker-main">
            <div className="model-menu-heading">{searching ? "Search" : heading}</div>
            <div className="agent-picker-search">
              <Search size={14} aria-hidden />
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder="Search models..."
                aria-label="Search models"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSub(null);
                }}
              />
            </div>
            <div className="model-menu-list agent-picker-list">
              {searching ? (
                rows.length ? groupList(shown) : <p className="menu-note">No model matches "{query.trim()}".</p>
              ) : tab.id === BUILTIN_AGENT ? (
                builtinBody()
              ) : (
                agentBody(tab)
              )}
            </div>
            {tab.id === BUILTIN_AGENT && !searching && (
              <>
                <div className="menu-sep" role="separator" />
                {effort && subRowButton("effort", "Effort", effortLabel(effort.value))}
                {localProviders && subRowButton("local", "Local models", selectedLocal)}
                <div className="menu-sep" role="separator" />
                <button type="button" role="menuitem" onClick={() => { close(); onManageProviders(); }} onMouseEnter={() => setSub(null)}>
                  <span className="model-menu-name">Show providers</span>
                </button>
              </>
            )}
          </div>
          {sub === "effort" && effort && (
            <div className="menu model-submenu" role="menu" aria-label="Effort">
              {EFFORT_LEVELS.map((l) => (
                <button
                  key={l.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={currentEffort === l.value}
                  onClick={() => {
                    close();
                    if (currentEffort !== l.value) effort.onChange(l.value);
                  }}
                >
                  <span className="model-menu-name">{l.label}</span>
                  <span className="model-menu-end">{currentEffort === l.value && <Check size={15} className="model-menu-check" aria-hidden />}</span>
                </button>
              ))}
              <p className="model-submenu-help">{EFFORT_HELP}</p>
            </div>
          )}
          {sub === "local" && (
            <div className="menu model-submenu" role="menu" aria-label="Local models">
              {split.local.length === 0 ? (
                <p className="menu-note">No local model is on. Add Ollama or llama.cpp on the Local models page.</p>
              ) : (
                groupModels(split.local).map((g) => (
                  <div key={g.provider} role="group" aria-label={g.provider}>
                    <div className="menu-heading">{g.provider}</div>
                    {g.models.map((spec) =>
                      radio({ key: `harness:${spec}`, agent: BUILTIN_AGENT, kind: "builtin", value: spec, label: spec.slice(g.provider.length + 1) }, true),
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
