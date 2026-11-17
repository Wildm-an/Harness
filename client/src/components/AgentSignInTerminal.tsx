// The sign-in terminal of Settings > Agents, as in T3 Code: the daemon runs the sign-in command of the
// agent (for example "claude /login") in a pseudo terminal (daemon agent_auth.py), and xterm.js shows it.
// The user can type in it, for example the code from the sign-in page.

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { DaemonConnection } from "../daemon/connection";
import type { ClientMessage } from "../daemon/protocol";
import { codeFontFamily, onThemeChange } from "../lib/theme";
import { terminalTheme } from "./TerminalPane";

export function AgentSignInTerminal({ conn, id, name, onExit }: {
  conn: DaemonConnection;
  id: string; // The agent.
  name: string;
  onExit: (code: number | null) => void; // The sign-in command stopped. The daemon then sends the list.
}) {
  const host = useRef<HTMLDivElement>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const send = (msg: ClientMessage) => {
      try {
        conn.send(msg);
      } catch {
        // Not connected: the page shows the note, and the sign-in stops.
      }
    };
    const term = new Terminal({ fontFamily: codeFontFamily(), fontSize: 13, cursorBlink: true, scrollback: 2000, theme: terminalTheme() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    const size = () => {
      try {
        fit.fit(); // Throws if the terminal is not visible. The size then stays the same.
      } catch {
        // Keep the last size.
      }
      return { cols: Math.max(term.cols, 2), rows: Math.max(term.rows, 1) };
    };
    let running = false;
    let ended = false;

    const offMessage = conn.onMessage((msg) => {
      if (msg.type === "agents.signin.started" && msg.id === id) {
        running = true;
      } else if (msg.type === "agents.signin.output" && msg.id === id) {
        term.write(msg.data);
      } else if (msg.type === "agents.signin.exit" && msg.id === id && !ended) {
        ended = true;
        running = false;
        exitRef.current(msg.code);
      }
    });
    const input = term.onData((data) => {
      if (running) send({ type: "agents.signin.input", id, data });
    });

    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = size();
        if (running) send({ type: "agents.signin.resize", id, ...next });
      }, 60);
    });
    observer.observe(element);
    const offTheme = onThemeChange(() => {
      term.options.theme = terminalTheme();
      term.options.fontFamily = codeFontFamily();
      size();
    });

    // Start the sign-in after the next frame: then the terminal is visible and has its size.
    const frame = window.requestAnimationFrame(() => {
      send({ type: "agents.signin", id, ...size() });
      term.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      // The page closed while the sign-in runs: stop it.
      if (running && !ended) send({ type: "agents.signin.cancel", id });
      offMessage();
      input.dispose();
      observer.disconnect();
      offTheme();
      term.dispose();
    };
  }, [conn, id]);

  return <div ref={host} className="agent-signin-screen" role="group" aria-label={`Sign-in terminal of ${name}`} />;
}
