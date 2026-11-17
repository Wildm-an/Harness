// The agent and model picker under the prompt box, modeled on the model picker of T3 Code (the user asked for
// this, rules C14 to C15). Three columns:
// - A rail at the left: the Favorites tab (a star), then one tab for each agent: the built-in loop "Harness"
//   first, then the ACP agents that are on (Settings > Agents). A gear at the bottom opens Settings > Agents.
// - The middle column: a search field, then the models of the selected tab in a panel with a border. Each row
//   has the agent logo, the name, a check mark on the current model, a star (favorites), and Ctrl+1 to Ctrl+9.
// - The right column: the reasoning levels of the agent ("Reasoning"), with "Default" and a check mark.
// On the start screen, a model of an ACP tab also makes that agent the agent of new sessions. In a session, the
// agent is fixed: the other tabs are off.

import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Search, Settings, Star, TriangleAlert } from "lucide-react";
import type { AgentModel, ClientMessage, Effort, HarnessItem, SessionHarness } from "../daemon/protocol";
import { useOverlay } from "../lib/overlay";
import { modelName } from "../lib/modelName";
import { loadPref, savePref } from "../lib/prefs";
import { AgentIcon, BUILTIN_AGENT, UsageBars, agentReady, agentStatus } from "./AgentBits";
import { DEFAULT_EFFORT, EFFORT_HELP, EFFORT_LEVELS, effortLabel, groupModels, splitModels, type ModelList } from "./ModelMenu";

/** The name of the built-in agent loop in the rail. */
export const BUILTIN_NAME = "Harness";

/** The id of the Favorites tab of the rail. An agent id has no ":". */
export const FAVORITES_TAB = ":favorites";

/** The preference key of the favorite models: a JSON array of "<agentId>|<modelValue>" strings. */
export const FAVORITES_PREF = "picker.favorites";

/** The number of model rows of a tab before "Show more". */
export const SHOW_FIRST = 4;

/** The id of the reasoning level "the default of the agent" (an ACP config option value). */
export const DEFAULT_LEVEL = "default";

/** One tab of the rail: the built-in loop, or an ACP agent. */
export interface AgentTab {
  id: string;
  name: string;
  item: HarnessItem | null; // null: the built-in loop, or the agent list did not come yet.
  models: AgentModel[]; // The models of the agent itself. Empty: not known yet.
  nativeModel: string | null; // Start screen: the chosen model of the agent itself. Session: the current model.
  providerModel: string | null; // The chosen model of a Harness provider, "<provider>/<model>".
  providerModels: boolean; // The agent can use a model of a Harness provider.
  efforts?: AgentModel[]; // The reasoning levels of the agent. Empty or absent: none.
  effort?: string | null; // Session: the current level. Start screen: the chosen level for new sessions.
}

export type RowKind = "default" | "builtin" | "native" | "provider";

/** One model row. ``value``: the built-in spec ("" for "Default model"), the model id of the agent, or "<provider>/<model>". */
export interface PickRow {
  key: string;
  agent: string;
  kind: RowKind;
  value: string;
  label: string;
  sub?: string; // The hover tip: the description of the model.
  detail?: string; // Muted text after the name (Favorites: the provider or the agent).
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
      tabs.push({
        id: item.id,
        name: item.name,
        item,
        models: current.models ?? [],
        nativeModel: current.model ?? null,
        providerModel: null,
        providerModels: false,
        efforts: current.efforts ?? [],
        effort: current.effort ?? null,
      });
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
      efforts: item.efforts?.length ? item.efforts : (fallback?.efforts ?? []),
      effort: item.native_effort ?? null,
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
      efforts: current.efforts ?? [],
      effort: inSession ? (current.effort ?? null) : (current.native_effort ?? null),
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
 * The groups of the built-in tab. ``all``: the search list, with a provider heading on each group. Else the
 * tab list: "Default model", the online models (a provider heading only when two or more online providers
 * give models), then the "Local models" group of the providers on the computer of the daemon.
 */
export function builtinGroups(models: ModelList | null, allowDefault: boolean, local: ReadonlySet<string>, all = false): PickGroup[] {
  const split = splitModels(models?.items ?? [], local);
  const fallback = models?.default ? modelName(models.default) : null;
  const out: PickGroup[] = [];
  const rowsOf = (provider: string, specs: string[]): PickRow[] =>
    specs.map((spec) => ({ key: `harness:${spec}`, agent: BUILTIN_AGENT, kind: "builtin", value: spec, label: spec.slice(provider.length + 1) }));
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
    out.push({ key: `harness:${g.provider}`, heading: all || groups.length > 1 ? g.provider : null, searchHeading: g.provider, rows: rowsOf(g.provider, g.models) });
  }
  if (!all) {
    const locals = groupModels(split.local);
    for (const g of locals) {
      out.push({
        key: `harness:local:${g.provider}`,
        heading: locals.length > 1 ? `Local models · ${g.provider}` : "Local models",
        searchHeading: g.provider,
        rows: rowsOf(g.provider, g.models),
      });
    }
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

/**
 * The first rows of a tab, before "Show more": at most ``limit`` model rows. A "default" row and a ``keep``
 * row (the current model) always show. ``hidden``: the number of rows that do not show.
 */
export function firstRows(groups: PickGroup[], limit: number, keep: (row: PickRow) => boolean = () => false): { groups: PickGroup[]; hidden: number } {
  let count = 0;
  let hidden = 0;
  const out = groups
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) => {
        if (r.kind === "default") return true;
        if (count < limit || keep(r)) {
          count += 1;
          return true;
        }
        hidden += 1;
        return false;
      }),
    }))
    .filter((g) => g.rows.length > 0);
  return { groups: out, hidden };
}

