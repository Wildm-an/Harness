// The state of the code editor (SPEC.md section 8.5). The editor reads and writes files
// through the daemon, so it works the same way for a local and a remote daemon.
//
// Each open file has a Monaco model. The model keeps the undo history; the React state
// keeps only what the UI shows (the hash, the modified mark, and the notices).

import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonConnection } from "../daemon/connection";
import type { DaemonMessage } from "../daemon/protocol";
import { languageFor, monaco } from "../lib/monaco";
import { normalizePath } from "./paths";

export type Notice =
  | { kind: "external"; hash: string | null; by: "agent" | "external" } // The file changed on disk. The tab has changes.
  | { kind: "conflict"; hash: string | null } // A save stopped: the file changed after the editor read it.
  | { kind: "deleted" };

export interface OpenFile {
  path: string;
  hash: string | null; // The hash of the disk version that the editor content is based on.
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  error?: string;
  notice?: Notice;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

export interface SearchState {
  query: string;
  busy: boolean;
  items: { path: string; line: number; text: string }[];
  truncated: boolean;
  error: string | null;
}

export interface Compare {
  path: string;
  disk: string;
  diskHash: string | null;
}

export interface Reveal {
  path: string;
  line: number;
  key: number;
}

type ReadPurpose = "open" | "reload" | "compare";

interface ModelEntry {
  model: monaco.editor.ITextModel;
  savedVersion: number;
  savingVersion: number | null;
  listener: monaco.IDisposable;
}

export function modelUri(sessionKey: string, path: string): monaco.Uri {
  return monaco.Uri.from({ scheme: "harness", authority: sessionKey || "none", path: `/${path}` });
}

export function useEditor(conn: DaemonConnection, sessionKey: string | null, cwd: string) {
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [tree, setTree] = useState<Record<string, TreeEntry[] | "loading">>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState<SearchState>({ query: "", busy: false, items: [], truncated: false, error: null });
  const [compare, setCompare] = useState<Compare | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const models = useRef(new Map<string, ModelEntry>());
  const reads = useRef<{ path: string; purpose: ReadPurpose }[]>([]); // The daemon replies in order.
  const filesRef = useRef(files);
  filesRef.current = files;
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const revealKey = useRef(0);

  const patchFile = useCallback((path: string, patch: Partial<OpenFile>) => {
    setFiles((list) => list.map((f) => (f.path === path ? { ...f, ...patch } : f)));
  }, []);

  const send = useCallback(
    (msg: Parameters<DaemonConnection["send"]>[0]): boolean => {
      try {
        conn.send(msg);
        return true;
      } catch {
        return false;
      }
    },
    [conn],
  );

  const read = useCallback(
    (path: string, purpose: ReadPurpose) => {
      reads.current.push({ path, purpose });
      if (!send({ type: "fs.read", path })) reads.current.pop();
    },
    [send],
  );

  const listDir = useCallback(
    (dir: string) => {
      setTree((t) => ({ ...t, [dir]: t[dir] && t[dir] !== "loading" ? t[dir] : "loading" }));
      send({ type: "fs.list", path: dir });
    },
    [send],
  );

  const disposeAll = useCallback(() => {
    for (const entry of models.current.values()) {
      entry.listener.dispose();
      entry.model.dispose();
    }
    models.current.clear();
  }, []);

  // A new session has other files.
  useEffect(() => {
    disposeAll();
    reads.current = [];
    setFiles([]);
    setActive(null);
    setTree({});
    setExpanded(new Set());
    setCompare(null);
    setSearch({ query: "", busy: false, items: [], truncated: false, error: null });
    if (sessionKey) listDir(".");
    return disposeAll;
  }, [sessionKey, disposeAll, listDir]);

  const setModelContent = useCallback(
    (path: string, content: string, keepUndo: boolean) => {
      let entry = models.current.get(path);
      if (!entry) {
        const model = monaco.editor.createModel(content, languageFor(path), modelUri(sessionKey ?? "", path));
        const listener = model.onDidChangeContent(() => {
          const e = models.current.get(path);
          if (!e) return;
          const dirty = model.getAlternativeVersionId() !== e.savedVersion;
          if (filesRef.current.find((f) => f.path === path)?.dirty !== dirty) patchFile(path, { dirty });
        });
        entry = { model, savedVersion: model.getAlternativeVersionId(), savingVersion: null, listener };
        models.current.set(path, entry);
        return;
      }
      if (entry.model.getValue() !== content) {
        if (keepUndo) {
          // An edit operation keeps the undo history: the user can undo an agent change.
          entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: content }], () => null);
        } else {
          entry.model.setValue(content);
        }
      }
      entry.savedVersion = entry.model.getAlternativeVersionId();
    },
    [sessionKey, patchFile],
  );

  // Daemon messages for the editor.
  useEffect(() => {
    return conn.onMessage((msg: DaemonMessage) => {
      switch (msg.type) {
        case "fs.tree":
          setTree((t) => ({ ...t, [msg.path]: msg.items as TreeEntry[] }));
          return;
        case "fs.content": {
          const index = reads.current.findIndex((r) => r.path === msg.path);
          if (index < 0) return;
          const [{ purpose }] = reads.current.splice(index, 1);
          if (purpose === "compare") {
            setCompare({ path: msg.path, disk: msg.content, diskHash: msg.hash });
            return;
          }
          setModelContent(msg.path, msg.content, purpose === "reload");
          patchFile(msg.path, { hash: msg.hash, loading: false, dirty: false, notice: undefined, error: undefined });
          return;
        }
        case "fs.saved": {
          const entry = models.current.get(msg.path);
          if (entry && entry.savingVersion !== null) {
            entry.savedVersion = entry.savingVersion;
            entry.savingVersion = null;
          }
          const dirty = entry ? entry.model.getAlternativeVersionId() !== entry.savedVersion : false;
          patchFile(msg.path, { hash: msg.hash, saving: false, dirty, notice: undefined });
          return;
        }
        case "fs.conflict":
          patchFile(msg.path, { saving: false, notice: { kind: "conflict", hash: msg.disk_hash } });
          return;
        case "fs.changed": {
          const file = filesRef.current.find((f) => f.path === msg.path);
          if (file && msg.hash !== file.hash && !file.loading) {
            if (msg.hash === null) patchFile(msg.path, { notice: { kind: "deleted" } });
            else if (!file.dirty) read(msg.path, "reload");
            else patchFile(msg.path, { notice: { kind: "external", hash: msg.hash, by: msg.by } });
          }
          // A new file: show it in its folder, if the tree shows that folder.
          const dir = msg.path.includes("/") ? msg.path.slice(0, msg.path.lastIndexOf("/")) : ".";
          const listing = treeRef.current[dir];
          if (Array.isArray(listing) && !listing.some((e) => e.path === msg.path) && msg.hash !== null) listDir(dir);
          return;
        }
        case "fs.results":
          setSearch((s) => ({ ...s, busy: false, items: msg.items, truncated: msg.truncated, error: null }));
          return;
        case "error":
          if (msg.ref === "fs.read") {
            const failed = reads.current.shift();
            if (failed?.purpose === "open") patchFile(failed.path, { loading: false, error: msg.message });
          } else if (msg.ref === "fs.write") {
            setFiles((list) => list.map((f) => (f.saving ? { ...f, saving: false, error: msg.message } : f)));
          } else if (msg.ref === "fs.search") {
            setSearch((s) => ({ ...s, busy: false, error: msg.message }));
          } else if (msg.ref === "fs.list") {
            setTree((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== "loading")));
          }
          return;
      }
    });
  }, [conn, patchFile, read, listDir, setModelContent]);

  const openFile = useCallback(
    (rawPath: string, line?: number) => {
      const path = normalizePath(rawPath, cwd);
      if (!path) return;
      setActive(path);
      setCompare(null);
      if (line) setReveal({ path, line, key: ++revealKey.current });
      if (filesRef.current.some((f) => f.path === path)) return;
      setFiles((list) => [...list, { path, hash: null, dirty: false, loading: true, saving: false }]);
      read(path, "open");
    },
    [cwd, read],
  );

  const closeFile = useCallback(
    (path: string) => {
      const entry = models.current.get(path);
      if (entry) {
        entry.listener.dispose();
        entry.model.dispose();
        models.current.delete(path);
      }
      send({ type: "fs.unwatch", path });
      setFiles((list) => {
        const index = list.findIndex((f) => f.path === path);
        const next = list.filter((f) => f.path !== path);
        setActive((a) => (a === path ? (next[Math.max(0, index - 1)]?.path ?? null) : a));
        return next;
      });
      setCompare((c) => (c?.path === path ? null : c));
    },
    [send],
  );

  const save = useCallback(
    (path: string, baseHash?: string | null) => {
      const entry = models.current.get(path);
      const file = filesRef.current.find((f) => f.path === path);
      if (!entry || !file || file.loading) return;
      entry.savingVersion = entry.model.getAlternativeVersionId();
      patchFile(path, { saving: true, error: undefined });
      const base = baseHash === undefined ? file.hash : baseHash;
      if (!send({ type: "fs.write", path, content: entry.model.getValue(), base_hash: base })) {
        patchFile(path, { saving: false, error: "The connection to the daemon is closed." });
      }
    },
    [patchFile, send],
  );

  /** The answer to a notice: keep the editor version, load the disk version, or compare them. */
  const resolveNotice = useCallback(
    (path: string, action: "keep" | "load" | "compare" | "overwrite") => {
      const file = filesRef.current.find((f) => f.path === path);
      const notice = file?.notice;
      if (!file || !notice) return;
      const diskHash = notice.kind === "deleted" ? null : notice.hash;
      if (action === "load") read(path, "reload");
      else if (action === "compare") read(path, "compare");
      else if (action === "overwrite") save(path, diskHash);
      else patchFile(path, { hash: diskHash, notice: undefined }); // keep: the next save replaces the disk version.
    },
    [read, save, patchFile],
  );

  /** The answer in the compare view. */
  const finishCompare = useCallback(
    (action: "mine" | "disk" | "close") => {
      const current = compare;
      setCompare(null);
      if (!current || action === "close") return;
      if (action === "mine") {
        save(current.path, current.diskHash);
      } else {
        setModelContent(current.path, current.disk, true);
        patchFile(current.path, { hash: current.diskHash, dirty: false, notice: undefined });
      }
    },
    [compare, save, setModelContent, patchFile],
  );

  const toggleDir = useCallback(
    (dir: string) => {
      setExpanded((set) => {
        const next = new Set(set);
        if (next.has(dir)) next.delete(dir);
        else {
          next.add(dir);
          if (!treeRef.current[dir]) listDir(dir);
        }
        return next;
      });
    },
    [listDir],
  );

  const refreshTree = useCallback(() => {
    listDir(".");
    for (const dir of expanded) listDir(dir);
  }, [expanded, listDir]);

  const runSearch = useCallback(
    (query: string, options: { regex: boolean; case: boolean; glob: string }) => {
      if (!query.trim()) return;
      setSearch({ query, busy: true, items: [], truncated: false, error: null });
      if (!send({ type: "fs.search", query, regex: options.regex, case: options.case, glob: options.glob || undefined })) {
        setSearch((s) => ({ ...s, busy: false, error: "The connection to the daemon is closed." }));
      }
    },
    [send],
  );

  return {
    files,
    active,
    setActive,
    tree,
    expanded,
    search,
    compare,
    reveal,
    models,
    openFile,
    closeFile,
    save,
    resolveNotice,
    finishCompare,
    toggleDir,
    refreshTree,
    runSearch,
  };
}

export type EditorApi = ReturnType<typeof useEditor>;
