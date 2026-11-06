// The Changes pane when no single change is in review, as in the Claude app: all the changes of the
// branch (or only the uncommitted changes), one section for each file with its lines, and a list of the
// files at the right. The header has "{base} → {branch}" with a menu, search, the file list switch, and ⋯.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleCheck, Copy, Ellipsis, FileCode, ListTree, RotateCw, Search, X } from "lucide-react";
import type { GitDiff, GitDiffFile, GitDiffScope } from "../daemon/protocol";
import { fileRows, htmlRuns, mergeRuns, splitPath, type ChangeRow, type Run } from "../lib/changesView";
import { loadPref, savePref } from "../lib/prefs";
import { codeTheme, onThemeChange } from "../lib/theme";
import { PaneActions, PaneHeader } from "../layout/Workspace";

const COLORIZE_LIMIT = 40_000; // Characters of a file. A longer file shows with no syntax colors.
const LIST_PREF = "changes.fileList";

const STATUS_TEXT: Record<GitDiffFile["status"], string> = { A: "Added", D: "Deleted", R: "Renamed", M: "Modified" };

/** The syntax runs of the lines of a file (Monaco colorize), or null until Monaco is ready. */
function useSyntaxRuns(texts: string[], path: string): Run[][] | null {
  const [runs, setRuns] = useState<Run[][] | null>(null);
  const [theme, setTheme] = useState(codeTheme);
  useEffect(() => onThemeChange(() => setTheme(codeTheme())), []);
  const text = texts.join("\n");
  useEffect(() => {
    setRuns(null);
    if (!text || text.length > COLORIZE_LIMIT) return;
    let live = true;
    void import("../lib/monaco")
      .then(async ({ monaco, languageFor }) => {
        const lang = languageFor(path);
        if (!lang || !live) return;
        monaco.editor.setTheme(theme); // The .mtk classes get the colors of this theme.
        const html = await monaco.editor.colorize(text, lang, { tabSize: 4 });
        if (live) setRuns(htmlRuns(html));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [text, path, theme]);
  return runs;
}

function LineText({ row, runs }: { row: Extract<ChangeRow, { text: string }>; runs: Run[] | undefined }) {
  const merged = runs ? mergeRuns(runs, row.words) : null;
  const mark = row.kind === "add" ? "word-add" : "word-del";
  if (merged) {
    return (
      <>
        {merged.map((r, i) =>
          r.changed ? (
            <mark key={i} className={mark}>
              <span className={r.cls || undefined}>{r.text}</span>
            </mark>
          ) : (
            <span key={i} className={r.cls || undefined}>
              {r.text}
            </span>
          ),
        )}
      </>
    );
  }
  if (row.words) {
    return (
      <>
        {row.words.map((w, i) =>
          w.changed ? (
            <mark key={i} className={mark}>
              {w.text}
            </mark>
          ) : (
            <span key={i}>{w.text}</span>
          ),
        )}
      </>
    );
  }
  return <>{row.text}</>;
}

const FileBody = memo(function FileBody({ file }: { file: GitDiffFile }) {
  const { rows } = useMemo(() => fileRows(file.patch), [file.patch]);
  const lines = useMemo(() => rows.filter((r): r is Extract<ChangeRow, { text: string }> => r.kind !== "gap"), [rows]);
  const runs = useSyntaxRuns(useMemo(() => lines.map((l) => l.text), [lines]), file.path);
  const usable = runs && runs.length >= lines.length ? runs : null;
  if (file.binary) return <p className="cv-note">Binary file. There are no lines to show.</p>;
  if (file.too_large) return <p className="cv-note">The change of this file is too large to show here. Open the file to see it.</p>;
  if (rows.length === 0) return <p className="cv-note">{file.status === "R" ? `Renamed from ${file.old_path}. The lines did not change.` : "No lines changed."}</p>;
  let at = -1;
  return (
    <div className="cv-lines" role="table" aria-label={`The changes of ${file.path}`}>
      {rows.map((row, i) => {
        if (row.kind === "gap") {
          return (
            <div key={i} className="cv-gap" role="row">
              {row.count} unmodified {row.count === 1 ? "line" : "lines"}
            </div>
          );
        }
        at++;
        return (
          <div key={i} className={`cv-row cv-${row.kind}`} role="row">
            <span className="cv-num" role="cell">{row.oldNo ?? ""}</span>
            <span className="cv-num" role="cell">{row.newNo ?? ""}</span>
            <span className="cv-code" role="cell">
              <span className="sr-only">{row.kind === "add" ? "Added: " : row.kind === "del" ? "Removed: " : ""}</span>
              <LineText row={row} runs={usable?.[at]} />
            </span>
          </div>
        );
      })}
    </div>
  );
});

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="cv-counts" aria-label={`${added} lines added, ${removed} lines removed`}>
      {added > 0 && <span className="stat-add">+{added}</span>}
      {removed > 0 && <span className="stat-del">−{removed}</span>}
    </span>
  );
}

/** The first changed line of a file, for "Open file". */
function firstLine(patch: string): number | undefined {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(patch);
  return m ? Math.max(1, Number(m[1])) : undefined;
}

function FileSection({ file, open, viewed, onToggle, onViewed, onOpenFile, sectionRef }: {
  file: GitDiffFile;
  open: boolean;
  viewed: boolean;
  onToggle: () => void;
  onViewed: () => void;
  onOpenFile: (path: string, line?: number) => void;
  sectionRef: (el: HTMLElement | null) => void;
}) {
  const { added, removed } = useMemo(() => fileRows(file.patch), [file.patch]);
  const { name, dir } = splitPath(file.path);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu]);
  const canOpen = file.status !== "D";
  return (
    <section className={`cv-file${viewed ? " viewed" : ""}`} ref={sectionRef} aria-label={file.path}>
      <header className="cv-file-head">
        <button type="button" className="cv-file-toggle" aria-expanded={open} onClick={onToggle} title={`${STATUS_TEXT[file.status]}${file.untracked ? " (new file)" : ""}: ${file.path}`}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          <FileCode size={14} aria-hidden className="cv-file-icon" />
          <span className="cv-file-name">{name}</span>
          {dir && <span className="cv-file-dir">{dir}</span>}
        </button>
        <Counts added={added} removed={removed} />
        <button type="button" className={`icon-btn ghost cv-viewed${viewed ? " on" : ""}`} aria-pressed={viewed} aria-label="Viewed" title={viewed ? "Mark as not viewed" : "Mark as viewed"} onClick={onViewed}>
          <CircleCheck size={15} aria-hidden />
        </button>
        <button type="button" className="icon-btn ghost" aria-label="Open file" title="Open file" disabled={!canOpen} onClick={() => onOpenFile(file.path, firstLine(file.patch))}>
          <ArrowUpRight size={15} aria-hidden />
        </button>
        <div className="cv-menu-wrap" ref={menuRef} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setMenu(false))}>
          <button type="button" className="icon-btn ghost" aria-haspopup="menu" aria-expanded={menu} aria-label="More actions" title="More actions" onClick={() => setMenu((v) => !v)}>
            <Ellipsis size={15} aria-hidden />
          </button>
          {menu && (
            <div className="menu" role="menu">
              <button type="button" role="menuitem" onClick={() => (setMenu(false), void navigator.clipboard.writeText(file.path).catch(() => undefined))}>
                <Copy size={14} aria-hidden /> Copy path
              </button>
              <button type="button" role="menuitem" disabled={!canOpen} onClick={() => (setMenu(false), onOpenFile(file.path, firstLine(file.patch)))}>
                <ArrowUpRight size={14} aria-hidden /> Open file
              </button>
            </div>
          )}
        </div>
      </header>
      {open && <FileBody file={file} />}
    </section>
  );
}

