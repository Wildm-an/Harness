import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Bug,
  ChevronRight,
  EllipsisVertical,
  Globe,
  LoaderCircle,
  Monitor,
  PictureInPicture2,
  Power,
  RotateCw,
  Smartphone,
  SquareDashedMousePointer,
  Tablet,
} from "lucide-react";
import type { AgentFrame, Decision, ServerItem } from "../daemon/protocol";
import { PaneActions, PaneHeader } from "../layout/Workspace";
import { WindowTabs } from "../layout/WindowTabs";
import { withMoved } from "../lib/tabDrag";
import { setNativeRect, useOverlay, useOverlayOpen } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";
import { useLinksInPane } from "../lib/openLink";
import { browserView, isTauri, openExternal, pickFile, pickSavePath, type Bounds } from "../lib/tauri";
import { ServerMenu } from "../servers/ServerMenu";
import type { ServersApi } from "../servers/useServers";
import { ServerBlock, type ServerApproval } from "./ServerBlock";
import { COLORS, SHAPES, WIDTHS, annotateCall, annotateScript, pageMessage, parseAnnotation, type AnnotateMethod, type AnnotateTool, type Annotation, type ShapeTool } from "./annotate";
import { AnnotateBar } from "./AnnotateBar";
import { imageToDataUrl } from "../lib/images";

type Device = "desktop" | "tablet" | "phone";

// The sizes of the Claude Code preview. "Responsive" uses the full pane. The menu uses this order.
const DEVICES: Record<Device, { label: string; icon: typeof Monitor; size?: { width: number; height: number } }> = {
  desktop: { label: "Responsive", icon: Monitor },
  phone: { label: "Mobile", icon: Smartphone, size: { width: 375, height: 812 } },
  tablet: { label: "Tablet", icon: Tablet, size: { width: 768, height: 1024 } },
};

const MAX_TABS = 12;

const SHAPES_BY_ID = new Set<string>(SHAPES.map((s) => s.id));

// The last shape, color, and line width of the annotation bar, for the next time.
let lastBar: { shape: ShapeTool; color: string; width: number } = { shape: "rect", color: COLORS[0][0], width: WIDTHS[1][0] };

