// The terminal pane: the shells of the session, in xterm.js. The daemon runs the shells (docs/PROTOCOL.md).
// Each tab of the pane has its own shell.
//
// The pane keeps the terminals of each session when it closes, so the screens stay the same. When the
// pane opens again, the daemon sends only the output that the pane did not get.

import { useEffect, useRef, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { DaemonConnection } from "../daemon/connection";
import type { ClientMessage } from "../daemon/protocol";
import { PaneHeader } from "../layout/Workspace";
import { WindowTabs } from "../layout/WindowTabs";

const MAX_TABS = 8; // The daemon allows 8 shells for each session.

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function terminalTheme(): ITheme {
  return {
    background: cssVar("--surface-sunken"),
    foreground: cssVar("--text"),
    cursor: cssVar("--text"),
    cursorAccent: cssVar("--surface-sunken"),
    selectionBackground: cssVar("--border-strong"),
    scrollbarSliderBackground: cssVar("--border-strong"),
    scrollbarSliderHoverBackground: cssVar("--border-strong"),
    scrollbarSliderActiveBackground: cssVar("--border-strong"),
  };
}

/** The text that the terminal shows when the shell stops. */
export function exitNotice(code: number | null): string {
  const how = code === null ? "" : ` with exit code ${code}`;
  return `\r\n\x1b[2m[The shell stopped${how}. Press Enter to start a new shell.]\x1b[0m\r\n`;
}

interface Kept {
  key: string; // The tab.
  label: string;
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement; // xterm.js draws into it. It moves into the pane each time the pane opens.
  id: string | null; // The shell in the daemon.
  seen: number; // The number of the last output on the screen.
  stopped: boolean;
  // Output that is not from the shell now (a replay) can have start-up queries, for example the
  // cursor position. xterm.js answers them, and the shell must not get these answers as typed text.
  replaying: boolean;
}

interface SessionTabs {
  tabs: Kept[];
  active: string;
  count: number; // The number for the label of the next tab: "Terminal 2".
}

const kept = new Map<string, SessionTabs>(); // Session id -> its terminal tabs.
let tabCounter = 0;

function makeTab(label: string): Kept {
  const element = document.createElement("div");
  element.className = "terminal-screen";
  const term = new Terminal({
    fontFamily: cssVar("--font-mono") || "Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const key = `k${Date.now().toString(36)}${(tabCounter++).toString(36)}`;
  return { key, label, term, fit, element, id: null, seen: 0, stopped: false, replaying: false };
}

function sessionTabs(sessionKey: string): SessionTabs {
  let s = kept.get(sessionKey);
  if (!s) {
    const first = makeTab("Terminal");
    s = { tabs: [first], active: first.key, count: 1 };
    kept.set(sessionKey, s);
  }
  return s;
}

/** Forget all terminals, for example after the connection closed (the daemon stopped the shells). */
function forgetAll(): void {
  for (const s of kept.values()) for (const k of s.tabs) k.term.dispose();
  kept.clear();
}

export function TerminalPane({
  conn,
  sessionKey,
  connected,
  onEmpty,
}: {
  conn: DaemonConnection;
  sessionKey: string; // The session id. Each session has its own terminals.
  connected: boolean;
  onEmpty: () => void; // The user closed the last tab: close the pane.
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // The tabs live in "kept". This state only makes React draw them again after a change.
  const [, setVersion] = useState(0);
  const redraw = () => setVersion((v) => v + 1);
  const tabs = sessionKey && connected ? sessionTabs(sessionKey) : null;

  useEffect(() => {
    if (!connected) forgetAll();
  }, [connected]);

  const send = (msg: ClientMessage) => {
    try {
      conn.send(msg);
    } catch {
      // Not connected. The pane opens the shells again after the next connection.
    }
  };

  const size = (k: Kept) => {
    try {
      k.fit.fit(); // Throws if the pane is not visible. The size then stays the same.
    } catch {
      // Keep the last size.
    }
    return { cols: Math.max(k.term.cols, 2), rows: Math.max(k.term.rows, 1) };
  };

  /** Open the shell of a tab: its running shell, or a new one. The first tab takes a shell that runs. */
  const open = (s: SessionTabs, k: Kept) => {
    const since = k.stopped ? 0 : k.seen;
    k.stopped = false;
    const which = k.id ? { id: k.id, ...(since ? { since } : {}) } : s.tabs[0] === k ? {} : { new: true };
    send({ type: "term.open", ...size(k), ref: k.key, ...which });
  };

  // Put the screens of the tabs in the pane, and route the output of the shells to their tabs.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !tabs) return;
    const s = tabs;
    const byId = (id: string) => s.tabs.find((k) => k.id === id);

    const offMessage = conn.onMessage((msg) => {
      if (msg.type === "term.opened") {
        const k = s.tabs.find((t) => t.key === msg.ref) ?? byId(msg.id);
        if (!k) return;
        k.id = msg.id;
        k.seen = msg.seq;
        if (msg.new || msg.reset) k.term.reset();
        if (msg.replay) {
          // The output of a new shell has its start-up queries: xterm.js must answer them.
          k.replaying = !msg.new;
          k.term.write(msg.replay, () => {
            k.replaying = false;
          });
        }
        if (k.key === s.active) k.term.focus();
      } else if (msg.type === "term.output") {
        const k = byId(msg.id);
        if (k && msg.seq > k.seen) {
          k.seen = msg.seq;
          k.term.write(msg.data);
        }
      } else if (msg.type === "term.exit") {
        const k = byId(msg.id);
        if (k) {
          k.stopped = true;
          k.term.write(exitNotice(msg.code));
        }
      }
    });

    const inputs = s.tabs.map((k) => {
      if (!k.element.isConnected || k.element.parentElement !== host) host.appendChild(k.element);
      if (!k.term.element) k.term.open(k.element);
      return k.term.onData((data) => {
        if (k.replaying) return;
        if (k.stopped) {
          if (data === "\r") open(s, k);
          return;
        }
        if (k.id) send({ type: "term.input", id: k.id, data });
      });
    });

    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const k = s.tabs.find((t) => t.key === s.active);
        if (!k) return;
        const next = size(k);
        if (k.id && !k.stopped) send({ type: "term.resize", id: k.id, ...next });
      }, 60);
    });
    observer.observe(host);
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => {
      for (const k of s.tabs) k.term.options.theme = terminalTheme();
    };
    scheme.addEventListener("change", retheme);

    // Open the shells after the next frame: then the pane is visible, and a shell starts at the
    // correct size. The focus goes into the active terminal.
    const frame = window.requestAnimationFrame(() => {
      for (const k of s.tabs) open(s, k);
      s.tabs.find((k) => k.key === s.active)?.term.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      offMessage();
      inputs.forEach((i) => i.dispose());
      observer.disconnect();
      window.clearTimeout(timer);
      scheme.removeEventListener("change", retheme);
      for (const k of s.tabs) k.element.remove(); // Keep the terminals for the next time the pane opens.
    };
  }, [conn, tabs, tabs?.tabs.length]);

  // Show the screen of the active tab. It gets its size when it shows.
  useEffect(() => {
    if (!tabs) return;
    for (const k of tabs.tabs) k.element.hidden = k.key !== tabs.active;
    const k = tabs.tabs.find((t) => t.key === tabs.active);
    if (!k) return;
    const frame = window.requestAnimationFrame(() => {
      const next = size(k);
      if (k.id && !k.stopped) send({ type: "term.resize", id: k.id, ...next });
      k.term.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  });

  const addTab = () => {
    if (!tabs || tabs.tabs.length >= MAX_TABS) return;
    tabs.count += 1;
    const k = makeTab(`Terminal ${tabs.count}`);
    tabs.tabs.push(k);
    tabs.active = k.key;
    redraw();
  };

  const closeTab = (key: string) => {
    if (!tabs) return;
    const index = tabs.tabs.findIndex((k) => k.key === key);
    const k = tabs.tabs[index];
    if (!k) return;
    if (k.id) send({ type: "term.close", id: k.id });
    k.term.dispose();
    k.element.remove();
    tabs.tabs.splice(index, 1);
    if (tabs.tabs.length === 0) {
      kept.delete(sessionKey); // The next time, the pane starts with one new tab.
      onEmpty();
      return;
    }
    if (tabs.active === key) tabs.active = tabs.tabs[Math.max(0, index - 1)].key;
    redraw();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+Shift+T and Ctrl+Shift+W: Ctrl+T and Ctrl+W go to the shell.
    if (!(e.ctrlKey && e.shiftKey) || e.altKey || !tabs) return;
    if (e.key === "T") {
      e.preventDefault();
      addTab();
    } else if (e.key === "W") {
      e.preventDefault();
      closeTab(tabs.active);
    }
  };

  return (
    <>
      {tabs && (
        <PaneHeader>
          <WindowTabs
            kind="Terminal"
            tabs={tabs.tabs.map((k) => ({ id: k.key, label: k.label, icon: SquareTerminal }))}
            active={tabs.active}
            onSelect={(key) => {
              tabs.active = key;
              redraw();
            }}
            onClose={closeTab}
            onAdd={addTab}
            addLabel={tabs.tabs.length >= MAX_TABS ? `At most ${MAX_TABS} terminals` : "New terminal (Ctrl+Shift+T)"}
          />
        </PaneHeader>
      )}
      <div className="terminal-pane" ref={hostRef} onKeyDown={onKeyDown} />
    </>
  );
}
