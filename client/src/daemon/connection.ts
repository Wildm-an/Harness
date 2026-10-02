import type { ClientMessage, DaemonMessage, HostInfo } from "./protocol";

export interface Hello {
  version: string;
  host: HostInfo;
  updatable?: boolean; // The daemon can install an update from the app. An old daemon does not say.
}

export type ConnectionStatus = "connecting" | "open" | "closed";

type MessageListener = (msg: DaemonMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

const AUTH_TIMEOUT_MS = 10_000;
/** checkAlive waits this long for a reply. */
export const ALIVE_TIMEOUT_MS = 5_000;

/** One WebSocket connection to a daemon. */
export class DaemonConnection {
  private ws: WebSocket | null = null;
  private messageListeners = new Set<MessageListener>();
  private statusListeners = new Set<StatusListener>();
  private aliveWaiters = new Set<() => void>(); // checkAlive calls that wait for a message.
  status: ConnectionStatus = "closed";
  /**
   * The session that the app shows. The daemon adds a session_id to the events of a session.
   * The listeners do not get the events of another session, for example events that the daemon
   * sent before it got "session.leave".
   */
  sessionId: string | null = null;

  /** Opens the socket and sends the token. Resolves on `auth.ok` with the daemon version and host. */
  connect(host: string, port: number, token: string): Promise<Hello> {
    this.close();
    this.sessionId = null;
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
        // Any message shows that the connection is alive.
        this.aliveWaiters.forEach((fn) => fn());
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
          resolve({ version: msg.version, host: msg.host, updatable: msg.updatable });
          return;
        }
        if (msg.type === "session.ready") this.sessionId = msg.session_id;
        else if (!this.forCurrentSession(msg)) return;
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

  /**
   * Checks that the socket is alive: it sends a ping and waits for any message. After a sleep of
   * the computer, a socket can look open but be dead. Then this drops it, and the status is "closed".
   * An older daemon without "ping" replies with an error, and that also counts as alive.
   */
  checkAlive(timeoutMs = ALIVE_TIMEOUT_MS): Promise<boolean> {
    const ws = this.ws;
    if (!ws || this.status !== "open") return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (alive: boolean) => {
        window.clearTimeout(timer);
        this.aliveWaiters.delete(onMessage);
        if (!alive && this.ws === ws) this.drop(ws);
        resolve(alive);
      };
      const onMessage = () => finish(true);
      const timer = window.setTimeout(() => finish(false), timeoutMs);
      this.aliveWaiters.add(onMessage);
      try {
        ws.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
      } catch {
        finish(false);
      }
    });
  }

  /** Forgets a dead socket at once. Its close event can come much later. */
  private drop(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // The socket is already closed.
    }
    this.ws = null;
    this.setStatus("closed");
  }

  /** Shows the start screen: the daemon stops the events of the session. Its running turn continues. */
  leaveSession(): void {
    if (this.sessionId === null) return;
    this.sessionId = null;
    if (this.status === "open") this.send({ type: "session.leave" });
  }

  private forCurrentSession(msg: DaemonMessage): boolean {
    const id = (msg as { session_id?: unknown }).session_id;
    return typeof id !== "string" || id === this.sessionId;
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
