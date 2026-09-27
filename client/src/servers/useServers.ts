// The state of the local servers of a session (SPEC.md section 8.7).

import { useCallback, useEffect, useState } from "react";
import type { DaemonConnection } from "../daemon/connection";
import type { DaemonMessage, ServerConfigJson, ServerItem } from "../daemon/protocol";

export interface LogLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface ServersState {
  items: ServerItem[];
  config: "exists" | "missing" | "invalid" | "unknown";
  error?: string;
  proposal: ServerConfigJson[];
  path: string;
}

const MAX_LOG_LINES = 2000;
const EMPTY: ServersState = { items: [], config: "unknown", proposal: [], path: ".harness/launch.json" };

export function useServers(conn: DaemonConnection, sessionKey: string | null) {
  const [state, setState] = useState<ServersState>(EMPTY);
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});

  const send = useCallback(
    (msg: Parameters<DaemonConnection["send"]>[0]) => {
      try {
        conn.send(msg);
        return true;
      } catch {
        return false;
      }
    },
    [conn],
  );

  const refresh = useCallback(() => send({ type: "server.list" }), [send]);

  useEffect(() => {
    setState(EMPTY);
    setLogs({});
    if (sessionKey) refresh();
  }, [sessionKey, refresh]);

  useEffect(() => {
    return conn.onMessage((msg: DaemonMessage) => {
      switch (msg.type) {
        case "servers":
          setState({
            items: msg.items,
            config: msg.config,
            error: msg.error,
            proposal: msg.proposal ?? [],
            path: msg.path,
          });
          return;
        case "server.status":
          setState((s) => {
            if (!s.items.some((i) => i.name === msg.name)) return s;
            return {
              ...s,
              items: s.items.map((i) =>
                i.name === msg.name
                  ? { ...i, state: msg.state, port: msg.port, url: msg.url, error: msg.error, last_lines: msg.last_lines }
                  : i,
              ),
            };
          });
          if (msg.state === "starting") setLogs((l) => ({ ...l, [msg.name]: [] }));
          return;
        case "server.log": {
          const lines = msg.text.split("\n").map((text) => ({ stream: msg.stream, text }));
          setLogs((l) => ({ ...l, [msg.name]: [...(l[msg.name] ?? []), ...lines].slice(-MAX_LOG_LINES) }));
          return;
        }
        case "server.logs":
          setLogs((l) => ({ ...l, [msg.name]: msg.lines.slice(-MAX_LOG_LINES) }));
          return;
      }
    });
  }, [conn]);

  return {
    ...state,
    logs,
    refresh,
    start: (name: string) => send({ type: "server.start", name }),
    stop: (name: string) => send({ type: "server.stop", name }),
    stopAll: () => send({ type: "server.stop", all: true }),
    restart: (name: string) => send({ type: "server.restart", name }),
    save: (servers: ServerConfigJson[]) => send({ type: "server.save", servers }),
    loadLogs: (name: string) => send({ type: "server.logs", name }),
  };
}

export type ServersApi = ReturnType<typeof useServers>;