/** The favorite key of a model: "<agentId>|<modelValue>". */
export function favoriteKey(agent: string, value: string): string {
  return `${agent}|${value}`;
}

/** The favorites of the preference (a JSON array). A bad value gives an empty list. */
export function parseFavorites(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((k): k is string => typeof k === "string" && splitFavorite(k) !== null))];
  } catch {
    return [];
  }
}

/** The agent and the model value of a favorite key. null: not a favorite key. */
export function splitFavorite(key: string): { agent: string; value: string } | null {
  const at = key.indexOf("|");
  if (at <= 0 || at === key.length - 1) return null;
  return { agent: key.slice(0, at), value: key.slice(at + 1) };
}

/** Adds the key to the favorites, or removes it when it is there. */
export function toggleFavorite(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

/**
 * The rows of the Favorites tab, in the order of the favorites: each favorite that a row of ``groups`` gives.
 * A favorite of a model that no group gives now does not show. Each row gets its group as its detail.
 */
export function favoriteRows(favorites: string[], groups: PickGroup[]): PickRow[] {
  const out: PickRow[] = [];
  for (const key of favorites) {
    for (const g of groups) {
      const row = g.rows.find((r) => r.kind !== "default" && favoriteKey(r.agent, r.value) === key);
      if (row) {
        out.push({ ...row, detail: g.searchHeading });
        break;
      }
    }
  }
  return out;
}

/** The row number of Ctrl+1 to Ctrl+9 (1 to 9). null: another key. */
export function ctrlDigit(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): number | null {
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return null;
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code ?? "") ?? /^([1-9])$/.exec(e.key);
  return m ? Number(m[1]) : null;
}

/** The key badge of the row at ``index`` (0-based): "Ctrl+1" to "Ctrl+9". null: no key. */
export function rowKeyLabel(index: number): string | null {
  return index >= 0 && index < 9 ? `Ctrl+${index + 1}` : null;
}

/** The reasoning levels of an agent, as the picker shows them. */
export interface Efforts {
  levels: AgentModel[]; // The rows, in the order of the agent.
  defaultId: string | null; // The level with the "Default" label. null: not known.
  currentId: string | null; // The level with the check mark. null: none.
}

function namesWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * The rows of the reasoning levels of an ACP agent. The entry "default" is not a row when its name or
 * description names another level (for example "Default (medium)"): that level gets the "Default" label, and
 * the current value "default" (or null) checks it. Else the entry shows as the row "Default".
 */
export function resolveEfforts(efforts: AgentModel[], current: string | null | undefined): Efforts {
  const entry = efforts.find((e) => e.id === DEFAULT_LEVEL);
  const others = efforts.filter((e) => e.id !== DEFAULT_LEVEL);
  if (!entry) return { levels: others, defaultId: null, currentId: current ?? null };
  const text = `${entry.name} ${entry.description}`;
  let match: AgentModel | null = null;
  let length = 0;
  for (const level of others) {
    for (const word of [level.name, level.id]) {
      // The longest name wins: "Extra high" before "high".
      if (word && word.length > length && word.toLowerCase() !== DEFAULT_LEVEL && namesWord(text, word)) {
        match = level;
        length = word.length;
      }
    }
  }
  if (match) return { levels: others, defaultId: match.id, currentId: !current || current === DEFAULT_LEVEL ? match.id : current };
  return { levels: [{ ...entry, name: "Default" }, ...others], defaultId: DEFAULT_LEVEL, currentId: current ?? DEFAULT_LEVEL };
}

