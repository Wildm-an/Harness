import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import {
  CircleAlert,
  File,
  FileCode,
  FilePlus,
  FileText,
  FoldVertical,
  Folder,
  FolderPlus,
  List,
  MoreHorizontal,
  Files,
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  Pin,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";
import { languageFor, monaco, monacoTheme } from "../lib/monaco";
import { codeFontFamily } from "../lib/theme";
import { useTabDrag } from "../lib/tabDrag";
import { AUTOCOMPLETE_DELAY, autocompleteOn, cursorContext, setAutocompleteOn, wantsCompletion } from "../lib/autocomplete";
import { FileTree } from "./FileTree";
import { isEditableFile, newEntryProblem, newEntryStart, selectionReference } from "./paths";
import { LanguageMenu, languageItems } from "./LanguageMenu";
import { SearchPanel, SearchResults } from "./SearchPanel";
import { PaneActions } from "../layout/Workspace";
import { isPreviewFile } from "../preview/document";
import { GIT_LABEL, GIT_LETTER, gitTone } from "./gitStatus";
import { FileSidebarResizer, saveFileSidebarWidth, savedFileSidebarWidth } from "./FileSidebarResizer";
import { modelUri, type EditorApi, type OpenFile, type TreeEntry } from "./useEditor";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { deleteText } from "./paths";

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontSize: 13,
  fontLigatures: false,
  lineHeight: 20,
  minimap: { enabled: false },
  // The thin scrollbar of the rest of the app (styles.css): a 12px track and a 6px thumb.
  scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, verticalSliderSize: 6, horizontalSliderSize: 6, useShadows: false },
  scrollBeyondLastLine: false,
  glyphMargin: true,
  renderWhitespace: "selection",
  bracketPairColorization: { enabled: true },
  matchBrackets: "always",
  inlineSuggest: { enabled: true }, // The autocomplete of the model (gray text, Tab accepts).
  tabSize: 4,
  detectIndentation: true,
};

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function NoticeBar({ file, api }: { file: OpenFile; api: EditorApi }) {
  const notice = file.notice;
  if (!notice) return null;
  const act = (a: "keep" | "load" | "compare" | "overwrite") => api.resolveNotice(file.path, a);
  if (notice.kind === "deleted") {
    return (
      <div className="notice-bar warn" role="alert">
        <TriangleAlert size={15} aria-hidden />
        <span>The file was deleted on disk.</span>
        <span className="spacer" />
        <button type="button" className="btn btn-small" onClick={() => act("keep")}>
          Keep my version
        </button>
        <button type="button" className="btn btn-small" onClick={() => api.closeFile(file.path)}>
          Close
        </button>
      </div>
    );
  }
  const conflict = notice.kind === "conflict";
  return (
    <div className="notice-bar warn" role="alert">
      <TriangleAlert size={15} aria-hidden />
      <span>
        {conflict
          ? "The file changed on disk after you opened it. The save stopped."
          : `${notice.by === "agent" ? "The agent" : "Another program"} changed this file on disk. You have unsaved changes.`}
      </span>
      <span className="spacer" />
      <button type="button" className="btn btn-small" onClick={() => act("compare")}>
        Compare
      </button>
      <button type="button" className="btn btn-small" onClick={() => act("load")}>
        Load the disk version
      </button>
      <button type="button" className="btn btn-small" onClick={() => act(conflict ? "overwrite" : "keep")}>
        {conflict ? "Overwrite the disk version" : "Keep my version"}
      </button>
    </div>
  );
}

