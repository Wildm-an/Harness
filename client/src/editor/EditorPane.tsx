import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import {
  CircleAlert,
  FileCode,
  FilePlus,
  FolderPlus,
  MoreHorizontal,
  Files,
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
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
import { AUTOCOMPLETE_DELAY, autocompleteOn, cursorContext, setAutocompleteOn, wantsCompletion } from "../lib/autocomplete";
import { FileTree } from "./FileTree";
import { newEntryProblem, newEntryStart, selectionReference } from "./paths";
import { LanguageMenu, languageItems } from "./LanguageMenu";
import { SearchPanel } from "./SearchPanel";
import { FileSidebarResizer, saveFileSidebarWidth, savedFileSidebarWidth } from "./FileSidebarResizer";
import { modelUri, type EditorApi, type OpenFile } from "./useEditor";

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
  openFolderBlocked,
}: {
  api: EditorApi;
  sessionKey: string;
  agentLines: Map<string, number[]>; // The lines that the agent changed in the current turn.
  onReference: (text: string) => void;
  onInlineEdit: (reference: string, instruction: string) => void; // Ctrl+K: the agent changes the selected code.
  onOpenFolder: () => void; // "Open folder…": select a folder in the file explorer. The session moves to it.
  openFolderBlocked: string | null; // Why the folder cannot change now. null: it can change.
}) {
  // The inline edit box (Ctrl+K), as in Cursor: it shows at the selection, and sends the instruction to the agent.
  const [inline, setInline] = useState<{ reference: string; top: number } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [sidebar, setSidebar] = useState<"files" | "search" | null>("files");
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
    { label: "New file…", icon: FilePlus, run: () => startCreate("file") },
    { label: "New folder…", icon: FolderPlus, run: () => startCreate("dir") },
    { label: "Open folder…", icon: FolderOpen, run: onOpenFolder, disabled: openFolderBlocked !== null, title: openFolderBlocked ?? undefined },
    { label: "Refresh", icon: RefreshCw, run: api.refreshTree },
    { label: "Hide the sidebar", icon: PanelLeftClose, run: () => setSidebar(null) },
  ];
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
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

  const requestClose = (path: string) => {
    const f = api.files.find((x) => x.path === path);
    if (f?.dirty) setConfirmClose(path);
    else api.closeFile(path);
  };

  return (
    <div
      className={`editor-pane${sidebar ? "" : " no-sidebar"}`}
      style={sidebar && sideWidth !== null ? { gridTemplateColumns: `${sideWidth}px minmax(0, 1fr)` } : undefined}
    >
      {sidebar && (
        <aside className="editor-side" aria-label="Files and search" ref={sideRef}>
          <FileSidebarResizer
            side={sideRef}
            onChange={setSideWidth}
            onDone={(w) => {
              setSideWidth(w);
              saveFileSidebarWidth(w);
            }}
          />
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
                    <button
                      key={a.label}
                      type="button"
                      className="icon-btn ghost"
                      onClick={a.run}
                      disabled={a.disabled}
                      title={a.title ?? a.label}
                      aria-label={a.label}
                    >
                      <a.icon size={14} aria-hidden />
                    </button>
                  ))}
                </div>
                <div className="side-actions-more" ref={moreRef}>
                  <button
                    type="button"
                    className={`icon-btn ghost${moreOpen ? " active" : ""}`}
                    onClick={() => setMoreOpen((o) => !o)}
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    aria-label="More file actions"
                    title="More"
                  >
                    <MoreHorizontal size={14} aria-hidden />
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
              </>
            ) : (
              <button type="button" className="icon-btn ghost" onClick={() => setSidebar(null)} title="Hide the sidebar" aria-label="Hide the sidebar">
                <PanelLeftClose size={14} aria-hidden />
              </button>
            )}
          </div>
          {sidebar === "files" && creating && (
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
          )}
          {sidebar === "files" && (creating?.problem || api.createError) && (
            <p className="new-entry-error" role="alert">
              {creating?.problem ?? api.createError}
            </p>
          )}
          <div className="editor-side-body">
            {sidebar === "files" ? (
              <FileTree tree={api.tree} expanded={api.expanded} active={api.active} onToggle={api.toggleDir} onOpen={(p) => api.openFile(p)} />
            ) : (
              <SearchPanel search={api.search} onSearch={api.runSearch} onOpen={(p, line) => api.openFile(p, line)} />
            )}
          </div>
        </aside>
      )}

      <div className="editor-main">
        <div className="file-tabs" role="tablist" aria-label="Open files">
          {!sidebar && (
            <button type="button" className="icon-btn ghost" onClick={() => setSidebar("files")} title="Show the sidebar" aria-label="Show the sidebar">
              <PanelLeftOpen size={14} aria-hidden />
            </button>
          )}
          {api.files.map((f) => (
            <div key={f.path} className={`file-tab${f.path === api.active ? " active" : ""}`} role="presentation">
              <button
                type="button"
                role="tab"
                aria-selected={f.path === api.active}
                className="file-tab-name"
                onClick={() => api.setActive(f.path)}
                onAuxClick={(e) => e.button === 1 && requestClose(f.path)}
                title={f.path}
              >
                {f.loading ? <LoaderCircle size={12} className="spin" aria-hidden /> : <FileCode size={12} aria-hidden />}
                {baseName(f.path)}
                {f.dirty && <span className="dirty-dot" aria-label="Modified" title="Modified" />}
              </button>
              <button type="button" className="file-tab-close" onClick={() => requestClose(f.path)} aria-label={`Close ${f.path}`} title="Close">
                <X size={12} aria-hidden />
              </button>
            </div>
          ))}
        </div>

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
    </div>
  );
}
