import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Bug,
  ChevronDown,
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
import { useOverlay, useOverlayOpen } from "../lib/overlay";
import { loadPref, savePref } from "../lib/prefs";
import { browserView, isTauri, type Bounds } from "../lib/tauri";

type Device = "desktop" | "tablet" | "phone";

const DEVICES: Record<Device, { label: string; icon: typeof Monitor; size?: { width: number; height: number } }> = {
  desktop: { label: "Desktop", icon: Monitor },
  tablet: { label: "Tablet (820 × 1180)", icon: Tablet, size: { width: 820, height: 1180 } },
  phone: { label: "Phone (390 × 844)", icon: Smartphone, size: { width: 390, height: 844 } },
};

/** Adds "http://" to an address with no scheme. Keeps "about:blank". */
export function normalizeAddress(text: string): string {
  const t = text.trim();
  if (!t) return "about:blank";
  if (/^(https?:|about:)/i.test(t)) return t;
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
}: {
  request: { url: string; key: number } | null; // A navigation request from the app.
  servers: ServerItem[];
  agentFrame: (AgentFrame & { key: number }) | null; // The newest page of the agent browser.
  onOpenServer: (server: ServerItem) => void;
  onOpenAgentPage: (url: string) => void;
  onError: (message: string) => void;
}) {
  const tauri = isTauri();
  const area = useRef<HTMLDivElement>(null);
  // "page": the browser of the user. "agent": the newest screenshot of the agent browser.
  const [view, setView] = useState<"page" | "agent">("page");
  const [unseen, setUnseen] = useState(false); // A new agent frame came while the user looks at the page.
  const [url, setUrl] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [device, setDevice] = useState<Device>(() => (loadPref("browserDevice", "desktop") as Device) || "desktop");
  const [keepData, setKeepData] = useState(() => loadPref("browserKeepData", "true") !== "false");
  const [iframeKey, setIframeKey] = useState(0);
  const overlay = useOverlayOpen();
  const opened = useRef(false);
  const lastSync = useRef(""); // The last bounds and visibility that went to the webview.

  const measure = useCallback((): Bounds | null => {
    const el = area.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null; // The pane is hidden (another tab is active).
    return deviceBounds({ x: r.left, y: r.top, width: r.width, height: r.height }, device);
  }, [device]);

  const go = useCallback(
    async (target: string) => {
      const next = normalizeAddress(target);
      setUrl(next);
      setAddress(next);
      if (!tauri) {
        setIframeKey((k) => k + 1);
        return;
      }
      const bounds = measure();
      try {
        if (!opened.current) {
          if (!bounds) return; // Opens when the pane shows.
          await browserView.open(next, bounds);
          opened.current = true;
        } else {
          await browserView.navigate(next);
        }
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    },
    [tauri, measure, onError],
  );

  // A navigation request from the app: a server, a project file, or /preview.
  useEffect(() => {
    if (!request) return;
    setView("page");
    void go(request.url);
  }, [request?.key]);

  // A new page of the agent browser. With no page of its own, the pane shows the agent page.
  useEffect(() => {
    if (!agentFrame) return;
    if (!url) setView("agent");
    else if (view === "page") setUnseen(true);
  }, [agentFrame?.key]);

  // Page loads in the webview update the address bar.
  useEffect(() => {
    if (!tauri) return;
    let stop: (() => void) | undefined;
    void browserView.onEvent((event) => {
      setLoading(event.loading);
      if (!event.loading) setAddress(event.url);
    }).then((fn) => (stop = fn));
    return () => stop?.();
  }, [tauri]);

  // Keep the webview over the pane area. Hide it when the pane is hidden or an overlay is open.
  useLayoutEffect(() => {
    if (!tauri) return;
    const sync = () => {
      const bounds = measure();
      const show = !!bounds && !overlay && !!url && view === "page";
      const key = JSON.stringify([bounds, show, opened.current]);
      if (key === lastSync.current) return;
      lastSync.current = key;
      if (show && bounds) {
        if (!opened.current && url) {
          void browserView.open(url, bounds).then(() => (opened.current = true)).catch((e) => onError(String(e)));
        } else {
          void browserView.bounds(bounds);
        }
      }
      if (opened.current) void browserView.visible(show);
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
  }, [tauri, measure, overlay, url, view, onError]);

  // Hide the webview when the pane closes.
  useEffect(() => () => void (opened.current && browserView.visible(false)), []);

  const running = servers.filter((s) => s.state === "running" && s.url);
  const DeviceIcon = DEVICES[device].icon;
  const agentView = view === "agent" && !!agentFrame;
  const navOff = !url || agentView;

  return (
    <section className="browser-pane" aria-label="Browser">
      <form
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (agentView) return;
          void go(address);
        }}
      >
        <button type="button" className="icon-btn ghost" onClick={() => (tauri ? browserView.history("back") : history.back())} disabled={navOff} aria-label="Back" title="Back">
          <ArrowLeft size={15} aria-hidden />
        </button>
        <button type="button" className="icon-btn ghost" onClick={() => tauri && browserView.history("forward")} disabled={navOff || !tauri} aria-label="Forward" title="Forward">
          <ArrowRight size={15} aria-hidden />
        </button>
        <button
          type="button"
          className="icon-btn ghost"
          onClick={() => (tauri ? browserView.history("reload") : setIframeKey((k) => k + 1))}
          disabled={navOff}
          aria-label="Reload"
          title="Reload"
        >
          {loading && !agentView ? <LoaderCircle size={15} className="spin" aria-hidden /> : <RotateCw size={15} aria-hidden />}
        </button>
        <label htmlFor="browser-address" className="sr-only">
          {agentView ? "Address of the agent browser page" : "Address"}
        </label>
        <input
          id="browser-address"
          className={`mono browser-address${agentView ? " agent" : ""}`}
          value={agentView ? agentFrame.url : address}
          onChange={(e) => setAddress(e.target.value)}
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
        <Menu label={`Device size: ${DEVICES[device].label}`} icon={<DeviceIcon size={15} aria-hidden />}>
          {(close) =>
            (Object.keys(DEVICES) as Device[]).map((d) => {
              const Icon = DEVICES[d].icon;
              return (
                <button
                  key={d}
                  type="button"
                  role="menuitemradio"
                  aria-checked={device === d}
                  onClick={() => {
                    setDevice(d);
                    savePref("browserDevice", d);
                    close();
                  }}
                >
                  <Icon size={14} aria-hidden /> {DEVICES[d].label}
                </button>
              );
            })
          }
        </Menu>
        <Menu label="More" icon={<EllipsisVertical size={15} aria-hidden />}>
          {(close) => (
            <>
              <button type="button" role="menuitem" disabled={!tauri || !url} onClick={() => { close(); void browserView.devtools(); }}>
                <Bug size={14} aria-hidden /> Open the developer tools
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={keepData}
                onClick={() => {
                  const next = !keepData;
                  setKeepData(next);
                  savePref("browserKeepData", String(next));
                }}
              >
                <span className="menu-check" aria-hidden>{keepData ? "✓" : ""}</span>
                Keep cookies and storage when a server restarts
              </button>
              <button type="button" role="menuitem" disabled={!tauri || !url} onClick={() => { close(); void browserView.clearData(); }}>
                <span className="menu-check" aria-hidden /> Clear cookies and storage now
              </button>
            </>
          )}
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
        ) : !url ? (
          <div className="editor-empty">
            <Globe size={28} aria-hidden />
            <p>Open a running server from the Servers pane, or type an address.</p>
            <p className="help">A project file path in the chat (HTML, PDF, image, or video) also opens here.</p>
          </div>
        ) : !tauri ? (
          <iframe
            key={iframeKey}
            src={url}
            title="Browser"
            className="browser-frame"
            style={DEVICES[device].size ? { maxWidth: DEVICES[device].size!.width, maxHeight: DEVICES[device].size!.height } : undefined}
          />
        ) : null}
      </div>
    </section>
  );
}
