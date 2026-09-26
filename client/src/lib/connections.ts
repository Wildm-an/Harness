// Daemon connections (SPEC.md sections 8.1–8.3).
//
// - "local": the sidecar daemon that the desktop app starts.
// - "direct": a daemon that the client reaches on its own address, for example over Tailscale.
// - "ssh": a daemon on 127.0.0.1 of a remote host, through an SSH tunnel that the app opens.
//
// The list has no secrets and is kept in local storage. The tokens are in the keychain of the
// operating system. In a normal browser (development) there is no keychain: the token stays in
// session storage and is lost when the tab closes.

import { isTauri, localDaemonInfo, secretDelete, secretGet, secretSet, tunnelClose, tunnelOpen } from "./tauri";

export type ConnectionKind = "local" | "direct" | "ssh";

export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  host: string; // direct: the daemon host. ssh: the SSH host.
  port: number; // The daemon port (on the remote host for ssh).
  sshUser?: string;
  sshPort?: number;
  identityFile?: string;
}

export interface Target {
  host: string;
  port: number;
  token: string;
}

export const LOCAL: Connection = { id: "local", name: "This computer", kind: "local", host: "127.0.0.1", port: 0 };

const LIST_KEY = "harness.connections";
const LAST_KEY = "harness.lastConnection";

function read<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(storage: () => Storage, key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable. The list is then kept only in memory.
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

export function loadConnections(): Connection[] {
  const saved = read<Connection[]>(local, LIST_KEY, []).filter((c) => c && c.id !== LOCAL.id);
  return [LOCAL, ...saved];
}

export function saveConnections(list: Connection[]): void {
  write(local, LIST_KEY, list.filter((c) => c.id !== LOCAL.id));
}

export function lastConnectionId(): string {
  return read<string>(local, LAST_KEY, LOCAL.id);
}

export function setLastConnectionId(id: string): void {
  write(local, LAST_KEY, id);
}

export function newConnectionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const secretKey = (id: string) => `connection:${id}`;

export async function loadToken(id: string): Promise<string | null> {
  if (isTauri()) return secretGet(secretKey(id));
  return read<string | null>(session, `harness.token.${id}`, null);
}

export async function saveToken(id: string, token: string): Promise<void> {
  if (isTauri()) return secretSet(secretKey(id), token);
  write(session, `harness.token.${id}`, token);
}

export async function deleteToken(id: string): Promise<void> {
  if (isTauri()) return secretDelete(secretKey(id));
  try {
    session().removeItem(`harness.token.${id}`);
  } catch {
    // Nothing to remove.
  }
}

export function describe(c: Connection): string {
  if (c.kind === "local") return "The daemon runs on this computer.";
  if (c.kind === "direct") return `${c.host}:${c.port}`;
  const user = c.sshUser ? `${c.sshUser}@` : "";
  const sshPort = c.sshPort && c.sshPort !== 22 ? `:${c.sshPort}` : "";
  return `SSH ${user}${c.host}${sshPort}, daemon port ${c.port}`;
}

/**
 * Finds the address and the token of a connection. For "ssh", opens the tunnel first.
 * ``restart`` starts a new local daemon. ``token`` replaces the saved token (for a test).
 */
export async function resolveTarget(c: Connection, restart = false, tokenOverride?: string): Promise<Target> {
  if (c.kind === "local") {
    if (!isTauri()) throw new Error("The local daemon needs the desktop app. Add a remote daemon for browser use.");
    return localDaemonInfo(restart);
  }
  const token = tokenOverride ?? (await loadToken(c.id));
  if (!token) throw new Error("There is no token for this connection. Edit the connection and enter the token.");
  if (c.kind === "direct") return { host: c.host, port: c.port, token };
  if (!isTauri()) throw new Error("SSH tunnels need the desktop app.");
  const port = await tunnelOpen({
    id: c.id,
    sshHost: c.host,
    sshUser: c.sshUser || undefined,
    sshPort: c.sshPort || undefined,
    identityFile: c.identityFile || undefined,
    remotePort: c.port,
  });
  return { host: "127.0.0.1", port, token };
}

export async function closeTunnel(c: Connection): Promise<void> {
  if (c.kind === "ssh" && isTauri()) await tunnelClose(c.id);
}

/** Checks a connection form. Returns an error text for each bad field. */
export function validate(c: Connection, token: string, tokenRequired: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!c.name.trim()) errors.name = "Enter a name.";
  if (!c.host.trim()) errors.host = "Enter a host.";
  else if (/\s/.test(c.host) || c.host.startsWith("-")) errors.host = "The host cannot have spaces or start with -.";
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) errors.port = "Enter a port from 1 to 65535.";
  if (c.kind === "ssh") {
    if (c.sshUser && (/\s/.test(c.sshUser) || c.sshUser.startsWith("-"))) errors.sshUser = "The user cannot have spaces or start with -.";
    if (c.sshPort !== undefined && (!Number.isInteger(c.sshPort) || c.sshPort < 1 || c.sshPort > 65535)) {
      errors.sshPort = "Enter a port from 1 to 65535.";
    }
  }
  if (tokenRequired && !token.trim()) errors.token = "Enter the token of the daemon.";
  return errors;
}