/**
 * The value to send for the level ``id``. A session sends the id (acp.effort). The start screen sends null for
 * the default level (harnesses.native_effort: the default of the agent), else the id.
 */
export function effortValue(id: string, efforts: Efforts, inSession: boolean): string | null {
  if (inSession) return id;
  return id === efforts.defaultId ? null : id;
}

/** The level name after the model in the chip of an ACP agent. null: no level, or the default of the agent. */
export function effortChipName(efforts: AgentModel[] | undefined, current: string | null | undefined): string | null {
  if (!efforts?.length) return null;
  const r = resolveEfforts(efforts, current);
  if (!r.currentId || r.currentId === DEFAULT_LEVEL) return null;
  return r.levels.find((l) => l.id === r.currentId)?.name ?? null;
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
  if (lockedTo !== null && tab.id !== lockedTo) return `${tab.name}: the agent changes only between turns.`;
  if (!tab.item) return tab.name;
  return `${tab.name}\n${agentStatus(tab.item).headline}`;
}

/** The content of the Reasoning column. */
type Reasoning =
  | { kind: "levels"; agent: string; levels: AgentModel[]; defaultId: string | null; currentId: string | null; help?: string; disabled: boolean; pick: (id: string) => void }
  | { kind: "note"; note: string };

const visible = (el: Element) => el.getClientRects().length > 0;

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
  onSessionEffort,
  onSwitchAgent,
  onManageProviders,
  onManageAgents,
}: {
  value: string; // The model of the built-in loop: "provider/model", or "" for the default model.
  models: ModelList | null; // null: loading.
  allowDefault: boolean; // "Default model": the default_model setting of the daemon.
  localProviders?: ReadonlySet<string>; // The providers on the computer of the daemon: the "Local models" group.
  effort?: { value: Effort | null; onChange: (value: Effort) => void }; // The reasoning of the built-in loop. null: High.
  agents: HarnessItem[] | null; // The harnesses of the daemon (harnesses.list). null: not loaded.
  current: SessionHarness | null; // The ACP agent that runs (session) or that runs new sessions (start screen). null: the built-in loop.
  session?: { running: boolean } | null; // Set in a session: the agent is fixed.
  shortcut?: boolean; // Ctrl+Shift+. opens the picker (rule C17).
  onRequestModels: () => void; // A connection can change at any time: the picker asks again when it opens.
  onRequestAgents: () => void;
  onSelect: (spec: string) => void; // A model of the built-in loop. Start screen: the built-in loop also becomes the agent.
  onAgentMessages?: (messages: ClientMessage[]) => void; // Start screen: a choice in an ACP tab.
  onSessionModel?: (model: string) => void; // An ACP session: acp.model.
  onSessionEffort?: (effort: string) => void; // An ACP session: acp.effort.
  // A session: switch the agent of the session (session.agent, as the portable handoff of T3 Code, the user asked for
  // this). model: a "provider/model" spec for Harness, a model id of an ACP agent, or null for the default.
  onSwitchAgent?: (agent: string, model: string | null) => void;
  onManageProviders: () => void; // Opens the Providers page.
  onManageAgents: () => void; // Opens Settings > Agents.
}) {
  const inSession = !!session;
  const currentId = current?.id ?? BUILTIN_AGENT;
  const [open, setOpen] = useState(false);
  const [tabId, setTabId] = useState(currentId);
  const [query, setQuery] = useState("");
  const [more, setMore] = useState(false); // "Show more": all the rows of the tab.
  const [favorites, setFavorites] = useState<string[]>(() => parseFavorites(loadPref(FAVORITES_PREF, "[]")));
  const [hot, setHot] = useState<PickRow | null>(null); // The row under the pointer or with the focus.
  const [picked, setPicked] = useState<Record<string, string | null>>({}); // A level that the daemon did not confirm yet.
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useOverlay(open);

  const close = () => setOpen(false);

  const selectTab = (id: string) => {
    setTabId(id);
    setQuery("");
    setMore(false);
    setHot(null);
  };

  const show = () => {
    selectTab(currentId);
    setPicked({});
    setFavorites(parseFavorites(loadPref(FAVORITES_PREF, "[]"))); // The other prompt box can change them.
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
  const favTab = tabId === FAVORITES_TAB;
  const tab = tabs.find((t) => t.id === (favTab ? currentId : tabId)) ?? tabs[0];
  const agentTab = favTab ? null : tab;

  // Start screen: an agent with no known models gets a model check, so the user can choose the model before the
  // first session (the user asked for this). The daemon starts the agent with no prompt (agents.models).
  // "waiting": the request went, and no list with "probing" came yet: the loading line shows at once.
  const asked = useRef(new Set<string>());
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const item = agentTab?.item;
    if (!open || inSession || !item || item.custom || item.models.length > 0 || item.probing || !agentReady(item)) return;
    if (asked.current.has(item.id)) return;
    asked.current.add(item.id);
    setWaiting((w) => new Set(w).add(item.id));
    onAgentMessages?.([{ type: "agents.models", id: item.id }]);
  }, [open, inSession, agentTab?.item, onAgentMessages]);
  useEffect(() => {
    // The daemon took the request (probing), or the models came: the list shows the state from now on.
    const done = [...waiting].filter((id) => agents?.some((a) => a.id === id && (a.probing || a.models.length > 0)));
    if (done.length) setWaiting((w) => new Set([...w].filter((id) => !done.includes(id))));
  }, [agents, waiting]);
  // In a session the other agents can be chosen (a switch of the agent), but not while a turn runs.
  const lockedTo = inSession && (!onSwitchAgent || !!session?.running) ? currentId : null;
  const usable = tabs.filter((t) => lockedTo === null || t.id === lockedTo);
  const local = localProviders ?? new Set<string>();
  const providerItems = models?.items ?? [];
  const searching = query.trim() !== "";
  const tabOf = (row: PickRow) => tabs.find((t) => t.id === row.agent) ?? tab;
  const checkedRow = (row: PickRow) => rowChecked(row, tabOf(row), value);

  const groupsOf = (t: AgentTab, all: boolean): PickGroup[] =>
    t.id === BUILTIN_AGENT ? builtinGroups(models, allowDefault, local, all)
      : agentGroups(t, inSession ? [] : providerItems, !inSession || t.id !== currentId);
  let shown: PickGroup[];
  let hidden = 0;
  if (searching) {
    shown = usable.flatMap((t) => searchGroups(groupsOf(t, true), query.trim()));
  } else if (favTab) {
    // In a session, only the favorites of the agent of the session can be chosen.
    const favRows = favoriteRows(favorites, usable.flatMap((t) => groupsOf(t, true)));
    shown = favRows.length ? [{ key: "favorites", heading: null, searchHeading: "Favorites", rows: favRows }] : [];
  } else {
    const all = groupsOf(tab, false);
    const first = firstRows(all, SHOW_FIRST, checkedRow);
    hidden = first.hidden;
    shown = more ? all : first.groups;
  }
  const rows = shown.flatMap((g) => g.rows);
  const sessionBusy = inSession && currentId !== BUILTIN_AGENT && !!session?.running;
  const rowOff = (row: PickRow) => sessionBusy && row.agent !== BUILTIN_AGENT;

  // The focus goes to the current row when the picker opens or the tab changes. It stays in the search field.
  useEffect(() => {
    if (!open || document.activeElement === searchRef.current) return;
    const list = ref.current?.querySelector(".ap-list");
    (list?.querySelector<HTMLButtonElement>('.ap-row-main[aria-checked="true"]:not(:disabled)') ??
      list?.querySelector<HTMLButtonElement>(".ap-row-main:not(:disabled)") ??
      searchRef.current)?.focus();
  }, [open, tabId, models !== null, agents !== null]);

  const choose = (row: PickRow) => {
    close();
    const t = tabOf(row);
    if (inSession && row.agent !== currentId) {
      // Another agent: the session switches to it, with a handoff of the conversation.
      const model = row.agent === BUILTIN_AGENT ? row.value || null : row.kind === "native" ? row.value : null;
      onSwitchAgent?.(row.agent, model);
      return;
    }
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

  const toggleStar = (row: PickRow) => {
    const next = toggleFavorite(favorites, favoriteKey(row.agent, row.value));
    setFavorites(next);
    savePref(FAVORITES_PREF, JSON.stringify(next));
  };

  const switchTab = (step: number) => {
    if (inSession) return;
    const ids = [FAVORITES_TAB, ...tabs.map((t) => t.id)];
    const at = ids.indexOf(tabId);
    selectTab(ids[(at + step + ids.length) % ids.length]);
  };

  // The model name of an agent now, for the heading of the Reasoning column.
  const builtinFallback = models?.default ? modelName(models.default) : null;
  const builtinName = value ? modelName(value) : builtinFallback ?? "Default model";
  const modelOf = (agentId: string): string => {
    if (agentId === BUILTIN_AGENT) return builtinName;
    const t = tabs.find((x) => x.id === agentId);
    if (!t) return "";
    if (t.nativeModel) return t.models.find((m) => m.id === t.nativeModel)?.name ?? t.nativeModel;
    if (t.providerModel) return modelName(t.providerModel);
    return "Default";
  };

  const reasoningOf = (agentId: string | null): Reasoning => {
    if (agentId === null) return { kind: "note", note: "Select a model to see its reasoning levels." };
    if (agentId === BUILTIN_AGENT) {
      const now = effort?.value ?? DEFAULT_EFFORT;
      return {
        kind: "levels",
        agent: agentId,
        levels: EFFORT_LEVELS.map((l) => ({ id: l.value, name: l.label, description: "" })),
        defaultId: DEFAULT_EFFORT,
        currentId: now,
        help: EFFORT_HELP,
        disabled: !effort,
        pick: (id) => {
          if (effort && id !== now) effort.onChange(id as Effort);
        },
      };
    }
    const t = tabs.find((x) => x.id === agentId);
    if (inSession && agentId !== currentId) {
      return { kind: "note", note: `Choose a model of ${t?.name ?? "the agent"} to switch this session to it. Then choose its reasoning.` };
    }
    if (!t?.efforts?.length) return { kind: "note", note: `${t?.name ?? "The agent"} chooses its own reasoning.` };
    const levels = resolveEfforts(t.efforts, t.id in picked ? picked[t.id] : t.effort);
    return {
      kind: "levels",
      agent: agentId,
      ...levels,
      disabled: inSession ? sessionBusy || !onSessionEffort : !onAgentMessages,
      pick: (id) => {
        if (id === levels.currentId) return;
        const sent = effortValue(id, levels, inSession);
        if (inSession) onSessionEffort?.(sent ?? id);
        else onAgentMessages?.([{ type: "harnesses.native_effort", id: t.id, effort: sent }]);
        setPicked((p) => ({ ...p, [t.id]: sent }));
      },
    };
  };

  // The Reasoning column shows the agent of the tab. In the search results and the Favorites tab: the agent of the
  // row under the pointer (or with the focus), else of the current model.
  const hotRow = hot && rows.some((r) => r.key === hot.key) ? hot : null;
  const favCurrent = favTab ? (rows.find((r) => r.agent === currentId && checkedRow(r)) ?? rows.find(checkedRow) ?? null) : null;
  const focusRow = searching || favTab ? (hotRow ?? favCurrent) : null;
  const reasonAgent = searching || favTab ? (focusRow?.agent ?? (searching ? tab.id : null)) : tab.id;
  const reasonModel = focusRow ? focusRow.label : reasonAgent ? modelOf(reasonAgent) : "";
  const reasoning = reasoningOf(reasonAgent);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const target = e.target as HTMLElement;
    const inSearch = target === searchRef.current;
    const inRail = !!target.closest(".agent-picker-rail");
    const inReason = !!target.closest(".ap-reason");
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      switchTab(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // Ctrl+1 to Ctrl+9 select a row, also from the search field.
    const n = ctrlDigit(e.nativeEvent);
    if (n !== null) {
      const row = rows[n - 1];
      if (row) {
        e.preventDefault();
        if (!rowOff(row)) choose(row);
      }
      return;
    }
    if (inSearch && e.key === "Enter") {
      e.preventDefault();
      const first = rows.find((r) => !rowOff(r));
      if (first) choose(first);
      return;
    }
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    // A letter or a digit typed in the picker goes to the search field.
    if (!inSearch && !inRail && plain && e.key.length === 1 && e.key !== " ") {
      e.preventDefault();
      setQuery((q) => q + e.key);
      searchRef.current?.focus();
      return;
    }
    const all = (selector: string) => [...(ref.current?.querySelectorAll<HTMLElement>(selector) ?? [])].filter(visible);
    // Right goes to the Reasoning column, and Left goes back to the list.
    if (e.key === "ArrowRight" && !inSearch && !inRail && !inReason) {
      const levels = all(".ap-reason .ap-level:not(:disabled)");
      const to = levels.find((b) => b.getAttribute("aria-checked") === "true") ?? levels[0];
      if (to) {
        e.preventDefault();
        to.focus();
      }
      return;
    }
    if (e.key === "ArrowLeft" && inReason) {
      e.preventDefault();
      const list = all(".ap-list .ap-row-main:not(:disabled)");
      (list.find((b) => b.getAttribute("aria-checked") === "true") ?? list[0] ?? searchRef.current)?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = inRail
      ? all(".agent-picker-rail button")
      : inReason
        ? all(".ap-reason .ap-level:not(:disabled)")
        : all(".ap-mid .ap-nav:not(:disabled)");
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  // The chip.
  const builtinCurrent = currentId === BUILTIN_AGENT;
  const currentTab = tabs.find((t) => t.id === currentId);
  const shownEffort = builtinCurrent
    ? effort
      ? effortLabel(effort.value)
      : null
    : effortChipName(currentTab?.efforts, currentTab && currentTab.id in picked ? picked[currentTab.id] : currentTab?.effort);
  const chipName = current ? agentChipLabel(current, inSession) : builtinName;
  const keyTip = shortcut ? " (Ctrl+Shift+.)" : "";
  const chipTip = current
    ? inSession
      ? `${current.name} runs this session through ACP. Click to see its models${keyTip}`
      : `New sessions run in ${current.name} through ACP. Click to choose the agent and the model${keyTip}`
    : value
      ? `The model: ${value}${shownEffort ? `, effort ${shownEffort}` : ""}. Click to choose the agent and the model${keyTip}`
      : builtinFallback
        ? `The default model: ${models!.default}. Click to choose the agent and the model${keyTip}`
        : `The default model of the daemon. Click to choose the agent and the model${keyTip}`;

  const rowView = (row: PickRow) => {
    const t = tabOf(row);
    const checked = checkedRow(row);
    const key = rowKeyLabel(rows.indexOf(row));
    const fav = favorites.includes(favoriteKey(row.agent, row.value));
    return (
      <div key={row.key} className={`ap-row${checked ? " current" : ""}`} role="none" onMouseEnter={() => setHot(row)} onFocus={() => setHot(row)}>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={checked}
          className="ap-row-main ap-nav"
          disabled={rowOff(row)}
          title={row.sub}
          onClick={() => choose(row)}
        >
          <AgentIcon id={row.agent} name={t.name} icon={t.item?.icon} size={16} />
          <span className="ap-row-name">{row.label}</span>
          {checked && <Check size={14} className="ap-row-check" aria-label="Current model" />}
          {row.detail && <span className="ap-row-detail">{row.detail}</span>}
        </button>
        {row.kind === "default" ? (
          <span className="ap-star-space" aria-hidden />
        ) : (
          <button
            type="button"
            className={`ap-star${fav ? " on" : ""}`}
            aria-pressed={fav}
            aria-label={fav ? "Remove from favorites" : "Add to favorites"}
            title={fav ? "Remove from favorites" : "Add to favorites"}
            onClick={() => toggleStar(row)}
          >
            <Star size={14} fill={fav ? "currentColor" : "none"} aria-hidden />
          </button>
        )}
        <kbd className={`ap-key${key ? "" : " none"}`} aria-hidden={!key}>
          {key}
        </kbd>
      </div>
    );
  };

  const groupList = (groups: PickGroup[]) =>
    groups.map((g) => (
      <div key={g.key} className="ap-group" role="group" aria-label={g.heading ?? g.searchHeading}>
        {g.heading && <div className="menu-heading ap-heading">{g.heading}</div>}
        {g.rows.map(rowView)}
      </div>
    ));

  const moreButton = () =>
    hidden > 0 && (
      <button type="button" className="ap-more ap-nav" aria-expanded={more} onClick={() => setMore((m) => !m)}>
        {more ? "Show less" : "Show more"}
      </button>
    );

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
        {moreButton()}
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
            <button type="button" className="agent-picker-link ap-nav" onClick={() => { close(); onManageAgents(); }}>
              Open agent settings
            </button>
          </p>
        )}
        {sessionBusy && <p className="menu-note">The agent changes the model only between turns.</p>}
        {groupList(shown)}
        {moreButton()}
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

  const levelTip = (l: AgentModel) => l.description || undefined;

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
              <button
                type="button"
                role="tab"
                aria-selected={favTab}
                aria-label="Favorites"
                className={`agent-picker-tab ap-fav-tab${favTab && !searching ? " selected" : ""}`}
                title="Favorites"
                onClick={() => selectTab(FAVORITES_TAB)}
              >
                <Star size={18} aria-hidden />
              </button>
              <div className="ap-rail-sep" aria-hidden />
              {tabs.map((t) => {
                const locked = lockedTo !== null && t.id !== lockedTo;
                const notReady = t.item !== null && !agentReady(t.item);
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={t.id === tabId}
                    aria-disabled={locked || undefined}
                    className={`agent-picker-tab${t.id === tabId && !searching ? " selected" : ""}${notReady ? " not-ready" : ""}`}
                    title={tabTip(t, lockedTo)}
                    onClick={() => {
                      if (!locked) selectTab(t.id);
                    }}
                  >
                    <AgentIcon id={t.id} name={t.name} icon={t.item?.icon} size={22} />
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
          <div className="agent-picker-main ap-mid">
            <div className="agent-picker-search ap-search">
              <Search size={15} aria-hidden />
              <input
                ref={searchRef}
                className="ap-nav"
                type="text"
                value={query}
                placeholder="Search models..."
                aria-label="Search models"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHot(null);
                }}
              />
            </div>
            <div className="agent-picker-list ap-list">
              {searching ? (
                rows.length ? groupList(shown) : <p className="menu-note">No model matches "{query.trim()}".</p>
              ) : favTab ? (
                rows.length ? groupList(shown) : <p className="menu-note">No favorites yet. Select the star of a model.</p>
              ) : tab.id === BUILTIN_AGENT ? (
                builtinBody()
              ) : (
                agentBody(tab)
              )}
            </div>
            {/* A narrow picker has no Reasoning column: the levels show as chips under the list. */}
            <div className="ap-reason-chips" role="group" aria-label="Reasoning">
              <span className="ap-reason-chips-label">Reasoning</span>
              {reasoning.kind === "levels" ? (
                reasoning.levels.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={reasoning.currentId === l.id}
                    className={`ap-chip ap-nav${reasoning.currentId === l.id ? " on" : ""}`}
                    disabled={reasoning.disabled}
                    title={levelTip(l)}
                    onClick={() => reasoning.pick(l.id)}
                  >
                    {l.name}
                    {reasoning.defaultId === l.id && l.id !== DEFAULT_LEVEL && <span className="ap-chip-default"> · Default</span>}
                  </button>
                ))
              ) : (
                <span className="ap-reason-chips-note">{reasoning.note}</span>
              )}
            </div>
            {tab.id === BUILTIN_AGENT && !searching && !favTab && (
              <div className="ap-foot">
                <button type="button" className="agent-picker-link ap-nav" onClick={() => { close(); onManageProviders(); }}>
                  Show providers
                </button>
              </div>
            )}
          </div>
          <div className="ap-reason" role="group" aria-label="Reasoning">
            <div className="ap-reason-head">
              <span className="ap-reason-title">Reasoning</span>
              <span className="ap-reason-model" title={reasonModel || undefined}>
                {reasonModel}
              </span>
            </div>
            <div className="ap-reason-list">
              {reasoning.kind === "levels" ? (
                reasoning.levels.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={reasoning.currentId === l.id}
                    className="ap-level"
                    disabled={reasoning.disabled}
                    title={levelTip(l)}
                    onClick={() => reasoning.pick(l.id)}
                  >
                    <span className="ap-level-name">{l.name}</span>
                    <span className="ap-level-end">
                      {reasoning.defaultId === l.id && l.id !== DEFAULT_LEVEL && <span className="ap-level-default">Default</span>}
                      {reasoning.currentId === l.id && <Check size={14} className="ap-row-check" aria-hidden />}
                    </span>
                  </button>
                ))
              ) : (
                <p className="ap-reason-note">{reasoning.note}</p>
              )}
            </div>
            {reasoning.kind === "levels" && reasoning.help && <p className="ap-reason-help">{reasoning.help}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
