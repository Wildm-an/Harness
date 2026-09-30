// The terminal pane: the shell of the session, in xterm.js. The daemon runs the shell (docs/PROTOCOL.md).
//
// The pane keeps the terminal of each session when it closes, so the screen stays the same. When the
// pane opens again, the daemon sends only the output that the pane did not get.

import { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { DaemonConnection } from "../daemon/connection";
import type { ClientMessage } from "../daemon/protocol";

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
  };
}

/** The text that the terminal shows when the shell stops. */
export function exitNotice(code: number | null): string {
  const how = code === null ? "" : ` with exit code ${code}`;
  return `\r\n\x1b[2m[The shell stopped${how}. Press Enter to start a new shell.]\x1b[0m\r\n`;
}

interface Kept {
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

const kept = new Map<string, Kept>(); // Session id -> its terminal.

function keptFor(sessionKey: string, host: HTMLElement): Kept {
  let k = kept.get(sessionKey);
  if (!k) {
    const element = document.createElement("div");
    element.className = "terminal-screen";
    host.appendChild(element);
    const term = new Terminal({
      fontFamily: cssVar("--font-mono") || "Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    k = { term, fit, element, id: null, seen: 0, stopped: false, replaying: false };
    kept.set(sessionKey, k);
  } else {
    host.appendChild(k.element);
  }
  return k;
}

/** Forget all terminals, for example after the connection closed (the daemon stopped the shells). */
function forgetAll(): void {
  for (const k of kept.values()) k.term.dispose();
  kept.clear();
}

export function TerminalPane({ conn, sessionKey, connected }: {
  conn: DaemonConnection;
  sessionKey: string; // The session id. Each session has its own terminal.
  connected: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!connected) forgetAll();
  }, [connected]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !sessionKey || !connected) return;
    const k = keptFor(sessionKey, host);
    const { term, fit } = k;

    const send = (msg: ClientMessage) => {
      try {
        conn.send(msg);
      } catch {
        // Not connected. The pane opens the shell again after the next connection.
      }
    };
    const size = () => {
      try {
        fit.fit(); // Throws if the pane is not visible. The size then stays the same.
      } catch {
        // Keep the last size.
      }
      return { cols: Math.max(term.cols, 2), rows: Math.max(term.rows, 1) };
    };
    const open = () => {
      const since = k.stopped ? 0 : k.seen;
      k.stopped = false;
      send({ type: "term.open", ...size(), ...(k.id && since ? { id: k.id, since } : {}) });
    };

    const offMessage = conn.onMessage((msg) => {
      if (msg.type === "term.opened") {
        k.id = msg.id;
        k.seen = msg.seq;
        if (msg.new || msg.reset) term.reset();
        if (msg.replay) {
          // The output of a new shell has its start-up queries: xterm.js must answer them.
          k.replaying = !msg.new;
          term.write(msg.replay, () => {
            k.replaying = false;
          });
        }
        term.focus();
      } else if (msg.type === "term.output" && msg.id === k.id && msg.seq > k.seen) {
        k.seen = msg.seq;
        term.write(msg.data);
      } else if (msg.type === "term.exit" && msg.id === k.id) {
        k.stopped = true;
        term.write(exitNotice(msg.code));
      }
    });
    const input = term.onData((data) => {
      if (k.replaying) return;
      if (k.stopped) {
        if (data === "\r") open();
        return;
      }
      if (k.id) send({ type: "term.input", id: k.id, data });
    });

    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = size();
        if (k.id && !k.stopped) send({ type: "term.resize", id: k.id, ...next });
      }, 60);
    });
    observer.observe(host);
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => {
      term.options.theme = terminalTheme();
    };
    scheme.addEventListener("change", retheme);

    // Open the shell after the next frame: then the pane is visible, and the shell starts at the
    // correct size. The focus goes into the terminal.
    const frame = window.requestAnimationFrame(() => {
      open();
      term.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      offMessage();
      input.dispose();
      observer.disconnect();
      window.clearTimeout(timer);
      scheme.removeEventListener("change", retheme);
      k.element.remove(); // Keep the terminal for the next time the pane opens.
    };
  }, [conn, sessionKey, connected]);

  return <div className="terminal-pane" ref={hostRef} />;
}
