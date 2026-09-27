// The state of the Cookbook screen (SPEC.md section 7). The daemon does the work: hardware
// detection, the Hugging Face search, downloads, and serve control, locally or through SSH.

import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonConnection } from "../daemon/connection";
import type {
  ClientMessage,
  CookbookHost,
  DaemonMessage,
  DownloadItem,
  HardwareInfo,
  HfDetail,
  HfItem,
  HfSearchFilters,
  InstalledRepo,
  ServeItem,
} from "../daemon/protocol";
import { loadPref, savePref } from "../lib/prefs";

export interface SearchState {
  query: string;
  filters: HfSearchFilters;
  sort: string;
  items: HfItem[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  hardware: boolean; // The fit badges use the hardware of the host.
  done: boolean; // A search ran.
}

const DEFAULT_FILTERS: HfSearchFilters = { library: "gguf", task: "text-generation", params: null, fit_only: false };

// The message types of the Cookbook: an error with one of these refs goes to the Cookbook screen.
const REFS = [
  "cookbook.hosts", "cookbook.host.save", "cookbook.host.delete", "cookbook.ssh_key", "cookbook.hardware",
  "hf.token", "hf.search", "hf.model", "hf.download", "download.pause", "download.resume", "download.cancel",
  "models.installed", "models.delete", "serve.list", "serve.start", "serve.stop", "serve.output",
];

export function useCookbook(conn: DaemonConnection, active: boolean) {
  const [host, setHostState] = useState(() => loadPref("cookbookHost", "local"));
  const [hosts, setHosts] = useState<CookbookHost[]>([]);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [hardware, setHardware] = useState<Record<string, HardwareInfo | "loading">>({});
  const [search, setSearch] = useState<SearchState>({
    query: "", filters: DEFAULT_FILTERS, sort: "downloads", items: [], page: 0, hasMore: false, loading: false,
    hardware: false, done: false,
  });
  const [detail, setDetail] = useState<HfDetail | "loading" | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadItem>>({});
  const [installed, setInstalled] = useState<Record<string, { repos: InstalledRepo[]; cache: string } | "loading">>({});
  const [serves, setServes] = useState<Record<string, ServeItem[]>>({});
  const [output, setOutput] = useState<{ host: string; name: string; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ready, setReady] = useState<{ model: string; key: number } | null>(null); // A served model that started.
  const hostRef = useRef(host);
  hostRef.current = host;

  const send = useCallback(
    (msg: ClientMessage) => {
      try {
        conn.send(msg);
        return true;
      } catch (e) {
        setErrors((x) => ({ ...x, [msg.type]: e instanceof Error ? e.message : String(e) }));
        return false;
      }
    },
    [conn],
  );

  const clearError = useCallback((ref: string) => setErrors((x) => {
    if (!(ref in x)) return x;
    const { [ref]: _gone, ...rest } = x;
    return rest;
  }), []);

  useEffect(
    () =>
      conn.onMessage((msg: DaemonMessage) => {
        switch (msg.type) {
          case "cookbook.hosts":
            setHosts(msg.items);
            setPublicKey(msg.public_key);
            setKeyPath(msg.key_path);
            if (!msg.items.some((h) => h.name === hostRef.current)) setHostState("local");
            return;
          case "hardware":
            setHardware((h) => ({ ...h, [msg.host]: msg.info }));
            clearError("cookbook.hardware");
            return;
          case "hf.results":
            setSearch((s) => ({
              ...s,
              items: msg.page === 0 ? msg.items : [...s.items, ...msg.items],
              page: msg.page,
              hasMore: msg.has_more,
              loading: false,
              hardware: msg.hardware,
              done: true,
            }));
            return;
          case "hf.detail": {
            const { type: _type, ...rest } = msg;
            setDetail(rest);
            return;
          }
          case "downloads":
            setDownloads(Object.fromEntries(msg.items.map((d) => [d.id, d])));
            return;
          case "download.progress": {
            const { type: _type, ...item } = msg;
            setDownloads((d) => ({ ...d, [item.id]: item }));
            if (item.state === "done") send({ type: "models.installed", host: item.host });
            return;
          }
          case "installed":
            setInstalled((i) => ({ ...i, [msg.host]: { repos: msg.repos, cache: msg.cache } }));
            return;
          case "serves":
            setServes((s) => ({ ...s, [msg.host]: msg.items }));
            return;
          case "serve.status":
            setServes((s) => {
              const list = s[msg.host] ?? [];
              if (msg.state === "stopped") return { ...s, [msg.host]: list.filter((x) => x.name !== msg.name) };
              return { ...s, [msg.host]: list.map((x) => (x.name === msg.name ? { ...x, state: msg.state } : x)) };
            });
            if (msg.state !== "stopped") send({ type: "serve.list", host: msg.host });
            if (msg.state === "running" && msg.model) setReady((r) => ({ model: msg.model!, key: (r?.key ?? 0) + 1 }));
            if (msg.error) setErrors((x) => ({ ...x, "serve.start": `${msg.name}: ${msg.error}` }));
            return;
          case "serve.output":
            setOutput({ host: msg.host, name: msg.name, text: msg.text });
            return;
          case "error":
            if (msg.ref && REFS.includes(msg.ref)) {
              setErrors((x) => ({ ...x, [msg.ref!]: msg.message }));
              if (msg.ref === "hf.search") setSearch((s) => ({ ...s, loading: false }));
              if (msg.ref === "hf.model") setDetail(null);
              if (msg.ref === "cookbook.hardware") setHardware((h) => {
                const { [hostRef.current]: _gone, ...rest } = h;
                return rest;
              });
              if (msg.ref === "models.installed") setInstalled((i) => {
                const { [hostRef.current]: _gone, ...rest } = i;
                return rest;
              });
            }
            return;
        }
      }),
    [conn, send, clearError],
  );

  // Load the lists when the screen opens, and for each host.
  useEffect(() => {
    if (!active) return;
    send({ type: "cookbook.hosts" });
    send({ type: "downloads.list" });
  }, [active, send]);

  useEffect(() => {
    if (!active) return;
    setHardware((h) => (h[host] ? h : { ...h, [host]: "loading" }));
    send({ type: "cookbook.hardware", host });
    send({ type: "serve.list", host });
  }, [active, host, send]);

  const setHost = (name: string) => {
    setHostState(name);
    savePref("cookbookHost", name);
    setDetail(null);
  };

  const runSearch = (next: Partial<Pick<SearchState, "query" | "filters" | "sort">>, page = 0) => {
    const merged = { ...search, ...next };
    setSearch({ ...merged, loading: true, ...(page === 0 ? { items: [], hasMore: false } : {}) });
    clearError("hf.search");
    send({ type: "hf.search", query: merged.query, filters: merged.filters, sort: merged.sort, page, host });
  };

  return {
    host,
    setHost,
    hosts,
    publicKey,
    keyPath,
    hardware: hardware[host] ?? null,
    refreshHardware: () => {
      setHardware((h) => ({ ...h, [host]: "loading" }));
      clearError("cookbook.hardware");
      send({ type: "cookbook.hardware", host, refresh: true });
    },
    search,
    runSearch,
    moreResults: () => runSearch({}, search.page + 1),
    detail,
    openModel: (repoId: string) => {
      setDetail("loading");
      clearError("hf.model");
      send({ type: "hf.model", repo_id: repoId, host });
    },
    closeModel: () => setDetail(null),
    downloads: Object.values(downloads).sort((a, b) => b.started - a.started),
    download: (repoId: string, files: string[]) => {
      clearError("hf.download");
      send({ type: "hf.download", repo_id: repoId, files, host });
    },
    pause: (id: string) => send({ type: "download.pause", id }),
    resume: (id: string) => send({ type: "download.resume", id }),
    cancel: (id: string) => send({ type: "download.cancel", id }),
    installed: installed[host] ?? null,
    loadInstalled: () => {
      setInstalled((i) => ({ ...i, [host]: "loading" }));
      clearError("models.installed");
      send({ type: "models.installed", host });
    },
    deleteModel: (repoId: string, files: string[]) => send({ type: "models.delete", host, repo_id: repoId, files }),
    serves: serves[host] ?? [],
    loadServes: () => send({ type: "serve.list", host }),
    serve: (repoId: string, file: string, context?: number, port?: number) => {
      clearError("serve.start");
      send({ type: "serve.start", host, repo_id: repoId, file, ...(context ? { context } : {}), ...(port ? { port } : {}) });
    },
    stopServe: (name: string) => send({ type: "serve.stop", host, name }),
    output,
    loadOutput: (name: string) => send({ type: "serve.output", host, name }),
    saveHost: (h: { name: string; ssh?: string; python?: string; llama_server?: string; previous?: string }) => {
      clearError("cookbook.host.save");
      send({ type: "cookbook.host.save", ...h });
    },
    deleteHost: (name: string) => send({ type: "cookbook.host.delete", name }),
    createKey: () => send({ type: "cookbook.ssh_key" }),
    errors,
    clearError,
    ready,
  };
}

export type CookbookApi = ReturnType<typeof useCookbook>;

// -- formats ---------------------------------------------------------------------------------------

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (!n) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** A parameter count as "7.6B" or "350M". */
export function formatParams(n: number | null | undefined): string | null {
  if (!n) return null;
  return n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `${Math.round(n / 1e6)}M`;
}

export function formatTokens(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}
