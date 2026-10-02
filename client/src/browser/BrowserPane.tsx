import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Bug,
  ChevronDown,
  ChevronRight,
  EllipsisVertical,
  Globe,
  LoaderCircle,
  Monitor,
  RotateCw,
  Server,
  Smartphone,
  Tablet,
} from "lucide-react";
import type { AgentFrame, ServerItem } from "../daemon/protocol";
import { PaneActions, PaneHeader } from "../layout/Workspace";
import { WindowTabs } from "../layout/WindowTabs";
import { useOverlay, useOverlayOpen } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";
import { linksInPane, setLinksInPane } from "../lib/openLink";
import { browserView, isTauri, openExternal, pickFile, pickSavePath, type Bounds } from "../lib/tauri";

type Device = "desktop" | "tablet" | "phone";

// The sizes of the Claude Code preview. "Responsive" uses the full pane. The menu uses this order.
const DEVICES: Record<Device, { label: string; icon: typeof Monitor; size?: { width: number; height: number } }> = {
  desktop: { label: "Responsive", icon: Monitor },
  phone: { label: "Mobile", icon: Smartphone, size: { width: 375, height: 812 } },
  tablet: { label: "Tablet", icon: Tablet, size: { width: 768, height: 1024 } },
};

const MAX_TABS = 12;

