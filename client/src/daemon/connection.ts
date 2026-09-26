import type { ClientMessage, DaemonMessage, HostInfo } from "./protocol";

export interface Hello {
  version: string;
  host: HostInfo;
}

export type ConnectionStatus = "connecting" | "open" | "closed";

type MessageListener = (msg: DaemonMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

const AUTH_TIMEOUT_MS = 10_000;

/** One WebSocket connection to a daemon. */
export class DaemonConnection {
  private ws: WebSocket | null = null;
  private messageListeners = new Set<MessageListener>();
  private statusListeners = new Set<StatusListener>();
  status: ConnectionStatus = "closed";

  /** Opens the socket and sends the token. Resolves on `auth.ok` with the daemon version and host. */
  connect(host: string, port: number, token: string): Promise<Hello> {
    this.close();
    this.setStatus("connecting");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}/ws`);
      this.ws = ws;
      let authed = false;
      const timer = window.setTimeout(() => {
        if (!authed) {
          ws.close();
          reject(new Error("The daemon did not reply to the token."));
        }
      }, AUTH_TIMEOUT_MS);

      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token } satisfies ClientMessage));
      ws.onmessage = (event) => {
        let msg: DaemonMessage;
        try {
          msg = JSON.parse(event.data as string) as DaemonMessage;
        } catch {
          return;
        }
        if (!authed && msg.type === "auth.ok") {
          authed = true;
          window.clearTimeout(timer);
          this.setStatus("open");
          resolve({ version: msg.version, host: msg.host });
          return;
        }
        this.messageListeners.forEach((fn) => fn(msg));
      };
      ws.onclose = (event) => {
        window.clearTimeout(timer);
        if (this.ws === ws) {
          this.ws = null;
          this.setStatus("closed");
        }
        if (!authed) {
          reject(new Error(event.code === 4401 ? "The daemon refused the token." : "Cannot connect to the daemon."));
        }
      };
    });
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.status !== "open") {
      throw new Error("The connection to the daemon is closed.");
    }
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setStatus("closed");
  }

  onMessage(fn: MessageListener): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((fn) => fn(status));
  }
}