export function EditorPane({
  api,
  sessionKey,
  agentLines,
  onReference,
  onInlineEdit,
  onOpenFolder,
  onPreview,
  openFolderBlocked,
  part = "all",
  emptyContent,
}: {
  // "files": only the file list and search, as the Files pane of the IDE view (VS Code's Explorer).
  // "editor": only the editor, when the Files pane shows the files. "all": both, in one pane: the
  // Files pane of the Code view, as in the Claude app. The editor is at the left, the tree at the
  // right with a filter, and the buttons are in the window header.
  part?: "all" | "files" | "editor";
  api: EditorApi;
  sessionKey: string;
  agentLines: Map<string, number[]>; // The lines that the agent changed in the current turn.
  onReference: (text: string) => void;
  onInlineEdit: (reference: string, instruction: string) => void; // Ctrl+K: the agent changes the selected code.
  onOpenFolder: () => void; // "Open folder…": select a folder in the file explorer. The session moves to it.
  onPreview?: (path: string) => void; // A PDF or Word file opens in the Preview pane.
  openFolderBlocked: string | null; // Why the folder cannot change now. null: it can change.
  emptyContent?: React.ReactNode; // Shows in place of the help text when no file is open.
}) {
  // The inline edit box (Ctrl+K), as in Cursor: it shows at the selection, and sends the instruction to the agent.
  const [inline, setInline] = useState<{ reference: string; top: number } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [sidebar, setSidebar] = useState<"files" | "search">("files");
  // The Files pane of the Code view: the tree can hide, and its filter finds files by name. A filter
  // that starts with "?" searches in the files (Enter).
  const code = part === "all";
  const [treeShown, setTreeShown] = useState(true);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const canCollapse = api.expanded.size > 0;
  const collapseTitle = canCollapse ? "Collapse all folders" : "There are no open folders to collapse.";
  // The width of the file sidebar: dragged by the user, or null for the automatic width (styles.css).
  const [sideWidth, setSideWidth] = useState<number | null>(savedFileSidebarWidth);
  const sideRef = useRef<HTMLElement>(null);
  // New file or New folder: the name field at the top of the file tree. It starts with the folder of the open file.
  const [creating, setCreating] = useState<{ kind: "file" | "dir"; name: string; problem: string | null } | null>(null);
  const startCreate = (kind: "file" | "dir") => {
    api.clearCreateError();
    setCreating({ kind, name: newEntryStart(api.active), problem: null });
  };

  // The actions of the Files sidebar head: buttons when they fit, else the items of the "⋯" menu.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [moreOpen]);
  const sideActions: { label: string; icon: typeof FilePlus; run: () => void; disabled?: boolean; title?: string }[] = [
    // The Code view has "Collapse all" in the window header.
    ...(code ? [] : [{ label: "Collapse all folders", icon: FoldVertical, run: api.collapseAll, disabled: !canCollapse, title: collapseTitle }]),
    { label: "New file…", icon: FilePlus, run: () => startCreate("file") },
    { label: "New folder…", icon: FolderPlus, run: () => startCreate("dir") },
    { label: "Open folder…", icon: FolderOpen, run: onOpenFolder, disabled: openFolderBlocked !== null, title: openFolderBlocked ?? undefined },
    { label: "Refresh", icon: RefreshCw, run: api.refreshTree },
  ];
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TreeEntry | null>(null); // Delete of the file tree asks first.
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const [autocomplete, setAutocomplete] = useState(autocompleteOn);
  // The language of each open file: the user's choice in the status bar, else the one of the model.
  const languages = useMemo(() => languageItems(monaco.languages.getLanguages()), []);
  const [languageChoice, setLanguageChoice] = useState<Record<string, string>>({});
  const languageOf = (path: string) =>
    languageChoice[path] ?? api.models.current.get(path)?.model.getLanguageId() ?? languageFor(path) ?? "plaintext";
  // Stable option objects: a new object at each render makes the editor apply its options again,
  // and that hides the gray autocomplete text. With autocomplete on, the word list opens only with
  // Ctrl+Space: it would hide the gray text and take Tab. A code font change reaches the open
  // editors through lib/monaco.ts.
  const editorOptions = useMemo(
    () => ({ ...EDITOR_OPTIONS, fontFamily: codeFontFamily(), quickSuggestions: !autocomplete }),
    [autocomplete],
  );
  const diffOptions = useMemo(
    () => ({ ...EDITOR_OPTIONS, fontFamily: codeFontFamily(), readOnly: true, renderSideBySide: true, originalEditable: false }),
    [],
  );

  // Autocomplete, as GitHub Copilot: when the user stops typing, the model of the session writes
  // the text at the cursor. Monaco shows it as gray text: Tab accepts it, Esc hides it.
  useEffect(() => {
    if (part === "files") return; // The Files pane has no editor: one provider is enough.
    const provider = monaco.languages.registerInlineCompletionsProvider("*", {
      provideInlineCompletions: async (model, position, _context, token) => {
        const none = { items: [] };
        const path = activeRef.current;
        if (!autocompleteOn() || !path || model.uri.toString() !== modelUri(sessionKeyRef.current, path).toString()) return none;
        const { prefix, suffix } = cursorContext(model.getValue(), model.getOffsetAt(position));
        if (!wantsCompletion(prefix, suffix)) return none;
        await new Promise((resolve) => setTimeout(resolve, AUTOCOMPLETE_DELAY));
        if (token.isCancellationRequested) return none;
        const abort = new AbortController();
        const stop = token.onCancellationRequested(() => abort.abort());
        const text = await apiRef.current.complete(path, prefix, suffix, abort.signal);
        stop.dispose();
        if (!text || token.isCancellationRequested) return none;
        const at = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        return { items: [{ insertText: text, range: at }] };
      },
      disposeInlineCompletions: () => {},
    });
    return () => provider.dispose();
  }, []);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = api.active;
  const [mounted, setMounted] = useState(0);

  const file = api.files.find((f) => f.path === api.active) ?? null;
  const ready = !!file && !file.loading && !file.error && api.models.current.has(file.path);

  const addSelection = () => {
    const editor = editorRef.current;
    const path = activeRef.current;
    const selection = editor?.getSelection();
    if (editor && path && selection) onReference(selectionReference(path, selection));
  };
  const addSelectionRef = useRef(addSelection);
  addSelectionRef.current = addSelection;

  /** Open the inline edit box above the selection (or the line of the cursor). */
  const openInline = () => {
    const editor = editorRef.current;
    const path = activeRef.current;
    const selection = editor?.getSelection();
    if (!editor || !path || !selection) return;
    const pos = editor.getScrolledVisiblePosition({ lineNumber: selection.startLineNumber, column: 1 });
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const lineTop = pos?.top ?? 0;
    // Above the selection when there is space, else under its first line.
    setInline({ reference: selectionReference(path, selection), top: lineTop >= 52 ? lineTop - 48 : lineTop + lineHeight + 4 });
    setInstruction("");
  };
  const openInlineRef = useRef(openInline);
  openInlineRef.current = openInline;

  const closeInline = () => {
    setInline(null);
    editorRef.current?.focus();
  };

  const sendInline = () => {
    if (!inline || !instruction.trim()) return;
    onInlineEdit(inline.reference, instruction);
    closeInline();
  };

  // A different file closes the inline edit box.
  useEffect(() => setInline(null), [api.active]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    decorations.current = editor.createDecorationsCollection();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeRef.current) api.save(activeRef.current);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => addSelectionRef.current());
    // Ctrl+K is the inline edit, as in Cursor. It replaces the Ctrl+K chords of Monaco.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => openInlineRef.current());
    setMounted((n) => n + 1);
  };

  // Mark the lines that the agent changed in this turn.
  useEffect(() => {
    const lines = (api.active && agentLines.get(api.active)) || [];
    decorations.current?.set(
      lines.map((line) => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: "agent-line",
          glyphMarginClassName: "agent-glyph",
          glyphMarginHoverMessage: { value: "The agent changed this line in the current turn." },
        },
      })),
    );
  }, [api.active, agentLines, mounted, ready]);

  // Go to a line: from the chat, or from a search result.
  useEffect(() => {
    const r = api.reveal;
    const editor = editorRef.current;
    if (!r || !editor || r.path !== api.active || !ready) return;
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(Math.max(r.line, 1), model.getLineCount());
    editor.revealLineInCenter(line);
    editor.setSelection(new monaco.Range(line, 1, line, model.getLineMaxColumn(line)));
    editor.focus();
  }, [api.reveal, api.active, ready, mounted]);

  // A drag of a tab changes the order of the tabs. The held tab gets the focus.
  const tabDrag = useTabDrag(api.moveFile, (index) => {
    const path = api.files[index]?.path;
    if (path) api.setActive(path);
  });

  const requestClose = (path: string) => {
    const f = api.files.find((x) => x.path === path);
    if (f?.dirty) setConfirmClose(path);
    else api.closeFile(path);
  };

  // The Files pane always shows its list. The editor-only part has no list.
  const showSide = part === "files" ? true : part === "editor" ? false : treeShown;

  // New file or New folder: the name field at the top of the tree.
  const newEntryForm = creating && (
    <form
      className="new-entry"
      onSubmit={(e) => {
        e.preventDefault();
        const problem = newEntryProblem(creating.name);
        if (problem) return setCreating({ ...creating, problem });
        if (api.createEntry(creating.name.trim().replace(/\\/g, "/"), creating.kind)) setCreating(null);
        else setCreating({ ...creating, problem: "The connection to the daemon is closed." });
      }}
    >
      {creating.kind === "file" ? <FilePlus size={13} aria-hidden /> : <FolderPlus size={13} aria-hidden />}
      <input
        autoFocus
        className="new-entry-input mono"
        value={creating.name}
        placeholder={creating.kind === "file" ? "src/app.py" : "src/utils"}
        aria-label={creating.kind === "file" ? "Name of the new file" : "Name of the new folder"}
        aria-invalid={creating.problem ? true : undefined}
        onChange={(e) => setCreating({ ...creating, name: e.target.value, problem: null })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setCreating(null);
          }
        }}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onBlur={() => !creating.name.trim() && setCreating(null)}
      />
    </form>
  );

  // The "⋯" menu: in the sidebar head (the IDE view), or in the window header (the Code view).
  const moreMenu = (
    <div className={`side-actions-more${code ? " code-more" : ""}`} ref={moreRef}>
      <button
        type="button"
        className={`icon-btn ghost${moreOpen ? " active" : ""}`}
        onClick={() => setMoreOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-label="More file actions"
        title="More"
      >
        <MoreHorizontal size={code ? 15 : 14} aria-hidden />
      </button>
      {moreOpen && (
        <div
          className="menu side-more-menu"
          role="menu"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setMoreOpen(false);
            }
          }}
        >
          {sideActions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              disabled={a.disabled}
              title={a.disabled ? a.title : undefined}
              onClick={() => {
                setMoreOpen(false);
                if (code && !treeShown) setTreeShown(true); // New file and New folder show in the tree.
                a.run();
              }}
            >
              <a.icon size={14} aria-hidden />
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // The search button: the filter gets "?" and the focus.
  const startSearch = () => {
    setTreeShown(true);
    setFilter((f) => (f.startsWith("?") ? f : `?${f}`));
    window.setTimeout(() => filterRef.current?.focus(), 0);
  };
  const query = filter.trim();
  const searching = query.startsWith("?");
  const searchText = query.slice(1).trim();

  /** A file or a folder of the filter list: a file opens, a folder shows in the tree. */
  const openFound = (item: string) => {
    if (item.endsWith("/")) {
      api.showInTree(item.slice(0, -1), true);
      setFilter("");
      api.findFiles("");
      return;
    }
    if (onPreview && isPreviewFile(item)) onPreview(item);
    else if (isEditableFile(item)) api.openFile(item);
  };

  const codeSide = code && (
    <>
      <div className="files-filter">
        <Search size={14} aria-hidden />
        <input
          ref={filterRef}
          value={filter}
          placeholder="Filter, or ? to search in files"
          aria-label="Filter the files. Start with ? to search in the files."
          spellCheck={false}
          onChange={(e) => {
            const value = e.target.value;
            setFilter(value);
            api.findFiles(value.trim().startsWith("?") ? "" : value.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter) {
              e.preventDefault();
              e.stopPropagation();
              setFilter("");
              api.findFiles("");
            } else if (e.key === "Enter" && searching && searchText) {
              e.preventDefault();
              api.runSearch(searchText, { regex: false, case: false, glob: "" });
            }
          }}
        />
      </div>
      {!query && creating && newEntryForm}
      {!query && (creating?.problem || api.createError) && (
        <p className="new-entry-error" role="alert">
          {creating?.problem ?? api.createError}
        </p>
      )}
      <div className="editor-side-body">
        {searching ? (
          searchText && api.search.query === searchText ? (
            <SearchResults search={api.search} onOpen={(p, line) => api.openFile(p, line)} />
          ) : (
            <p className="search-note">{searchText ? "Press Enter to search in the files." : "Type the text to search for, then press Enter."}</p>
          )
        ) : query ? (
          api.found?.query !== query ? (
            <p className="search-note">
              <LoaderCircle size={13} className="spin" aria-hidden /> Finding files
            </p>
          ) : api.found.items.length === 0 ? (
            <p className="search-note">No files match.</p>
          ) : (
            <ul className="file-tree files-found" aria-label="Matching files">
              {api.found.items.map((item) => {
                const dir = item.endsWith("/");
                const path = dir ? item.slice(0, -1) : item;
                const name = path.split("/").pop() ?? path;
                const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                const state = dir ? undefined : api.gitStatus[path];
                const blocked = !dir && !(onPreview && isPreviewFile(item)) && !isEditableFile(item);
                return (
                  <li key={item}>
                    <button
                      type="button"
                      className={`tree-item${blocked ? " blocked" : ""}${path === api.active ? " active" : ""}${state ? ` git-${gitTone(state)}` : ""}`}
                      style={{ paddingLeft: 8 }}
                      aria-disabled={blocked || undefined}
                      title={blocked ? "Binary file" : `${path}${state ? ` · ${GIT_LABEL[state]}` : ""}`}
                      onClick={() => !blocked && openFound(item)}
                      onDoubleClick={() => !dir && !blocked && isEditableFile(item) && api.pinFile(path)}
                    >
                      {dir ? <Folder size={14} aria-hidden /> : isPreviewFile(item) ? <FileText size={14} aria-hidden /> : <File size={14} aria-hidden />}
                      <span className="tree-name">{name}</span>
                      {parent && <span className="files-found-dir">{parent}</span>}
                      {state && (
                        <span className="tree-git" aria-label={GIT_LABEL[state]}>
                          {GIT_LETTER[state]}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <FileTree
            tree={api.tree}
            expanded={api.expanded}
            active={api.active}
            onToggle={api.toggleDir}
            onOpen={(p) => api.openFile(p)}
            onPin={api.pinFile}
            onPreview={onPreview}
            onDelete={setConfirmDelete}
            onRename={(entry, name) => api.renameEntry(entry.path, name)}
            onCopyPath={(entry) => void navigator.clipboard.writeText(api.fullPath(entry.path)).catch(() => {})}
            gitStatus={api.gitStatus}
          />
        )}
      </div>
    </>
  );

  return (
    <div
      className={`editor-pane${showSide ? "" : " no-sidebar"}${part === "files" ? " files-only" : ""}${code ? " code-files" : ""}`}
      style={showSide && code && sideWidth !== null ? { gridTemplateColumns: `minmax(0, 1fr) ${sideWidth}px` } : undefined}
    >
      {/* The Files pane of the Code view: its buttons are in the window header, as in the Claude app. */}
      {code && (
        <PaneActions>
          <button type="button" className="icon-btn ghost" onClick={startSearch} aria-label="Search in the files" title="Search in the files">
            <Search size={15} aria-hidden />
          </button>
          {/* aria-disabled, not disabled: a disabled button gets no hover, so it would show no tip. */}
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => canCollapse && api.collapseAll()}
            aria-disabled={!canCollapse || undefined}
            aria-label="Collapse all folders"
            title={collapseTitle}
          >
            <FoldVertical size={15} aria-hidden />
          </button>
          <button
            type="button"
            className={`icon-btn ghost${treeShown ? " active" : ""}`}
            onClick={() => setTreeShown((v) => !v)}
            aria-pressed={treeShown}
            aria-label="File tree"
            title={treeShown ? "Hide the file tree" : "Show the file tree"}
          >
            <List size={15} aria-hidden />
          </button>
          {moreMenu}
        </PaneActions>
      )}
      {showSide && code && (
        <aside className="editor-side code-side" aria-label="Files" ref={sideRef}>
          <FileSidebarResizer
            edge="left"
            side={sideRef}
            onChange={setSideWidth}
            onDone={(w) => {
              setSideWidth(w);
              saveFileSidebarWidth(w);
            }}
          />
          {codeSide}
        </aside>
      )}
      {showSide && !code && (
        <aside className="editor-side" aria-label="Files and search" ref={sideRef}>
          <div className="editor-side-head">
            <div className="segmented" role="group" aria-label="Sidebar">
              <button type="button" aria-pressed={sidebar === "files"} onClick={() => setSidebar("files")} title="Files" aria-label="Files">
                <Files size={14} aria-hidden />
              </button>
              <button type="button" aria-pressed={sidebar === "search"} onClick={() => setSidebar("search")} title="Search" aria-label="Search">
                <Search size={14} aria-hidden />
              </button>
            </div>
            <span className="spacer" />
            {sidebar === "files" ? (
              <>
                {/* All the buttons when they fit. A narrow sidebar shows "⋯" instead (styles.css). */}
                <div className="side-actions-full">
                  {sideActions.map((a) => (
                    // aria-disabled, not disabled: a disabled button gets no hover, so it would show no tip.
                    <button
                      key={a.label}
                      type="button"
                      className="icon-btn ghost"
                      onClick={() => !a.disabled && a.run()}
                      aria-disabled={a.disabled || undefined}
                      title={a.title ?? a.label}
                      aria-label={a.label}
                    >
                      <a.icon size={14} aria-hidden />
                    </button>
                  ))}
                </div>
                {moreMenu}
              </>
            ) : null}
          </div>
          {sidebar === "files" && creating && newEntryForm}
          {sidebar === "files" && (creating?.problem || api.createError) && (
            <p className="new-entry-error" role="alert">
              {creating?.problem ?? api.createError}
            </p>
          )}
          <div className="editor-side-body">
            {sidebar === "files" ? (
              <FileTree
                tree={api.tree}
                expanded={api.expanded}
                active={api.active}
                onToggle={api.toggleDir}
                onOpen={(p) => api.openFile(p)}
                onPin={api.pinFile}
                onPreview={onPreview}
                onDelete={setConfirmDelete}
                onRename={(entry, name) => api.renameEntry(entry.path, name)}
                onCopyPath={(entry) => void navigator.clipboard.writeText(api.fullPath(entry.path)).catch(() => {})}
                gitStatus={api.gitStatus}
              />
            ) : (
              <SearchPanel search={api.search} onSearch={api.runSearch} onOpen={(p, line) => api.openFile(p, line)} />
            )}
          </div>
        </aside>
      )}

      {part !== "files" && (
      <div className="editor-main">
        {/* The Code view shows no empty tab row: the editor shows "Open files appear here". */}
        {!(code && api.files.length === 0) && (
        <div className={`file-tabs${tabDrag.rowClass}`} role="tablist" aria-label="Open files">
          {api.files.map((f, index) => (
            // An unpinned tab has its name in italics: the next file that opens takes its place (V6k4).
            // A drag changes the order of the tabs (V6k5).
            <div
              key={f.path}
              className={`file-tab${f.path === api.active ? " active" : ""}${f.pinned ? "" : " unpinned"}`}
              role="presentation"
              {...tabDrag.tabProps(index)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={f.path === api.active}
                className="file-tab-name"
                onClick={() => api.setActive(f.path)}
                onDoubleClick={() => api.pinFile(f.path)}
                onAuxClick={(e) => e.button === 1 && requestClose(f.path)}
                title={f.path}
              >
                {/* As the tabs of the browser and of the Claude app: no file icon. */}
                {f.loading && <LoaderCircle size={13} className="spin" aria-hidden />}
                {baseName(f.path)}
                {f.dirty && <span className="dirty-dot" aria-label="Modified" title="Modified" />}
              </button>
              {!f.pinned && (
                <button
                  type="button"
                  className="file-tab-pin"
                  data-no-drag
                  onClick={() => api.pinFile(f.path)}
                  aria-label={`Keep ${f.path} open`}
                  title="Keep open"
                >
                  <Pin size={13} aria-hidden />
                </button>
              )}
              <button type="button" className="file-tab-close" data-no-drag onClick={() => requestClose(f.path)} aria-label={`Close ${f.path}`} title="Close">
                <X size={15} aria-hidden />
              </button>
            </div>
          ))}
        </div>
        )}

        {confirmClose && (
          <div className="notice-bar warn" role="alert">
            <TriangleAlert size={15} aria-hidden />
            <span>{baseName(confirmClose)} has unsaved changes.</span>
            <span className="spacer" />
            <button type="button" className="btn btn-small" onClick={() => { api.save(confirmClose); setConfirmClose(null); }}>
              Save
            </button>
            <button type="button" className="btn btn-small btn-danger" onClick={() => { api.closeFile(confirmClose); setConfirmClose(null); }}>
              Discard and close
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirmClose(null)}>
              Cancel
            </button>
          </div>
        )}
        {file && <NoticeBar file={file} api={api} />}
        {file?.error && (
          <div className="notice-bar bad" role="alert">
            <CircleAlert size={15} aria-hidden />
            <span>{file.error}</span>
          </div>
        )}

        <div className="editor-surface">
          {api.compare ? (
            <div className="compare-view">
              <div className="compare-head">
                <span>
                  Disk version <span className="mono">(left)</span> and your version <span className="mono">(right)</span> of{" "}
                  <span className="mono">{api.compare.path}</span>
                </span>
                <span className="spacer" />
                <button type="button" className="btn btn-small btn-primary" onClick={() => api.finishCompare("mine")}>
                  Keep my version
                </button>
                <button type="button" className="btn btn-small" onClick={() => api.finishCompare("disk")}>
                  Use the disk version
                </button>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => api.finishCompare("close")}>
                  Close
                </button>
              </div>
              <DiffEditor
                original={api.compare.disk}
                modified={api.models.current.get(api.compare.path)?.model.getValue() ?? ""}
                language={languageFor(api.compare.path)}
                theme={monacoTheme()}
                options={diffOptions}
              />
            </div>
          ) : ready && file ? (
            <Editor
              path={modelUri(sessionKey, file.path).toString()}
              keepCurrentModel
              theme={monacoTheme()}
              options={editorOptions}
              onMount={onMount}
              loading={<span className="pane-empty">Loading the editor.</span>}
            />
          ) : file?.loading ? (
            <p className="pane-empty">
              <LoaderCircle size={16} className="spin" aria-hidden /> Opening {file.path}
            </p>
          ) : !file && emptyContent ? (
            <div className="editor-empty editor-empty-custom">{emptyContent}</div>
          ) : !file && code ? (
            <div className="editor-empty">
              <Folder size={24} aria-hidden />
              <p className="editor-empty-title">Open files appear here</p>
              <p className="help">Pick a file in the tree, or click a file path in the conversation.</p>
            </div>
          ) : !file ? (
            <div className="editor-empty">
              <FileCode size={28} aria-hidden />
              <p>Open a file from the tree, or click a file path in the chat.</p>
              <p className="help">
                <kbd>Ctrl</kbd>+<kbd>S</kbd> saves. <kbd>Ctrl</kbd>+<kbd>L</kbd> adds the selected lines to the chat. <kbd>Ctrl</kbd>+<kbd>K</kbd> asks the
                agent to edit them.
              </p>
            </div>
          ) : null}
          {inline && ready && !api.compare && (
            <form
              className="inline-edit"
              style={{ top: inline.top }}
              onSubmit={(e) => {
                e.preventDefault();
                sendInline();
              }}
            >
              <Sparkles size={14} aria-hidden className="inline-edit-icon" />
              <input
                autoFocus
                className="inline-edit-input"
                value={instruction}
                placeholder="Tell the agent how to change this code"
                aria-label={`Edit ${inline.reference}`}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeInline();
                  }
                }}
              />
              <span className="inline-edit-ref mono" title={inline.reference}>
                {inline.reference.split("/").pop()}
              </span>
              <button type="submit" className="btn btn-primary btn-small" disabled={!instruction.trim()} title="Send (Enter)">
                Send
              </button>
              <button type="button" className="icon-btn ghost" onClick={closeInline} aria-label="Close the inline edit" title="Close (Esc)">
                <X size={14} aria-hidden />
              </button>
            </form>
          )}
        </div>

        {file && (
          <div className="editor-status">
            <span className="mono" title={file.path}>
              {file.path}
            </span>
            <LanguageMenu
              value={languageOf(file.path)}
              languages={languages}
              disabled={!ready}
              onChoose={(id) => {
                const model = api.models.current.get(file.path)?.model;
                if (!model) return;
                monaco.editor.setModelLanguage(model, id);
                setLanguageChoice((m) => ({ ...m, [file.path]: id }));
              }}
            />
            <span aria-live="polite">{file.saving ? "Saving" : file.dirty ? "Modified" : "Saved"}</span>
            <span className="spacer" />
            <button
              type="button"
              className={`btn btn-ghost btn-small autocomplete-toggle${autocomplete ? " on" : ""}`}
              role="switch"
              aria-checked={autocomplete}
              onClick={() => {
                setAutocompleteOn(!autocomplete);
                setAutocomplete(!autocomplete);
                if (autocomplete) editorRef.current?.trigger("autocomplete", "editor.action.inlineSuggest.hide", null);
              }}
              title={autocomplete ? "Autocomplete is on: the model suggests code as you type. Tab accepts." : "Autocomplete is off"}
            >
              <Wand2 size={13} aria-hidden />
              Autocomplete
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={openInline} disabled={!ready} title="Ctrl+K">
              <Sparkles size={13} aria-hidden />
              Edit with agent
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={addSelection} disabled={!ready} title="Ctrl+L">
              <MessageSquarePlus size={13} aria-hidden />
              Add selection to chat
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => api.save(file.path)}
              disabled={!ready || file.saving || !file.dirty}
              title="Ctrl+S"
            >
              <Save size={13} aria-hidden />
              Save
            </button>
          </div>
        )}
      </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${confirmDelete.name}?`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            api.deleteEntry(confirmDelete.path);
            setConfirmDelete(null);
          }}
        >
          {deleteText(confirmDelete, api.files)}
        </ConfirmDialog>
      )}
    </div>
  );
}
