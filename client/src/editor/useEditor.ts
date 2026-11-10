// The state of the code editor (SPEC.md section 8.5). The editor reads and writes files
// through the daemon, so it works the same way for a local and a remote daemon.
//
// Each open file has a Monaco model. The model keeps the undo history; the React state
// keeps only what the UI shows (the hash, the modified mark, and the notices).

import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonConnection } from "../daemon/connection";
import type { DaemonMessage, GitFileState } from "../daemon/protocol";
import { languageFor, monaco } from "../lib/monaco";
import { absolutePath, normalizePath, renamedPath } from "./paths";
import { withOpened } from "./tabs";
import { withMoved } from "../lib/tabDrag";

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
  pinned: boolean; // false: the next file that opens takes the place of this tab (tabs.ts).
  error?: string; // The file did not open: the editor has no text to show.
  saveError?: string; // A save failed: the editor keeps the text, and the bar offers "Try again".
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
  // The git state of the changed files (the colors of the tree), and the files that match the filter.
  const [gitStatus, setGitStatus] = useState<Record<string, GitFileState>>({});
  const [found, setFound] = useState<{ query: string; items: string[] } | null>(null);
  const findQuery = useRef("");
  const statusTimer = useRef(0);

  const models = useRef(new Map<string, ModelEntry>());
  const reads = useRef<{ path: string; purpose: ReadPurpose }[]>([]); // The daemon replies in order.
  // The open files, current at once. All changes go through updateFiles: two changes in one tick
  // (a rename closes and opens tabs) each see the result of the change before.
  const filesRef = useRef(files);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const activeRef = useRef(active);
  activeRef.current = active;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const revealKey = useRef(0);
  const applying = useRef(false); // true while setModelContent puts the disk content in a model.
  const [createError, setCreateError] = useState<string | null>(null); // New file or New folder failed.
  const openFileRef = useRef<(path: string, line?: number, pin?: boolean) => void>(() => {});
  const closeFileRef = useRef<(path: string) => void>(() => {});
  // The editor autocomplete request that waits for the daemon. A new request ends the old one.
  const completion = useRef<{ id: string; resolve: (text: string | null) => void } | null>(null);
  const completionCount = useRef(0);

  const updateFiles = useCallback((change: (list: OpenFile[]) => OpenFile[]) => {
    const next = change(filesRef.current);
    if (next === filesRef.current) return;
    filesRef.current = next;
    setFiles(next);
  }, []);

  const patchFile = useCallback(
    (path: string, patch: Partial<OpenFile>) => {
      updateFiles((list) => (list.some((f) => f.path === path) ? list.map((f) => (f.path === path ? { ...f, ...patch } : f)) : list));
    },
    [updateFiles],
  );

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

  // Ask for the git state again after a short wait: several changes in a row give one request.
  const requestGitStatus = useCallback(() => {
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => send({ type: "git.status" }), 300);
  }, [send]);

  const disposeAll = useCallback(() => {
    for (const entry of models.current.values()) {
      entry.listener.dispose();
      entry.model.dispose();
    }
    models.current.clear();
  }, []);

  // A new session, or a session in another folder, has other files.
  useEffect(() => {
    disposeAll();
    reads.current = [];
    updateFiles(() => []);
    setActive(null);
    setTree({});
    setExpanded(new Set());
    setCompare(null);
    setSearch({ query: "", busy: false, items: [], truncated: false, error: null });
    setGitStatus({});
    setFound(null);
    findQuery.current = "";
    if (sessionKey) {
      listDir(".");
      requestGitStatus();
    }
    return disposeAll;
  }, [sessionKey, cwd, disposeAll, listDir, requestGitStatus, updateFiles]);

  // Changes by other programs (a commit in a terminal, for example) show after a short time.
  useEffect(() => {
    if (!sessionKey) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) send({ type: "git.status" });
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [sessionKey, send]);

  const setModelContent = useCallback(
    (path: string, content: string, keepUndo: boolean) => {
      let entry = models.current.get(path);
      if (!entry) {
        const model = monaco.editor.createModel(content, languageFor(path), modelUri(sessionKey ?? "", path));
        const listener = model.onDidChangeContent(() => {
          const e = models.current.get(path);
          if (!e || applying.current) return; // Content from the disk is not a change by the user.
          const dirty = model.getAlternativeVersionId() !== e.savedVersion;
          // A change in an unpinned tab pins it: the next file must not take the place of the changes.
          if (filesRef.current.find((f) => f.path === path)?.dirty !== dirty) patchFile(path, dirty ? { dirty, pinned: true } : { dirty });
        });
        entry = { model, savedVersion: model.getAlternativeVersionId(), savingVersion: null, listener };
        models.current.set(path, entry);
        return;
      }
      if (entry.model.getValue() !== content) {
        // The callers set the modified mark after this. The listener must not pin the tab here.
        applying.current = true;
        try {
          if (keepUndo) {
            // An edit operation keeps the undo history: the user can undo an agent change.
            entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: content }], () => null);
          } else {
            entry.model.setValue(content);
          }
        } finally {
          applying.current = false;
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
        case "editor.completion": {
          const pending = completion.current;
          if (pending?.id === msg.id) {
            completion.current = null;
            pending.resolve(msg.text);
          }
          return;
        }
        case "fs.tree":
          setTree((t) => ({ ...t, [msg.path]: msg.items as TreeEntry[] }));
          if (msg.path === ".") requestGitStatus(); // A new listing of the top folder: the colors too.
          return;
        case "git.status":
          setGitStatus(msg.files);
          return;
        case "fs.found":
          // The prompt box asks too ("@" files): only the reply to the filter of the tree counts here.
          if (msg.query === findQuery.current) setFound({ query: msg.query, items: msg.items });
          return;
        case "fs.content": {
          const index = reads.current.findIndex((r) => r.path === msg.path);
          if (index < 0) return;
          const [{ purpose }] = reads.current.splice(index, 1);
          if (purpose === "compare") {
            setCompare({ path: msg.path, disk: msg.content, diskHash: msg.hash });
            return;
          }
          // The tab closed, or another file took its place, before the content came.
          if (!filesRef.current.some((f) => f.path === msg.path)) return;
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
          patchFile(msg.path, { hash: msg.hash, saving: false, dirty, notice: undefined, saveError: undefined });
          requestGitStatus();
          return;
        }
        case "fs.created": {
          // Show the new file or folder: open its parent folders, and open a new file in the editor.
          const parts = msg.path.split("/");
          const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
          const dirs = msg.kind === "dir" ? [...parents, msg.path] : parents;
          setExpanded((set) => new Set([...set, ...dirs]));
          for (const dir of [".", ...dirs]) listDir(dir);
          setCreateError(null);
          if (msg.kind === "file") openFileRef.current(msg.path, undefined, true); // The user made it: its tab stays.
          requestGitStatus();
          return;
        }
        case "fs.deleted": {
          // Close the tabs of the item and of the files in it, forget its listings, and list its folder again.
          const gone = (p: string) => p === msg.path || p.startsWith(`${msg.path}/`);
          for (const f of filesRef.current) if (gone(f.path)) closeFileRef.current(f.path);
          setTree((t) => Object.fromEntries(Object.entries(t).filter(([dir]) => !gone(dir))));
          setExpanded((set) => new Set([...set].filter((dir) => !gone(dir))));
          listDir(msg.path.includes("/") ? msg.path.slice(0, msg.path.lastIndexOf("/")) : ".");
          setCreateError(null);
          requestGitStatus();
          return;
        }
        case "fs.renamed": {
          // Open the tabs again at the new paths (renameEntry allows no unsaved changes in them),
          // keep the open folders open, and list the folder of the item again.
          const moved = (p: string) => renamedPath(p, msg.path, msg.new_path);
          const open = filesRef.current.filter((f) => moved(f.path) !== null);
          const wasActive = activeRef.current;
          for (const f of open) closeFileRef.current(f.path);
          for (const f of open) openFileRef.current(moved(f.path)!, undefined, f.pinned);
          if (wasActive !== null) setActive(moved(wasActive) ?? wasActive);
          setTree((t) => Object.fromEntries(Object.entries(t).filter(([dir]) => moved(dir) === null)));
          setExpanded((set) => new Set([...set].map((dir) => moved(dir) ?? dir)));
          const parent = msg.new_path.includes("/") ? msg.new_path.slice(0, msg.new_path.lastIndexOf("/")) : ".";
          listDir(parent);
          for (const dir of expandedRef.current) {
            const next = moved(dir);
            if (next !== null) listDir(next);
          }
          setCreateError(null);
          requestGitStatus();
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
          requestGitStatus();
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
            updateFiles((list) => list.map((f) => (f.saving ? { ...f, saving: false, saveError: msg.message } : f)));
          } else if (msg.ref === "fs.search") {
            setSearch((s) => ({ ...s, busy: false, error: msg.message }));
          } else if (msg.ref === "fs.create" || msg.ref === "fs.delete" || msg.ref === "fs.rename") {
            setCreateError(msg.message); // The error line under the file tree head.
          } else if (msg.ref === "fs.list") {
            setTree((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== "loading")));
          }
          return;
      }
    });
  }, [conn, patchFile, updateFiles, read, listDir, setModelContent]);

  /** Forget the Monaco model of a file, and stop the watch of the file. */
  const release = useCallback(
    (path: string) => {
      const entry = models.current.get(path);
      if (entry) {
        entry.listener.dispose();
        entry.model.dispose();
        models.current.delete(path);
      }
      send({ type: "fs.unwatch", path });
    },
    [send],
  );

  /**
   * Open a file in a tab. The tab is unpinned (the name is in italics) unless ``pin`` is true: the
   * next file that opens takes the place of an unpinned tab. A file that is open only gets the focus.
   */
  const openFile = useCallback(
    (rawPath: string, line?: number, pin = false) => {
      const path = normalizePath(rawPath, cwd);
      if (!path) return;
      setActive(path);
      setCompare(null);
      if (line) setReveal({ path, line, key: ++revealKey.current });
      const isOpen = filesRef.current.some((f) => f.path === path);
      const entry: OpenFile = { path, hash: null, dirty: false, loading: true, saving: false, pinned: pin };
      const { list, replaced } = withOpened(filesRef.current, entry);
      if (replaced !== null) release(replaced);
      updateFiles(() => list);
      if (!isOpen) read(path, "open");
    },
    [cwd, read, release, updateFiles],
  );
  openFileRef.current = openFile;

  /** "Keep open": the tab stays when the next file opens. */
  const pinFile = useCallback((path: string) => patchFile(path, { pinned: true }), [patchFile]);

  /** A drag of a tab: the tab at the index ``from`` goes to the index ``to``. */
  const moveFile = useCallback((from: number, to: number) => updateFiles((list) => withMoved(list, from, to)), [updateFiles]);

  /** New file or New folder: the daemon makes it, and fs.created shows it. */
  const createEntry = useCallback(
    (path: string, kind: "file" | "dir"): boolean => {
      setCreateError(null);
      return send({ type: "fs.create", path, kind });
    },
    [send],
  );

  const closeFile = useCallback(
    (path: string) => {
      release(path);
      const index = filesRef.current.findIndex((f) => f.path === path);
      const next = filesRef.current.filter((f) => f.path !== path);
      updateFiles(() => next);
      setActive((a) => (a === path ? (next[Math.max(0, index - 1)]?.path ?? null) : a));
      setCompare((c) => (c?.path === path ? null : c));
    },
    [release, updateFiles],
  );

  closeFileRef.current = closeFile;

  /** Delete of the file tree: the daemon deletes the file or the folder, and fs.deleted updates the tree. */
  const deleteEntry = useCallback(
    (path: string): boolean => {
      setCreateError(null);
      return send({ type: "fs.delete", path });
    },
    [send],
  );

  /**
   * Rename of the file tree: a new name in the same folder. The daemon renames the item, and
   * fs.renamed updates the tree and the tabs. An open file with unsaved changes in the item
   * blocks the rename: the tab opens again from the disk, so the changes would be lost.
   */
  const renameEntry = useCallback(
    (path: string, name: string): boolean => {
      const unsaved = filesRef.current.find((f) => f.dirty && renamedPath(f.path, path, path) !== null);
      if (unsaved) {
        setCreateError(`Save or close ${unsaved.path} first. It has unsaved changes.`);
        return false;
      }
      setCreateError(null);
      return send({ type: "fs.rename", path, name });
    },
    [send],
  );

  /** The full path of a file of the session folder, for "Copy Path". */
  const fullPath = useCallback((path: string) => absolutePath(cwd, path), [cwd]);

  const save = useCallback(
    (path: string, baseHash?: string | null) => {
      const entry = models.current.get(path);
      const file = filesRef.current.find((f) => f.path === path);
      if (!entry || !file || file.loading) return;
      entry.savingVersion = entry.model.getAlternativeVersionId();
      patchFile(path, { saving: true, saveError: undefined });
      const base = baseHash === undefined ? file.hash : baseHash;
      if (!send({ type: "fs.write", path, content: entry.model.getValue(), base_hash: base })) {
        patchFile(path, { saving: false, saveError: "The connection to the daemon is closed." });
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
    requestGitStatus();
  }, [expanded, listDir, requestGitStatus]);

  /** "Collapse all": close all the open folders of the tree. */
  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  /** Open the folders down to ``path`` in the tree. ``open``: also open the folder ``path`` itself. */
  const showInTree = useCallback(
    (path: string, open: boolean) => {
      const parts = path.split("/").filter(Boolean);
      const dirs = parts.slice(0, open ? parts.length : -1).map((_, i) => parts.slice(0, i + 1).join("/"));
      for (const dir of dirs) if (!treeRef.current[dir]) listDir(dir);
      setExpanded((set) => new Set([...set, ...dirs]));
    },
    [listDir],
  );

  /** The files and folders whose names match ``query``, for the filter of the tree. Empty: no filter. */
  const findFiles = useCallback(
    (query: string) => {
      findQuery.current = query;
      if (!query) setFound(null);
      else send({ type: "fs.find", query });
    },
    [send],
  );

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

  /**
   * Ask the model for the text at the cursor (editor autocomplete). null: no completion, a newer
   * request replaced this one, or the signal ended it (the user typed on).
   */
  const complete = useCallback(
    (path: string, prefix: string, suffix: string, signal: AbortSignal): Promise<string | null> => {
      completion.current?.resolve(null);
      completion.current = null;
      const id = `c${++completionCount.current}`;
      return new Promise((resolve) => {
        const end = (text: string | null) => {
          if (completion.current?.id === id) completion.current = null;
          resolve(text);
        };
        completion.current = { id, resolve: end };
        signal.addEventListener("abort", () => end(null), { once: true });
        if (!send({ type: "editor.complete", id, path, prefix, suffix })) end(null);
      });
    },
    [send],
  );

  return {
    createEntry,
    deleteEntry,
    renameEntry,
    fullPath,
    createError,
    clearCreateError: () => setCreateError(null),
    complete,
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
    pinFile,
    moveFile,
    closeFile,
    save,
    resolveNotice,
    finishCompare,
    toggleDir,
    refreshTree,
    runSearch,
    gitStatus,
    found,
    collapseAll,
    showInTree,
    findFiles,
  };
}

export type EditorApi = ReturnType<typeof useEditor>;