/** Adds "http://" to an address with no scheme. Keeps "about:blank" and file: addresses. */
export function normalizeAddress(text: string): string {
  const t = text.trim();
  if (!t) return "about:blank";
  if (/^(https?:|about:|file:)/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  return `https://${t}`;
}

/** The webview bounds for a device inside the pane area. */
/** The longest wait (ms) for the still picture of the page before the webview hides for an overlay. */
const STILL_WAIT = 600;

export function deviceBounds(area: Bounds, device: Device): Bounds {
  const size = DEVICES[device].size;
  if (!size) return area;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return { x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height };
}

/** The file: URL of a path of this computer, for "Open HTML file". */
export function fileUrl(path: string): string {
  const p = path.replace(/\\/g, "/");
  return `file://${p.startsWith("/") ? "" : "/"}${encodeURI(p)}`;
}

/** How long the browser keeps its cookies and storage. */
export type KeepCookies = "always" | "quit" | "server";
const KEEP_COOKIES: Record<KeepCookies, string> = {
  always: "Always",
  quit: "Until quit",
  server: "Until a server restarts",
};

/** The "Keep cookies" choice. The old switch "Keep cookies when a server restarts: off" is "server". */
export function keepCookies(): KeepCookies {
  const value = loadPref("browserKeepCookies", "");
  if (value === "always" || value === "quit" || value === "server") return value;
  return loadPref("browserKeepData", "true") === "false" ? "server" : "always";
}

// "Until quit": the first webview after a start of the app clears the old cookies and storage.
let clearedThisRun = false;

export interface BrowserTab {
  id: string; // Also the label of its webview: "browser-<id>".
  url: string | null; // null: a new tab with no page.
  address: string; // The text of the address bar.
  title: string; // The page title. Empty until the page gives one.
  loading: boolean;
  frame: number; // The iframe key outside the desktop app. A change reloads the page.
  agent?: string; // Old versions: the session of an agent tab. A tab of the agent is now a normal tab.
  owner?: string; // The session that the tab belongs to ("" for the start screen). The agent and the user share its tabs.
}

/** The session of a tab. Each session shows only its own tabs (the user asked for this). */
export function ownerOf(tab: BrowserTab): string {
  return tab.agent ?? tab.owner ?? "";
}

/** The tabs of one session, and the tab that it shows: its last active tab, else its first tab. */
export function sessionTabs(tabs: BrowserTab[], session: string, active: Record<string, string>): { mine: BrowserTab[]; shown: BrowserTab | undefined } {
  const mine = tabs.filter((t) => ownerOf(t) === session);
  return { mine, shown: mine.find((t) => t.id === active[session]) ?? mine[0] };
}

let tabCounter = 0;
export function newTab(url: string | null = null): BrowserTab {
  const id = `t${Date.now().toString(36)}${(tabCounter++).toString(36)}`;
  return { id, url, address: url ?? "", title: "", loading: false, frame: 0 };
}

/** The label of a tab: the page title, else the host of the page, else "New tab". */
export function tabLabel(tab: BrowserTab): string {
  if (tab.title.trim()) return tab.title.trim();
  if (!tab.url || tab.url === "about:blank") return "New tab";
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}

// The tabs stay when the pane closes: the next time it opens, it shows the same pages. The webviews
// of the tabs stay too (hidden), so a page keeps its state. "active": the shown tab of each session.
// All sessions use one browser engine with the same cookies. Only the tab lists are separate, so a
// session costs no more memory than its own tabs.
let kept: { tabs: BrowserTab[]; active: Record<string, string> } | null = null;
const opened = new Set<string>(); // The tabs that have a webview.
let handledRequest = 0; // The key of the last navigation request from the app. It stays when the pane closes.

// A new page of the app has no tabs yet. Webviews from an earlier page (a reload) must go.
if (isTauri()) void browserView.closeAll().catch(() => undefined);

// -- The tabs of the agent -------------------------------------------------------------------------
// The agent and the user use the same tabs of the session (the user asked for this). The agent lists
// them (Harness.listTabs), continues in a tab of the user (Harness.useTab), or opens a new tab
// (Harness.newTab). "agentTabs" is the tab that the agent works in now. All tabs share the cookies, so the agent
// is signed in where the user is. While the agent works, a tab that the pane does not show is
// "parked": it moves out of sight with a real size and stays visible, so the page keeps drawing.
// The agent can then take its screenshots, and the session rail shows the page live.

const AGENT_IDLE = 60_000; // ms with no agent call before a parked tab hides.
const AGENT_ACTIVE = 15_000; // ms after an agent call: the session rail shows the outline of the page.
const agentUsed = new Map<string, number>(); // Tab id -> the time of the last agent call, while it is new.
const agentTabs = new Map<string, string>(); // Session id -> tab id.
const agentInfo = new Map<string, { session: string; last: number; url: string; title: string }>(); // By tab id.
const parked = new Set<string>();
// Tabs that the user minimized to the session rail: they stay parked and live (the rail shows them)
// until the pane shows them again or the user closes them.
const minimized = new Set<string>();
// Agent tabs that the session rail does not show: the user closed the Browser pane with its X. The
// next agent call in the tab shows it in the rail again.
const railHidden = new Set<string>();
const creating = new Map<string, Promise<string>>(); // Session id -> the tab that opens now.
const agentListeners = new Set<() => void>();
let shown: string | null = null; // The tab that the pane shows now.
let parkSize = { width: 1280, height: 800 }; // The last size of the pane area.
let agentTimer = 0;
let agentEvents = false;
// The open pane: it adds and shows the agent tabs. With no pane, the tabs go into "kept".
let paneHooks: {
  add: (tab: BrowserTab) => void;
  activate: (id: string) => void;
  has: (id: string) => boolean;
  resync: (id: string) => void;
  close: (id: string) => void;
  list: () => { tabs: BrowserTab[]; active: Record<string, string> };
} | null = null;

/** All tabs, and the shown tab of each session: from the open pane, else from "kept". */
function allTabs(): { tabs: BrowserTab[]; active: Record<string, string> } {
  return paneHooks ? paneHooks.list() : (kept ?? { tabs: [], active: {} });
}

function agentChanged() {
  agentListeners.forEach((listener) => listener());
}

function agentLive(id: string): boolean {
  if (minimized.has(id)) return true;
  const info = agentInfo.get(id);
  return !!info && Date.now() - info.last < AGENT_IDLE;
}

/** Calls ``listener`` when an agent tab opens, closes, changes its page, or starts or stops work. */
export function onAgentBrowser(listener: () => void): () => void {
  agentListeners.add(listener);
  return () => agentListeners.delete(listener);
}

/** The agent made a call in the tab a short time ago: it uses the page now. */
function agentUsedLately(id: string): boolean {
  const time = agentUsed.get(id);
  return time !== undefined && Date.now() - time < AGENT_ACTIVE;
}

/**
 * The agent tab of a session. ``live``: the agent used it in the last minute, or the user minimized
 * it to the rail. ``agent``: the agent made a call in it in the last seconds.
 */
export function agentBrowserOf(session: string | null | undefined): { tab: string; live: boolean; agent: boolean; url: string; title: string } | null {
  const tab = session ? agentTabs.get(session) : undefined;
  const info = tab ? agentInfo.get(tab) : undefined;
  if (!tab || !info || !opened.has(tab) || railHidden.has(tab)) return null;
  return { tab, live: agentLive(tab), agent: agentUsedLately(tab), url: info.url, title: info.title };
}

/** The tabs of a session, for the tab menu of the session rail. ``rail``: the tab that the rail shows. */
export function browserTabsOf(session: string): { id: string; label: string; rail: boolean }[] {
  const { tabs, active } = allTabs();
  return sessionTabs(tabs, session, active).mine.map((t) => ({ id: t.id, label: tabLabel(t), rail: agentTabs.get(session) === t.id }));
}

/** The session rail shows another tab of the session (its tab menu). false: the tab has no page yet. */
export function showTabInRail(session: string, id: string): boolean {
  const old = agentTabs.get(session);
  if (!minimizeTab(session, id)) return false;
  if (old && old !== id) minimized.delete(old); // The old tab hides when the agent does not use it.
  return true;
}

/** A small live picture of an agent tab, for the session rail. */
export async function captureAgentTab(tab: string): Promise<string> {
  const result = await browserView.cdp(tab, "Page.captureScreenshot", { format: "jpeg", quality: 45 }, 5_000);
  return `data:image/jpeg;base64,${String(result.data ?? "")}`;
}

/** The tab is open in the Browser pane (or in the saved tabs of a closed pane). */
export function hasTab(id: string): boolean {
  return tabExists(id);
}

/** Show a tab in its session. The app opens the pane. false: the tab is closed. */
export function showTab(id: string): boolean {
  const tab = allTabs().tabs.find((t) => t.id === id);
  if (!tab) return false;
  if (paneHooks) paneHooks.activate(id);
  else if (kept) kept = { ...kept, active: { ...kept.active, [ownerOf(tab)]: id } };
  return true;
}

/** Close a tab, as its close button does. With no pane, the saved tabs lose it. */
export function closeTabById(id: string): void {
  if (paneHooks?.has(id)) {
    paneHooks.close(id);
    return;
  }
  if (opened.delete(id)) void browserView.close(id).catch(() => undefined);
  dropAgentTab(id);
  if (kept) {
    const tab = kept.tabs.find((t) => t.id === id);
    const active = { ...kept.active };
    if (tab && active[ownerOf(tab)] === id) delete active[ownerOf(tab)];
    kept = { tabs: kept.tabs.filter((t) => t.id !== id), active };
  }
}

/** Show the agent tab of a session in the pane. The app opens the pane. */
export function showAgentTab(session: string): void {
  const tab = agentTabs.get(session);
  if (!tab) return;
  if (paneHooks) paneHooks.activate(tab);
  else if (kept?.tabs.some((t) => t.id === tab)) kept = { ...kept, active: { ...kept.active, [session]: tab } };
}

function parkBounds(): Bounds {
  return { x: -(parkSize.width + 200), y: 0, width: parkSize.width, height: parkSize.height };
}

async function park(id: string): Promise<void> {
  if (shown === id) return;
  parked.add(id);
  await browserView.bounds(id, parkBounds());
  await browserView.visible(id, true);
}

function tabExists(id: string): boolean {
  return paneHooks ? paneHooks.has(id) : !!kept?.tabs.some((t) => t.id === id);
}

function watchAgentTabs() {
  if (!agentEvents) {
    agentEvents = true;
    void browserView.onEvent((event) => {
      const info = agentInfo.get(event.id);
      if (!info) return;
      if (event.title !== undefined) info.title = event.title;
      else if (!event.loading) info.url = event.url;
      // With no pane, the saved tab gets the page too: the pane shows it when it opens.
      if (!paneHooks && kept) {
        const change: Partial<BrowserTab> = event.title !== undefined ? { title: event.title } : event.loading ? {} : { url: event.url, address: event.url, loading: false };
        kept = { ...kept, tabs: kept.tabs.map((t) => (t.id === event.id ? { ...t, ...change } : t)) };
      }
      agentChanged();
    });
  }
  if (agentTimer) return;
  // A parked tab hides one minute after the last agent call. The rail stops its live picture.
  agentTimer = window.setInterval(() => {
    let changed = false;
    // The agent made no call for some seconds: the rail removes the outline of the page.
    for (const id of [...agentUsed.keys()]) {
      if (!agentUsedLately(id)) {
        agentUsed.delete(id);
        changed = true;
      }
    }
    for (const [id, info] of agentInfo) {
      if (minimized.has(id) || info.last === 0 || Date.now() - info.last < AGENT_IDLE) continue;
      info.last = 0; // Not live now. The change shows one time.
      changed = true;
      if (parked.has(id) && shown !== id) {
        parked.delete(id);
        void browserView.visible(id, false).catch(() => undefined);
      }
    }
    if (changed) agentChanged();
  }, 5_000);
}

/** The tabs of a session for the agent (Harness.listTabs). */
function listTabs(session: string): { id: string; url: string | null; title: string; shown: boolean; used: boolean }[] {
  const { tabs, active } = allTabs();
  const { mine, shown: shownTab } = sessionTabs(tabs, session, active);
  return mine.map((t) => ({
    id: t.id,
    url: t.url && t.url !== "about:blank" ? t.url : null,
    title: t.title,
    shown: t.id === shownTab?.id,
    used: agentTabs.get(session) === t.id,
  }));
}

/** The agent works in an open tab of its session (Harness.useTab). A tab with no webview gets one, out of sight. */
async function useTab(session: string, id: string): Promise<string> {
  const tab = allTabs().tabs.find((t) => t.id === id && ownerOf(t) === session);
  if (!tab) throw new Error(`The session has no tab ${id}. Use an id from preview_tabs, or "new".`);
  watchAgentTabs();
  agentTabs.set(session, id);
  agentInfo.set(id, { session, last: Date.now(), url: tab.url ?? "about:blank", title: tab.title });
  if (!opened.has(id)) {
    opened.add(id);
    parked.add(id);
    await browserView.open(id, tab.url ?? "about:blank", parkBounds(), false);
    paneHooks?.resync(id);
  }
  agentChanged();
  return id;
}

/** The tab that the agent of a session works in. With no tab yet: the shown tab of the session when it
 * has no page, else a new tab, out of sight. ``fresh``: always a new tab (Harness.newTab). */
async function agentTabFor(session: string, fresh = false): Promise<string> {
  const known = agentTabs.get(session);
  if (!fresh && known && opened.has(known) && tabExists(known)) return known;
  if (!fresh) {
    const blank = listTabs(session).find((t) => t.shown && !t.url);
    if (blank) return useTab(session, blank.id);
  }
  const pending = creating.get(session);
  if (pending) return pending;
  const make = (async () => {
    watchAgentTabs();
    const tab: BrowserTab = { ...newTab("about:blank"), owner: session };
    if (paneHooks) paneHooks.add(tab);
    else kept = kept ? { ...kept, tabs: [...kept.tabs, tab] } : { tabs: [tab], active: { [session]: tab.id } };
    agentTabs.set(session, tab.id);
    agentInfo.set(tab.id, { session, last: Date.now(), url: "about:blank", title: "" });
    opened.add(tab.id);
    parked.add(tab.id);
    const fresh = keepCookies() === "quit" && !clearedThisRun;
    clearedThisRun = true;
    try {
      await browserView.open(tab.id, "about:blank", parkBounds(), fresh);
    } catch (e) {
      opened.delete(tab.id);
      parked.delete(tab.id);
      agentInfo.delete(tab.id);
      agentTabs.delete(session);
      throw e;
    }
    paneHooks?.resync(tab.id); // The pane can show it already.
    agentChanged();
    return tab.id;
  })();
  creating.set(session, make);
  try {
    return await make;
  } finally {
    creating.delete(session);
  }
}

/**
 * Run a DevTools protocol call of the agent of a session in its tab (the daemon sends browser.call).
 * A navigation shows the agent tab in the open pane: the agent takes the browser for its work.
 */
export async function runAgentCall(session: string, method: string, params: unknown, timeoutMs: number): Promise<{ tab: string; result: Record<string, unknown> }> {
  if (!isTauri()) throw new Error("This client cannot host the agent browser.");
  // The tabs of the session: the client answers these calls itself.
  if (method === "Harness.listTabs") return { tab: agentTabs.get(session) ?? "", result: { tabs: listTabs(session) } };
  if (method === "Harness.useTab") {
    const id = await useTab(session, String((params as { id?: unknown } | null)?.id ?? ""));
    return { tab: id, result: { id } };
  }
  if (method === "Harness.newTab") {
    const id = await agentTabFor(session, true);
    return { tab: id, result: { id } };
  }
  const tab = await agentTabFor(session);
  const info = agentInfo.get(tab);
  const wasLive = agentLive(tab);
  const wasUsed = agentUsedLately(tab);
  if (info) info.last = Date.now();
  agentUsed.set(tab, Date.now());
  const back = railHidden.delete(tab); // The agent works in the tab again: the rail shows it.
  if (shown !== tab && !parked.has(tab)) await park(tab);
  if (method === "Page.navigate") paneHooks?.activate(tab);
  if (!wasLive || !wasUsed || back) agentChanged();
  return { tab, result: await browserView.cdp(tab, method, params, timeoutMs) };
}

/**
 * "Minimize": the session rail shows a small live view of the tab, as the agent tab. The tab must
 * have a webview (desktop app). The pane shows it again after a click on the view in the rail.
 */
export function minimizeTab(session: string, id: string): boolean {
  if (!opened.has(id)) return false;
  const tab = allTabs().tabs.find((t) => t.id === id);
  watchAgentTabs();
  minimized.add(id);
  railHidden.delete(id);
  agentTabs.set(session, id);
  agentInfo.set(id, { session, last: Date.now(), url: tab?.url ?? "about:blank", title: tab?.title ?? "" });
  agentChanged();
  return true;
}

/** "Minimize" of the tab that the pane shows now (a double-click on the divider next to the pane). */
export function minimizeShownTab(session: string): void {
  if (shown) minimizeTab(session, shown);
}

/**
 * The X of the Browser pane: the session rail stops its view of the agent tab of the session (the user
 * asked for this). The tab stays open, and the agent can go on in it. Its next call shows it again.
 */
export function hideRailBrowser(session: string): void {
  const tab = agentTabs.get(session);
  if (!tab) return;
  minimized.delete(tab);
  railHidden.add(tab);
  agentChanged();
}

/** Forget the agent tab when the user closes it. The next agent call opens a new one. */
function dropAgentTab(id: string) {
  minimized.delete(id);
  railHidden.delete(id);
  agentUsed.delete(id);
  const info = agentInfo.get(id);
  if (!info) return;
  agentInfo.delete(id);
  parked.delete(id);
  if (agentTabs.get(info.session) === id) agentTabs.delete(info.session);
  agentChanged();
}

/** Clear the cookies and storage of the browser. All tabs share them, so any open tab can do it. */
export async function clearBrowserData(): Promise<void> {
  const id = opened.values().next().value;
  if (id) await browserView.clearData(id);
}

/** A row of the More menu that opens a list of choices on its left side. */
function SubMenu<T extends string>({ label, value, choices, open, onOpen, onPick }: {
  label: string;
  value: T;
  choices: Record<T, string>;
  open: boolean;
  onOpen: (open: boolean) => void;
  onPick: (value: T) => void;
}) {
  return (
    <div className="browser-submenu" onMouseEnter={() => onOpen(true)} onMouseLeave={() => onOpen(false)}>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            onOpen(true);
          }
        }}
      >
        <span className="side-filter-label">{label}</span>
        <span className="side-filter-value">{choices[value]}</span>
        <ChevronRight size={14} aria-hidden />
      </button>
      {open && (
        <div className="menu browser-submenu-list" role="menu" aria-label={label}>
          {(Object.keys(choices) as T[]).map((c) => (
            <button key={c} type="button" role="menuitemradio" aria-checked={value === c} onClick={() => onPick(c)}>
              <span className="side-filter-label">{choices[c]}</span>
              {value === c && <Check size={14} aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Menu({ children, label, icon }: { children: (close: () => void) => React.ReactNode; label: string; icon: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="browser-menu" ref={ref} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button type="button" className="icon-btn ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={label} aria-label={label}>
        {icon}
      </button>
      {open && (
        <div className="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function BrowserPane({
  session = null,
  request,
  serverApi,
  agentFrame,
  showAgent,
  onOpenServer,
  onOpenAgentPage,
  onError,
  onEmpty,
  autoVerify,
  onAutoVerify,
  onManageSites,
  onEditLaunch,
  serverApprovals,
  onDecide,
  onAnnotate,
  onScreenshot,
  onMinimize,
}: {
  session?: string | null; // The open session. The pane shows only its tabs. null: the start screen.
  request: { url: string; key: number } | null; // A navigation request from the app.
  serverApi: ServersApi; // The dev servers of the project (.harness/launch.json), as in the Claude app.
  agentFrame: (AgentFrame & { key: number }) | null; // The newest page of the headless agent browser.
  showAgent: number; // A change shows the headless agent page (the session rail asks for it).
  onOpenServer: (server: ServerItem) => void;
  onOpenAgentPage: (url: string) => void;
  onError: (message: string) => void;
  onEmpty: () => void; // The user closed the last tab: close the pane.
  autoVerify: boolean | null; // The "check the app after UI changes" setting of the project. null: no session.
  onAutoVerify: (on: boolean) => void;
  onManageSites: () => void; // The sites that the agent browser can open with no question.
  onEditLaunch: () => void; // Open .harness/launch.json. With no file, the empty tab makes it.
  serverApprovals: ServerApproval[]; // The questions before the first start of a server command.
  onDecide: (requestId: string, decision: Decision) => void;
  onAnnotate: (note: Annotation) => void; // A note on an element of the page: it goes into the prompt box.
  onScreenshot: (image: string, url: string) => void; // The page with the marks: it goes into the prompt box.
  onMinimize?: () => void; // "Minimize": close the pane and show the page in the session rail (the Code view).
}) {
  const tauri = isTauri();
  const area = useRef<HTMLDivElement>(null);
  const key = session ?? "";
  const keyRef = useRef(key);
  keyRef.current = key;
  const [tabs, setTabs] = useState<BrowserTab[]>(() => kept?.tabs ?? [{ ...newTab(), owner: key }]);
  const [actives, setActives] = useState<Record<string, string>>(() => kept?.active ?? {});
  const { mine, shown: shownTab } = sessionTabs(tabs, key, actives);
  // A session with no tab gets one new tab. The update runs before React shows this render.
  const fresh = useMemo(() => ({ ...newTab(), owner: key }), [key, mine.length === 0]);
  if (mine.length === 0) setTabs([...tabs, fresh]);
  const active = shownTab ?? fresh;
  const activeId = active.id;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const activesRef = useRef(actives);
  activesRef.current = actives;
  const setActiveId = useCallback((id: string) => setActives((a) => ({ ...a, [keyRef.current]: id })), []);
  // "page": the browser of the user. "agent": the newest screenshot of the agent browser.
  const [view, setView] = useState<"page" | "agent">("page");
  const [device, setDevice] = useState<Device>(() => (loadPref("browserDevice", "desktop") as Device) || "desktop");
  const [keep, setKeep] = useState<KeepCookies>(keepCookies);
  const [inPane, setInPane] = useLinksInPane(); // The same preference as Settings > General > "Open links in".
  const [sub, setSub] = useState<"viewport" | "cookies" | null>(null); // The open list of the More menu.
  const overlay = useOverlayOpen();
  const nativeOwner = useId(); // The key of this pane for the place of its webview (setNativeRect).
  const lastSync = useRef(new Map<string, string>()); // The last bounds and visibility of each webview.
  const selectOnFocus = useRef(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const focusAddress = useRef(false); // A new tab of the user: the address bar takes the focus.
  const requested = useRef<string | null>(null); // The tab of the last navigation request from the app.

  useEffect(() => {
    kept = { tabs, active: { ...actives, [key]: active.id } };
  }, [tabs, actives, key, active.id]);

  const update = useCallback((id: string, change: Partial<BrowserTab>) => {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...change } : t)));
  }, []);

  // The agent adds its tab here, and shows it when it opens a page.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    paneHooks = {
      add: (tab) => {
        tabsRef.current = [...tabsRef.current, tab];
        setTabs((list) => [...list, tab]);
      },
      activate: (id) => {
        // The tab shows in its own session. The pane of another session does not change.
        const tab = tabsRef.current.find((t) => t.id === id);
        const owner = tab ? ownerOf(tab) : keyRef.current;
        setActives((a) => ({ ...a, [owner]: id }));
        if (owner === keyRef.current) setView("page");
      },
      has: (id) => tabsRef.current.some((t) => t.id === id),
      resync: (id) => lastSync.current.delete(id),
      close: (id) => closeTabRef.current(id),
      list: () => ({ tabs: tabsRef.current, active: { ...activesRef.current, [keyRef.current]: activeRef.current } }),
    };
    return () => {
      paneHooks = null;
    };
  }, []);

  // The annotation mode (annotate.ts): the tab where it runs, and the notes that went to the prompt.
  const [annotating, setAnnotating] = useState<string | null>(null);
  const [notes, setNotes] = useState(0);
  const annotatingRef = useRef<string | null>(null);
  annotatingRef.current = annotating;
  const onAnnotateRef = useRef(onAnnotate);
  onAnnotateRef.current = onAnnotate;
  const onScreenshotRef = useRef(onScreenshot);
  onScreenshotRef.current = onScreenshot;

  // The annotation bar is under the page (AnnotateBar.tsx). It keeps the last shape, color, and line
  // width for the next time.
  const [bar, setBar] = useState<{ tool: AnnotateTool; shape: ShapeTool; color: string; width: number }>(() => ({ tool: "none", ...lastBar }));
  const [busy, setBusy] = useState(false);
  const capturing = useRef(false);

  /** Run a script in the page of a tab. A page of another origin in an iframe refuses it. */
  const runInPage = useCallback(
    async (id: string, script: (send: "nav" | "post") => string): Promise<boolean> => {
      if (tauri) {
        await browserView.evalScript(id, script("nav"));
        return true;
      }
      const frame = area.current?.querySelector<HTMLIFrameElement>(`iframe[data-tab="${id}"]`);
      try {
        (frame?.contentWindow as (Window & { eval: (code: string) => unknown }) | null | undefined)?.eval(script("post"));
        return !!frame?.contentWindow;
      } catch {
        return false; // Another origin: only the desktop app can annotate it.
      }
    },
    [tauri],
  );
  const runAnnotate = useCallback(
    (id: string, on: boolean) =>
      runInPage(id, (send) => annotateScript(on, send, on ? { color: lastBar.color, width: lastBar.width } : {})),
    [runInPage],
  );
  /** Send a choice of the bar to the page script. */
  const callPage = (method: AnnotateMethod, ...args: (string | number | boolean)[]) => {
    const id = annotatingRef.current;
    if (id) void runInPage(id, () => annotateCall(method, ...args)).catch(() => undefined);
  };
  const changeBar = (change: Partial<typeof bar>) => {
    setBar((b) => {
      const next = { ...b, ...change };
      lastBar = { shape: next.shape, color: next.color, width: next.width };
      return next;
    });
  };

  /** "Add to prompt": a screenshot of the page with the marks goes into the prompt box. */
  const addScreenshot = async () => {
    const id = annotatingRef.current;
    if (!id || !tauri || capturing.current) return;
    capturing.current = true;
    setBusy(true);
    try {
      await browserView.evalScript(id, annotateCall("prepare", true)); // Hide the hint and the outline.
      await new Promise((r) => setTimeout(r, 120)); // The page draws again before the capture.
      const png = await browserView.capture(id);
      await browserView.evalScript(id, annotateCall("prepare", false));
      const small = await imageToDataUrl(await (await fetch(png)).blob());
      onScreenshotRef.current(small, tabsRef.current.find((t) => t.id === id)?.url ?? "");
      await browserView.evalScript(id, annotateCall("clear"));
    } catch (e) {
      onError(`The screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
      void browserView.evalScript(id, annotateCall("prepare", false)).catch(() => undefined);
    } finally {
      capturing.current = false;
      setBusy(false);
    }
  };
  const addScreenshotRef = useRef(addScreenshot);
  addScreenshotRef.current = addScreenshot;

  const stopAnnotate = useCallback(() => {
    const id = annotatingRef.current;
    if (!id) return;
    setAnnotating(null);
    void runAnnotate(id, false).catch(() => undefined);
  }, [runAnnotate]);

  /** A message of the page script: a note, or the end of the mode (Esc in the page). */
  const onPageData = useCallback((id: string, data: unknown) => {
    if (id !== annotatingRef.current) return;
    const message = pageMessage(data);
    if (message?.type === "stop") {
      setAnnotating(null);
      return;
    }
    const note = parseAnnotation(data);
    if (!note) return;
    setNotes((n) => n + 1);
    onAnnotateRef.current(note);
  }, []);

  const measure = useCallback((): Bounds | null => {
    const el = area.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null; // The pane is hidden.
    return deviceBounds({ x: r.left, y: r.top, width: r.width, height: r.height }, device);
  }, [device]);

  /** Show a page in a tab. The webview of the tab opens when the tab shows. */
  const go = useCallback(
    async (id: string, target: string) => {
      const next = normalizeAddress(target);
      setTabs((list) => list.map((t) => (t.id === id ? { ...t, url: next, address: next, title: "", frame: t.frame + 1 } : t)));
      if (!tauri || !opened.has(id)) return; // The sync effect opens the webview.
      try {
        await browserView.navigate(id, next);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    },
    [tauri, onError],
  );

  const addTab = useCallback(
    (url: string | null = null) => {
      if (mine.length >= MAX_TABS) {
        onError(`The browser can have at most ${MAX_TABS} tabs. Close a tab first.`);
        return null;
      }
      const tab = { ...newTab(url), owner: key };
      setTabs((list) => [...list, tab]);
      setActiveId(tab.id);
      setView("page");
      return tab;
    },
    [mine.length, key, onError, setActiveId],
  );

  const closeTab = (id: string) => {
    if (opened.delete(id)) void browserView.close(id).catch(() => undefined);
    lastSync.current.delete(id);
    dropAgentTab(id);
    const index = mine.findIndex((t) => t.id === id);
    const rest = mine.filter((t) => t.id !== id);
    const others = tabs.filter((t) => t.id !== id);
    if (rest.length === 0) {
      const tab = { ...newTab(), owner: key }; // The next time, the pane opens with one new tab.
      // The pane closes now: the effect that saves the tabs does not run.
      kept = { tabs: [...others, tab], active: { ...actives, [key]: tab.id } };
      setTabs([...others, tab]);
      setActiveId(tab.id);
      onEmpty();
      return;
    }
    setTabs(others);
    if (id === active.id) setActiveId(rest[Math.max(0, index - 1)].id);
  };

  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;

  /** "New tab" (the + button or Ctrl+T): the address bar takes the focus, so the user can type an address at once. */
  const openNewTab = () => {
    if (addTab()) focusAddress.current = true;
  };
  useEffect(() => {
    if (!focusAddress.current) return;
    focusAddress.current = false;
    const input = addressRef.current;
    if (!input) return;
    input.focus();
    input.select();
    selectOnFocus.current = false; // No click: the next mouseup must not keep the selection.
  }, [active.id]);

  // A navigation request from the app: a server, a project file, or /preview. It uses the tab that
  // shows no page, or a new tab.
  useEffect(() => {
    if (!request || request.key === handledRequest) return;
    handledRequest = request.key;
    setView("page");
    const target = active.url ? addTab(request.url) : active;
    if (target) {
      requested.current = target.id;
      void go(target.id, request.url);
    }
  }, [request?.key]);

  // A new page of the agent browser. With no page of its own, the pane shows the agent page. A tab
  // that the app just asked to open (for example "Open" of a card) keeps the page view.
  useEffect(() => {
    if (!agentFrame) return;
    if (!active.url && requested.current !== active.id) setView("agent");
  }, [agentFrame?.key]);

  useEffect(() => {
    if (showAgent && agentFrame) setView("agent");
  }, [showAgent]);

  // Page loads and title changes of the webviews. A link that opens a window opens a new tab.
  useEffect(() => {
    if (!tauri) return;
    const stops: (() => void)[] = [];
    let live = true;
    void browserView
      .onEvent((event) => {
        if (event.title !== undefined) update(event.id, { title: event.title });
        else if (event.loading) {
          update(event.id, { loading: true });
          // A new page has no annotation script: the mode ends.
          if (event.id === annotatingRef.current) setAnnotating(null);
        }
        else update(event.id, { loading: false, address: event.url, url: event.url });
      })
      .then((stop) => (live ? stops.push(stop) : stop()));
    void browserView
      .onAnnotation((event) => {
        let text: string;
        try {
          text = decodeURIComponent(event.data);
        } catch {
          return;
        }
        onPageData(event.id, text);
      })
      .then((stop) => (live ? stops.push(stop) : stop()));
    void browserView
      .onNewTab((event) => {
        // The new tab belongs to the session of the tab that opened it.
        const source = tabsRef.current.find((t) => t.id === event.id);
        const owner = source ? ownerOf(source) : keyRef.current;
        const tab = { ...newTab(event.url), owner };
        setTabs((list) => (list.filter((t) => ownerOf(t) === owner).length >= MAX_TABS ? list : [...list, tab]));
        setActives((a) => ({ ...a, [owner]: tab.id }));
      })
      .then((stop) => (live ? stops.push(stop) : stop()));
    return () => {
      live = false;
      stops.forEach((stop) => stop());
    };
  }, [tauri, update, onPageData]);

  // In a normal browser (development), the page script in an iframe sends with postMessage.
  useEffect(() => {
    if (tauri) return;
    const onMessage = (e: MessageEvent) => {
      const data = (e.data as { __harnessAnnotation?: unknown } | null)?.__harnessAnnotation;
      if (data === undefined) return;
      const frame = area.current?.querySelector<HTMLIFrameElement>(`iframe[data-tab="${annotatingRef.current}"]`);
      if (!frame || e.source !== frame.contentWindow) return; // Only the page of the annotated tab.
      onPageData(annotatingRef.current!, data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [tauri, onPageData]);

  // The mode is for one page: another tab, or the agent view, ends it.
  useEffect(() => {
    if (annotatingRef.current && (annotatingRef.current !== activeId || view !== "page")) stopAnnotate();
  }, [activeId, view]);

  // The webview is a native window over the app, so it hides while a menu or a dialog is open. A
  // still picture of the page shows in its place: the page does not go blank. The webview hides
  // when the picture is ready, or after STILL_WAIT ms with no picture.
  const [still, setStill] = useState<{ src: string; left: number; top: number; width: number; height: number } | null>(null);
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    if (!overlay) {
      setCovered(false);
      setStill(null);
      return;
    }
    const bounds = measure();
    const box = area.current?.getBoundingClientRect();
    if (!tauri || view !== "page" || !active.url || !opened.has(active.id) || !bounds || !box) {
      setCovered(true);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setCovered(true);
    };
    const timer = window.setTimeout(finish, STILL_WAIT);
    browserView
      .capture(active.id)
      .then((src) => {
        if (done) return;
        setStill({ src, left: bounds.x - box.left, top: bounds.y - box.top, width: bounds.width, height: bounds.height });
        finish();
      })
      .catch(finish);
    return () => {
      done = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The picture is of the page when the overlay opens.
  }, [overlay]);

  // Keep the webview of the active tab over the pane area. Hide the other webviews, and hide all
  // of them when the pane is hidden or an overlay (a menu, a dialog) covers the page.
  useLayoutEffect(() => {
    if (!tauri) return;
    const sync = () => {
      const bounds = measure();
      const box = area.current?.getBoundingClientRect();
      if (box && box.width >= 2 && box.height >= 2) parkSize = { width: Math.round(box.width), height: Math.round(box.height) };
      shown = null;
      // The place of the webview, also while an overlay hides it: a popup that moves clear of the
      // webview (useClearOfNative) must not move back while the webview hides for it.
      const place = bounds && active.url && view === "page" && opened.has(active.id) ? bounds : null;
      setNativeRect(nativeOwner, place && { left: place.x, top: place.y, right: place.x + place.width, bottom: place.y + place.height });
      for (const tab of tabs) {
        const show = tab.id === active.id && !!bounds && !covered && !!tab.url && view === "page";
        const unpark = show && parked.has(tab.id);
        if (show) {
          shown = tab.id;
          parked.delete(tab.id);
          if (minimized.delete(tab.id)) agentChanged(); // The pane shows the minimized tab again.
        }
        const live = (!!tab.agent || minimized.has(tab.id)) && agentLive(tab.id);
        const key = JSON.stringify([show ? bounds : null, show, opened.has(tab.id), live]);
        if (lastSync.current.get(tab.id) === key) continue;
        lastSync.current.set(tab.id, key);
        // While the agent works, its tab stays out of sight but visible (parked): the page keeps drawing.
        if (!show && live && opened.has(tab.id)) {
          void park(tab.id).catch(() => undefined);
          continue;
        }
        if (show && bounds && tab.url && !opened.has(tab.id)) {
          opened.add(tab.id);
          const fresh = keep === "quit" && !clearedThisRun;
          clearedThisRun = true;
          void browserView.open(tab.id, tab.url, bounds, fresh).catch((e) => {
            opened.delete(tab.id);
            onError(e instanceof Error ? e.message : String(e));
          });
          continue;
        }
        if (!opened.has(tab.id)) continue;
        if (unpark && bounds) {
          // A parked tab (minimized to the rail, or an agent tab) moves back from out of sight. A move
          // with the same size does not make WebView2 draw again: the page stays blank until a resize.
          // A change of size and a hide and show make it draw.
          void (async () => {
            await browserView.bounds(tab.id, { ...bounds, width: bounds.width + 1 });
            await browserView.bounds(tab.id, bounds);
            await browserView.visible(tab.id, false);
            await browserView.visible(tab.id, true);
          })().catch(() => undefined);
          continue;
        }
        if (show && bounds) void browserView.bounds(tab.id, bounds);
        if (!show) parked.delete(tab.id);
        void browserView.visible(tab.id, show);
      }
    };
    sync();
    const observer = new ResizeObserver(sync);
    if (area.current) observer.observe(area.current);
    window.addEventListener("resize", sync);
    // Layout moves (a split, a tab change) do not resize the area. A hidden window does not need the check.
    const timer = window.setInterval(() => document.hidden || sync(), 500);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.clearInterval(timer);
    };
  }, [tauri, measure, covered, tabs, active.id, view, onError, keep, nativeOwner]);

  // Hide the webviews when the pane closes. They stay open for the next time. A tab where the
  // agent works now stays parked.
  useEffect(
    () => () => {
      shown = null;
      setNativeRect(nativeOwner, null);
      for (const id of opened) {
        if (agentLive(id)) {
          void park(id).catch(() => undefined);
        } else {
          parked.delete(id);
          void browserView.visible(id, false).catch(() => undefined);
        }
      }
      lastSync.current.clear();
    },
    [nativeOwner],
  );

  const DeviceIcon = DEVICES[device].icon;
  const agentView = view === "agent" && !!agentFrame;
  const navOff = !active.url || agentView;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key === "t") {
      e.preventDefault();
      openNewTab();
    } else if (e.key === "w") {
      e.preventDefault();
      closeTab(active.id);
    }
  };

  return (
    <section className="browser-pane" aria-label="Browser" onKeyDown={onKeyDown}>
      <PaneHeader>
        <WindowTabs
          kind="Browser"
          tabs={mine.map((t) => ({ id: t.id, label: tabLabel(t), icon: t.loading ? LoaderCircle : Globe, busy: t.loading, detail: t.url && t.url !== "about:blank" ? t.url : undefined }))}
          active={active.id}
          onSelect={(id) => {
            setActiveId(id);
            setView("page");
          }}
          onClose={closeTab}
          onMove={(id, toId) =>
            // The list also has the tabs of the other sessions: their order does not change.
            setTabs((list) => withMoved(list, list.findIndex((t) => t.id === id), list.findIndex((t) => t.id === toId)))
          }
          onAdd={openNewTab}
          addLabel="New tab (Ctrl+T)"
        />
      </PaneHeader>
      <PaneActions>
        {/* Stop all the servers of the project: only while one runs (the user asked for this). */}
        {serverApi.items.some((i) => i.state === "running" || i.state === "starting") && (
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => serverApi.stopAll()}
            aria-label="Stop all servers"
            title={`Stop all servers (${serverApi.items.filter((i) => i.state === "running" || i.state === "starting").length} running)`}
          >
            <Power size={15} aria-hidden />
          </button>
        )}
        <ServerMenu
          api={serverApi}
          onOpenInBrowser={onOpenServer}
          // With no launch.json, an empty tab shows the block that makes it.
          onEditConfig={serverApi.config === "missing" ? () => (active.url ? addTab() : setView("page")) : onEditLaunch}
        />
        <Menu label="More" icon={<EllipsisVertical size={15} aria-hidden />}>
          {(close) => {
            const page = active.url && active.url !== "about:blank" ? active.url : null;
            const live = tauri && opened.has(active.id);
            const run = (action: () => void | Promise<void>) => {
              close();
              setSub(null);
              void Promise.resolve(action()).catch((e) => onError(e instanceof Error ? e.message : String(e)));
            };
            return (
              <>
                <button type="button" role="menuitem" disabled={!page || page.startsWith("file:")} onClick={() => run(() => openExternal(page!))}>
                  Open in your browser
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!live || !page}
                  onClick={() =>
                    run(async () => {
                      const name = `${(tabLabel(active).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "page").slice(0, 60)}.png`;
                      const path = await pickSavePath(name, [{ name: "PNG image", extensions: ["png"] }]);
                      if (path) await browserView.screenshot(active.id, path);
                    })
                  }
                >
                  Save screenshot
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!tauri}
                  onClick={() =>
                    run(async () => {
                      const path = await pickFile([{ name: "HTML file", extensions: ["html", "htm"] }]);
                      if (!path) return;
                      setView("page");
                      const target = active.url ? addTab() : active;
                      if (target) await go(target.id, fileUrl(path));
                    })
                  }
                >
                  Open HTML file…
                </button>
                <div className="menu-sep" role="separator" />
                <SubMenu
                  label="Viewport"
                  value={device}
                  choices={{ desktop: "Responsive", phone: "Mobile", tablet: "Tablet" }}
                  open={sub === "viewport"}
                  onOpen={(o) => setSub(o ? "viewport" : null)}
                  onPick={(d) => {
                    setDevice(d);
                    savePref("browserDevice", d);
                    setSub(null);
                    close();
                  }}
                />
                <div className="menu-sep" role="separator" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={inPane}
                  onMouseEnter={() => setSub(null)}
                  onClick={() => {
                    setInPane(!inPane);
                  }}
                >
                  <span className="side-filter-label">Open links in built-in browser</span>
                  {inPane && <Check size={14} aria-hidden />}
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={!!autoVerify}
                  disabled={autoVerify === null}
                  title={autoVerify === null ? "Open a session first: the setting is for each project." : undefined}
                  onMouseEnter={() => setSub(null)}
                  onClick={() => onAutoVerify(!autoVerify)}
                >
                  <span className="side-filter-label">Auto-verify changes</span>
                  {autoVerify && <Check size={14} aria-hidden />}
                </button>
                <button type="button" role="menuitem" disabled={autoVerify === null} onMouseEnter={() => setSub(null)} onClick={() => run(onManageSites)}>
                  Manage allowed sites…
                </button>
                <div className="menu-sep" role="separator" />
                <p className="menu-heading">Cookies</p>
                <SubMenu
                  label="Keep cookies"
                  value={keep}
                  choices={KEEP_COOKIES}
                  open={sub === "cookies"}
                  onOpen={(o) => setSub(o ? "cookies" : null)}
                  onPick={(k) => {
                    setKeep(k);
                    savePref("browserKeepCookies", k);
                    setSub(null);
                  }}
                />
                <button type="button" role="menuitem" className="danger" disabled={!live} onMouseEnter={() => setSub(null)} onClick={() => run(() => browserView.clearData(active.id))}>
                  Clear browsing data
                </button>
                <div className="menu-sep" role="separator" />
                <button type="button" role="menuitem" disabled={!live} onMouseEnter={() => setSub(null)} onClick={() => run(() => browserView.devtools(active.id))}>
                  <Bug size={14} aria-hidden /> Open the developer tools
                </button>
              </>
            );
          }}
        </Menu>
        {/* "Minimize", as in the Claude app: the pane closes and the session rail shows the page. */}
        {onMinimize && (
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => {
              if (session) minimizeTab(session, active.id);
              onMinimize();
            }}
            disabled={!active.url}
            aria-label="Minimize"
            title="Minimize to the session rail"
          >
            <PictureInPicture2 size={15} aria-hidden />
          </button>
        )}
      </PaneActions>
      <form
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (agentView) return;
          void go(active.id, active.address);
        }}
      >
        <button type="button" className="icon-btn ghost" onClick={() => tauri && browserView.history(active.id, "back")} disabled={navOff || !tauri} aria-label="Back" title="Back">
          <ArrowLeft size={15} aria-hidden />
        </button>
        <button type="button" className="icon-btn ghost" onClick={() => tauri && browserView.history(active.id, "forward")} disabled={navOff || !tauri} aria-label="Forward" title="Forward">
          <ArrowRight size={15} aria-hidden />
        </button>
        <button
          type="button"
          className="icon-btn ghost"
          onClick={() => (tauri ? browserView.history(active.id, "reload") : update(active.id, { frame: active.frame + 1 }))}
          disabled={navOff}
          aria-label="Reload"
          title="Reload"
        >
          {active.loading && !agentView ? <LoaderCircle size={15} className="spin" aria-hidden /> : <RotateCw size={15} aria-hidden />}
        </button>
        <label htmlFor="browser-address" className="sr-only">
          {agentView ? "Address of the agent browser page" : "Address"}
        </label>
        <input
          id="browser-address"
          ref={addressRef}
          className={`mono browser-address${agentView ? " agent" : ""}`}
          value={agentView ? agentFrame.url : active.address}
          onChange={(e) => update(active.id, { address: e.target.value })}
          // The first click selects all the address, as in a browser. The mouseup must not clear the selection.
          onFocus={(e) => {
            e.currentTarget.select();
            selectOnFocus.current = true;
          }}
          onMouseUp={(e) => {
            if (selectOnFocus.current) e.preventDefault();
            selectOnFocus.current = false;
          }}
          readOnly={agentView}
          placeholder="localhost:5173, or a web address"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          className={`icon-btn ghost annotate-toggle${annotating ? " active" : ""}`}
          disabled={!active.url || agentView || active.url.startsWith("file:")}
          aria-pressed={!!annotating}
          aria-label={annotating ? "Stop annotating" : "Annotate the page"}
          title={annotating ? "Stop annotating (Esc in the page)" : "Annotate: click elements of the page and add notes for the agent"}
          onClick={() => {
            if (annotating) return stopAnnotate();
            const id = active.id;
            setNotes(0);
            setBar((b) => ({ ...b, tool: "none" })); // No tool at the start: the user picks one.
            void runAnnotate(id, true)
              .then((ok) => {
                if (!ok) return onError("This page is on another origin. Annotations of it work in the desktop app.");
                setAnnotating(id);
              })
              .catch((e) => onError(e instanceof Error ? e.message : String(e)));
          }}
        >
          <SquareDashedMousePointer size={15} aria-hidden />
          {annotating && notes > 0 && <span className="annotate-count" aria-label={`${notes} notes`}>{notes}</span>}
        </button>
        <Menu label={`Viewport: ${DEVICES[device].label}`} icon={<DeviceIcon size={15} aria-hidden />}>
          {(close) =>
            (Object.keys(DEVICES) as Device[]).map((d) => {
              const size = DEVICES[d].size;
              return (
                <button
                  key={d}
                  type="button"
                  role="menuitemradio"
                  aria-checked={device === d}
                  className="device-item"
                  onClick={() => {
                    setDevice(d);
                    savePref("browserDevice", d);
                    close();
                  }}
                >
                  <span className="device-name">{DEVICES[d].label}</span>
                  {size && <span className="device-size mono">{`${size.width} × ${size.height}`}</span>}
                  <span className="menu-check">{device === d && <Check size={14} aria-hidden />}</span>
                </button>
              );
            })
          }
        </Menu>
      </form>
      <div className={`browser-area device-${device}`} ref={area}>
        {still && covered && !agentView && (
          <img className="browser-still" src={still.src} alt="" style={{ left: still.left, top: still.top, width: still.width, height: still.height }} />
        )}
        {agentView ? (
          <div className="agent-view">
            <div className="agent-caption">
              <Bot size={14} aria-hidden />
              <span>
                {agentFrame.action === "live" ? (
                  "The agent browser, live"
                ) : (
                  <>
                    The agent browser after <span className="mono">{agentFrame.action}</span>
                  </>
                )}
                {agentFrame.title && <> · {agentFrame.title}</>}
              </span>
              <span className="spacer" />
              <button type="button" className="btn btn-small" onClick={() => { setView("page"); onOpenAgentPage(agentFrame.url); }}>
                Open this page here
              </button>
            </div>
            <img className="agent-frame" src={agentFrame.image} alt={`The agent browser page: ${agentFrame.title || agentFrame.url}`} />
          </div>
        ) : !active.url ? (
          <ServerBlock api={serverApi} approvals={serverApprovals} onDecide={onDecide} onOpen={onOpenServer} onEdit={onEditLaunch} />
        ) : null}
        {!tauri &&
          tabs.map((t) =>
            t.url ? (
              <iframe
                key={`${t.id}-${t.frame}`}
                data-tab={t.id}
                src={t.url}
                title={tabLabel(t)}
                className="browser-frame"
                hidden={t.id !== active.id || agentView}
                style={DEVICES[device].size ? { maxWidth: DEVICES[device].size!.width, maxHeight: DEVICES[device].size!.height } : undefined}
              />
            ) : null,
          )}
      </div>
      {/* The annotation bar has its own space under the page, as in the Claude app: it covers no part of the page. */}
      {annotating && !agentView && (
        <AnnotateBar
          {...bar}
          busy={busy}
          capture={tauri}
          onTool={(tool) => {
            changeBar(SHAPES_BY_ID.has(tool) ? { tool, shape: tool as ShapeTool } : { tool });
            callPage("setTool", tool);
          }}
          onColor={(color) => {
            changeBar({ color });
            callPage("setColor", color);
          }}
          onWidth={(width) => {
            changeBar({ width });
            callPage("setWidth", width);
          }}
          onUndo={() => callPage("undo")}
          onClear={() => callPage("clear")}
          onAdd={() => void addScreenshotRef.current()}
          onDone={stopAnnotate}
        />
      )}
    </section>
  );
}