/** Adds "http://" to an address with no scheme. Keeps "about:blank" and file: addresses. */
export function normalizeAddress(text: string): string {
  const t = text.trim();
  if (!t) return "about:blank";
  if (/^(https?:|about:|file:)/i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  return `https://${t}`;
}

/** The webview bounds for a device inside the pane area. */
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
// of the tabs stay too (hidden), so a page keeps its state.
let kept: { tabs: BrowserTab[]; active: string } | null = null;
const opened = new Set<string>(); // The tabs that have a webview.
let handledRequest = 0; // The key of the last navigation request from the app. It stays when the pane closes.

// A new page of the app has no tabs yet. Webviews from an earlier page (a reload) must go.
if (isTauri()) void browserView.closeAll().catch(() => undefined);

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
  request,
  servers,
  agentFrame,
  onOpenServer,
  onOpenAgentPage,
  onError,
  onEmpty,
  onShowLogs,
  autoVerify,
  onAutoVerify,
  onManageSites,
}: {
  request: { url: string; key: number } | null; // A navigation request from the app.
  servers: ServerItem[];
  agentFrame: (AgentFrame & { key: number }) | null; // The newest page of the agent browser.
  onOpenServer: (server: ServerItem) => void;
  onOpenAgentPage: (url: string) => void;
  onError: (message: string) => void;
  onEmpty: () => void; // The user closed the last tab: close the pane.
  onShowLogs: () => void; // Open the Servers pane, with the output of the dev servers.
  autoVerify: boolean | null; // The "check the app after UI changes" setting of the project. null: no session.
  onAutoVerify: (on: boolean) => void;
  onManageSites: () => void; // The sites that the agent browser can open with no question.
}) {
  const tauri = isTauri();
  const area = useRef<HTMLDivElement>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>(() => kept?.tabs ?? [newTab()]);
  const [activeId, setActiveId] = useState<string>(() => kept?.active ?? tabs[0].id);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  // "page": the browser of the user. "agent": the newest screenshot of the agent browser.
  const [view, setView] = useState<"page" | "agent">("page");
  const [unseen, setUnseen] = useState(false); // A new agent frame came while the user looks at the page.
  const [device, setDevice] = useState<Device>(() => (loadPref("browserDevice", "desktop") as Device) || "desktop");
  const [keep, setKeep] = useState<KeepCookies>(keepCookies);
  const [inPane, setInPane] = useState(linksInPane);
  const [sub, setSub] = useState<"viewport" | "cookies" | null>(null); // The open list of the More menu.
  const overlay = useOverlayOpen();
  const lastSync = useRef(new Map<string, string>()); // The last bounds and visibility of each webview.
  const selectOnFocus = useRef(false);

  useEffect(() => {
    kept = { tabs, active: active.id };
  }, [tabs, active.id]);

  const update = useCallback((id: string, change: Partial<BrowserTab>) => {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...change } : t)));
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
      if (tabs.length >= MAX_TABS) {
        onError(`The browser can have at most ${MAX_TABS} tabs. Close a tab first.`);
        return null;
      }
      const tab = newTab(url);
      setTabs((list) => [...list, tab]);
      setActiveId(tab.id);
      setView("page");
      return tab;
    },
    [tabs.length, onError],
  );

  const closeTab = (id: string) => {
    if (opened.delete(id)) void browserView.close(id).catch(() => undefined);
    lastSync.current.delete(id);
    const index = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    if (rest.length === 0) {
      const tab = newTab(); // The next time, the pane opens with one new tab.
      kept = { tabs: [tab], active: tab.id }; // The pane closes now: the effect that saves the tabs does not run.
      setTabs([tab]);
      setActiveId(tab.id);
      onEmpty();
      return;
    }
    setTabs(rest);
    if (id === active.id) setActiveId(rest[Math.max(0, index - 1)].id);
  };

  // A navigation request from the app: a server, a project file, or /preview. It uses the tab that
  // shows no page, or a new tab.
  useEffect(() => {
    if (!request || request.key === handledRequest) return;
    handledRequest = request.key;
    setView("page");
    const target = active.url ? addTab(request.url) : active;
    if (target) void go(target.id, request.url);
  }, [request?.key]);

  // A new page of the agent browser. With no page of its own, the pane shows the agent page.
  useEffect(() => {
    if (!agentFrame) return;
    if (!active.url) setView("agent");
    else if (view === "page") setUnseen(true);
  }, [agentFrame?.key]);

  // Page loads and title changes of the webviews. A link that opens a window opens a new tab.
  useEffect(() => {
    if (!tauri) return;
    const stops: (() => void)[] = [];
    let live = true;
    void browserView
      .onEvent((event) => {
        if (event.title !== undefined) update(event.id, { title: event.title });
        else if (event.loading) update(event.id, { loading: true });
        else update(event.id, { loading: false, address: event.url, url: event.url });
      })
      .then((stop) => (live ? stops.push(stop) : stop()));
    void browserView
      .onNewTab((event) => {
        const tab = newTab(event.url);
        setTabs((list) => (list.length >= MAX_TABS ? list : [...list, tab]));
        setActiveId(tab.id);
      })
      .then((stop) => (live ? stops.push(stop) : stop()));
    return () => {
      live = false;
      stops.forEach((stop) => stop());
    };
  }, [tauri, update]);

  // Keep the webview of the active tab over the pane area. Hide the other webviews, and hide all
  // of them when the pane is hidden or an overlay (a menu, a dialog) is open.
  useLayoutEffect(() => {
    if (!tauri) return;
    const sync = () => {
      const bounds = measure();
      for (const tab of tabs) {
        const show = tab.id === active.id && !!bounds && !overlay && !!tab.url && view === "page";
        const key = JSON.stringify([show ? bounds : null, show, opened.has(tab.id)]);
        if (lastSync.current.get(tab.id) === key) continue;
        lastSync.current.set(tab.id, key);
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
        if (show && bounds) void browserView.bounds(tab.id, bounds);
        void browserView.visible(tab.id, show);
      }
    };
    sync();
    const observer = new ResizeObserver(sync);
    if (area.current) observer.observe(area.current);
    window.addEventListener("resize", sync);
    const timer = window.setInterval(sync, 500); // Layout moves (a split, a tab change) do not resize the area.
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      window.clearInterval(timer);
    };
  }, [tauri, measure, overlay, tabs, active.id, view, onError, keep]);

  // Hide the webviews when the pane closes. They stay open for the next time.
  useEffect(
    () => () => {
      for (const id of opened) void browserView.visible(id, false).catch(() => undefined);
      lastSync.current.clear();
    },
    [],
  );

  const running = servers.filter((s) => s.state === "running" && s.url);
  const DeviceIcon = DEVICES[device].icon;
  const agentView = view === "agent" && !!agentFrame;
  const navOff = !active.url || agentView;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key === "t") {
      e.preventDefault();
      addTab();
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
          tabs={tabs.map((t) => ({ id: t.id, label: tabLabel(t), icon: t.loading ? LoaderCircle : Globe, busy: t.loading }))}
          active={active.id}
          onSelect={(id) => {
            setActiveId(id);
            setView("page");
          }}
          onClose={closeTab}
          onAdd={() => addTab()}
          addLabel="New tab (Ctrl+T)"
        />
      </PaneHeader>
      <PaneActions>
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
                <button type="button" role="menuitem" onMouseEnter={() => setSub(null)} onClick={() => run(onShowLogs)}>
                  Show dev server logs
                </button>
                <div className="menu-sep" role="separator" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={inPane}
                  onMouseEnter={() => setSub(null)}
                  onClick={() => {
                    setInPane(!inPane);
                    setLinksInPane(!inPane);
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
          className={`icon-btn ghost agent-toggle${agentView ? " active" : ""}`}
          onClick={() => {
            setView(agentView ? "page" : "agent");
            setUnseen(false);
          }}
          disabled={!agentFrame}
          aria-pressed={agentView}
          aria-label={unseen ? "Agent browser (new page)" : "Agent browser"}
          title={agentFrame ? "Show the page of the agent browser" : "The agent has not opened a page yet"}
        >
          <Bot size={15} aria-hidden />
          {unseen && <span className="agent-dot" aria-hidden />}
        </button>
        <Menu label="Running servers" icon={<><Server size={15} aria-hidden /><ChevronDown size={11} aria-hidden /></>}>
          {(close) =>
            running.length === 0 ? (
              <p className="menu-note">No server is running.</p>
            ) : (
              running.map((s) => (
                <button key={s.name} type="button" role="menuitem" onClick={() => { close(); onOpenServer(s); }}>
                  <Server size={14} aria-hidden /> {s.name} <span className="mono menu-dim">{s.url}</span>
                </button>
              ))
            )
          }
        </Menu>
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
        {agentView ? (
          <div className="agent-view">
            <div className="agent-caption">
              <Bot size={14} aria-hidden />
              <span>
                The agent browser after <span className="mono">{agentFrame.action}</span>
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
          <div className="editor-empty">
            <Globe size={28} aria-hidden />
            <p>Open a running server from the Servers pane, or type an address.</p>
            <p className="help">A project file path in the chat (HTML, PDF, image, or video) also opens here.</p>
          </div>
        ) : null}
        {!tauri &&
          tabs.map((t) =>
            t.url ? (
              <iframe
                key={`${t.id}-${t.frame}`}
                src={t.url}
                title={tabLabel(t)}
                className="browser-frame"
                hidden={t.id !== active.id || agentView}
                style={DEVICES[device].size ? { maxWidth: DEVICES[device].size!.width, maxHeight: DEVICES[device].size!.height } : undefined}
              />
            ) : null,
          )}
      </div>
    </section>
  );
}