/** "master": a base ref with no "origin/". */
const shortRef = (ref: string | null) => (ref ? ref.replace(/^origin\//, "") : null);

export function ChangesView({ diff, scope, onScope, onRefresh, onOpenFile, connected }: {
  diff: GitDiff | null; // null: no reply yet.
  scope: GitDiffScope;
  onScope: (scope: GitDiffScope) => void;
  onRefresh: () => void;
  onOpenFile: (path: string, line?: number) => void;
  connected: boolean;
}) {
  const [list, setList] = useState(() => loadPref(LIST_PREF, "on") !== "off");
  const [search, setSearch] = useState<string | null>(null); // null: the search field is closed.
  const [closed, setClosed] = useState<Set<string>>(new Set()); // Folded files.
  const [viewed, setViewed] = useState<Set<string>>(new Set()); // "Viewed" files: they fold.
  const [scopeMenu, setScopeMenu] = useState(false);
  const [more, setMore] = useState(false);
  const scopeRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!scopeMenu && !more) return;
    const onDown = (e: MouseEvent) => {
      if (!scopeRef.current?.contains(e.target as Node)) setScopeMenu(false);
      if (!moreRef.current?.contains(e.target as Node)) setMore(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [scopeMenu, more]);
  useEffect(() => {
    if (search !== null) searchRef.current?.focus();
  }, [search !== null]);

  const files = diff?.files ?? [];
  const query = (search ?? "").trim().toLowerCase();
  const shown = query ? files.filter((f) => f.path.toLowerCase().includes(query) || f.patch.toLowerCase().includes(query)) : files;
  const base = shortRef(diff?.base ?? null);
  const branch = diff?.branch ?? "HEAD";
  const title = scope === "uncommitted" ? "Uncommitted changes" : null;

  const toggle = (path: string) =>
    setClosed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleViewed = (path: string) => {
    const was = viewed.has(path);
    setViewed((s) => {
      const next = new Set(s);
      if (was) next.delete(path);
      else next.add(path);
      return next;
    });
    // A viewed file folds, as on GitHub. "Not viewed" opens it again.
    setClosed((s) => {
      const next = new Set(s);
      if (was) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const jump = (path: string) => {
    setClosed((s) => {
      const next = new Set(s);
      next.delete(path);
      return next;
    });
    requestAnimationFrame(() => sections.current.get(path)?.scrollIntoView({ block: "start" }));
  };

  return (
    <section className="changes-view" aria-label="Changes">
      <PaneHeader>
        <div className="cv-scope" ref={scopeRef} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setScopeMenu(false))}>
          <button type="button" className="cv-scope-btn" aria-haspopup="menu" aria-expanded={scopeMenu} onClick={() => setScopeMenu((v) => !v)} title="Choose the changes to show">
            {title ?? (
              <>
                <span className="mono">{base ?? "HEAD"}</span>
                <ArrowRight size={13} aria-hidden className="cv-scope-arrow" />
                <span className="mono cv-scope-branch">{branch}</span>
              </>
            )}
            <ChevronDown size={13} aria-hidden />
          </button>
          {scopeMenu && (
            <div className="menu cv-scope-menu" role="menu" aria-label="Changes to show">
              <button type="button" role="menuitemradio" aria-checked={scope === "branch"} onClick={() => (setScopeMenu(false), onScope("branch"))}>
                <span className="side-filter-label">All changes of the branch</span>
                {scope === "branch" && <Check size={14} aria-hidden />}
              </button>
              <button type="button" role="menuitemradio" aria-checked={scope === "uncommitted"} onClick={() => (setScopeMenu(false), onScope("uncommitted"))}>
                <span className="side-filter-label">Uncommitted changes</span>
                {scope === "uncommitted" && <Check size={14} aria-hidden />}
              </button>
            </div>
          )}
        </div>
      </PaneHeader>
      <PaneActions>
        <button type="button" className={`icon-btn ghost${search !== null ? " active" : ""}`} aria-pressed={search !== null} aria-label="Search" title="Search the changes" onClick={() => setSearch((s) => (s === null ? "" : null))}>
          <Search size={15} aria-hidden />
        </button>
        <button
          type="button"
          className={`icon-btn ghost${list ? " active" : ""}`}
          aria-pressed={list}
          aria-label="File list"
          title={list ? "Hide the file list" : "Show the file list"}
          onClick={() => {
            setList(!list);
            savePref(LIST_PREF, list ? "off" : "on");
          }}
        >
          <ListTree size={15} aria-hidden />
        </button>
        <div className="cv-menu-wrap" ref={moreRef} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setMore(false))}>
          <button type="button" className="icon-btn ghost" aria-haspopup="menu" aria-expanded={more} aria-label="More" title="More" onClick={() => setMore((v) => !v)}>
            <Ellipsis size={15} aria-hidden />
          </button>
          {more && (
            <div className="menu" role="menu">
              <button type="button" role="menuitem" onClick={() => (setMore(false), setClosed(new Set()))}>
                Expand all files
              </button>
              <button type="button" role="menuitem" onClick={() => (setMore(false), setClosed(new Set(files.map((f) => f.path))))}>
                Collapse all files
              </button>
              <div className="menu-sep" role="separator" />
              <button type="button" role="menuitem" disabled={!connected} onClick={() => (setMore(false), onRefresh())}>
                <RotateCw size={14} aria-hidden /> Refresh
              </button>
            </div>
          )}
        </div>
      </PaneActions>
      {search !== null && (
        <div className="cv-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setSearch(null))}
            placeholder="Find files and changed lines"
            aria-label="Find files and changed lines"
            spellCheck={false}
          />
          {query && <span className="cv-search-count">{shown.length} of {files.length}</span>}
          <button type="button" className="icon-btn ghost" aria-label="Close search" title="Close (Esc)" onClick={() => setSearch(null)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
      {!diff ? (
        <p className="pane-empty">{connected ? "Loading the changes…" : "Connect to a computer to see the changes."}</p>
      ) : !diff.repo ? (
        <p className="pane-empty">This folder is not a git repository. The Changes pane shows each change that the agent asks to make.</p>
      ) : files.length === 0 ? (
        <p className="pane-empty">{scope === "uncommitted" ? "No uncommitted changes." : `No changes${base ? ` since ${base}` : ""}.`}</p>
      ) : (
        <div className={`cv-body${list ? " with-list" : ""}`}>
          <div className="cv-files">
            {shown.length === 0 && <p className="pane-empty">No file matches the search.</p>}
            {shown.map((f) => (
              <FileSection
                key={f.path}
                file={f}
                open={!closed.has(f.path)}
                viewed={viewed.has(f.path)}
                onToggle={() => toggle(f.path)}
                onViewed={() => toggleViewed(f.path)}
                onOpenFile={onOpenFile}
                sectionRef={(el) => (el ? sections.current.set(f.path, el) : sections.current.delete(f.path))}
              />
            ))}
            {diff.truncated && <p className="cv-note">Some files are not shown: the change is too large.</p>}
          </div>
          {list && (
            <nav className="cv-list" aria-label="Changed files">
              {shown.map((f) => {
                const { name, dir } = splitPath(f.path);
                return <FileListItem key={f.path} file={f} name={name} dir={dir} viewed={viewed.has(f.path)} onClick={() => jump(f.path)} />;
              })}
            </nav>
          )}
        </div>
      )}
    </section>
  );
}

function FileListItem({ file, name, dir, viewed, onClick }: { file: GitDiffFile; name: string; dir: string; viewed: boolean; onClick: () => void }) {
  const { added, removed } = useMemo(() => fileRows(file.patch), [file.patch]);
  return (
    <button type="button" className={`cv-list-item${viewed ? " viewed" : ""}`} onClick={onClick} title={file.path}>
      <FileCode size={14} aria-hidden className="cv-file-icon" />
      <span className="cv-list-name">
        {name}
        {dir && <span className="cv-file-dir">{dir}</span>}
      </span>
      <Counts added={added} removed={removed} />
    </button>
  );
}
