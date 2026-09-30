import { useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import {
  CircleAlert,
  FileCode,
  Files,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Save,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { languageFor, monaco, monacoTheme } from "../lib/monaco";
import { FileTree } from "./FileTree";
import { selectionReference } from "./paths";
import { SearchPanel } from "./SearchPanel";
import { modelUri, type EditorApi, type OpenFile } from "./useEditor";

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily: "'JetBrains Mono', ui-monospace, Consolas, monospace",
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
}: {
  api: EditorApi;
  sessionKey: string;
  agentLines: Map<string, number[]>; // The lines that the agent changed in the current turn.
  onReference: (text: string) => void;
}) {
  const [sidebar, setSidebar] = useState<"files" | "search" | null>("files");
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
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

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    decorations.current = editor.createDecorationsCollection();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeRef.current) api.save(activeRef.current);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => addSelectionRef.current());
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
    <div className={`editor-pane${sidebar ? "" : " no-sidebar"}`}>
      {sidebar && (
        <aside className="editor-side" aria-label="Files and search">
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
            {sidebar === "files" && (
              <button type="button" className="icon-btn ghost" onClick={api.refreshTree} title="Refresh" aria-label="Refresh the files">
                <RefreshCw size={14} aria-hidden />
              </button>
            )}
            <button type="button" className="icon-btn ghost" onClick={() => setSidebar(null)} title="Hide the sidebar" aria-label="Hide the sidebar">
              <PanelLeftClose size={14} aria-hidden />
            </button>
          </div>
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
                options={{ ...EDITOR_OPTIONS, readOnly: true, renderSideBySide: true, originalEditable: false }}
              />
            </div>
          ) : ready && file ? (
            <Editor
              path={modelUri(sessionKey, file.path).toString()}
              keepCurrentModel
              theme={monacoTheme()}
              options={EDITOR_OPTIONS}
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
                <kbd>Ctrl</kbd>+<kbd>S</kbd> saves. <kbd>Ctrl</kbd>+<kbd>L</kbd> adds the selected lines to the chat.
              </p>
            </div>
          ) : null}
        </div>

        {file && (
          <div className="editor-status">
            <span className="mono" title={file.path}>
              {file.path}
            </span>
            <span>{languageFor(file.path) ?? "plain text"}</span>
            <span aria-live="polite">{file.saving ? "Saving" : file.dirty ? "Modified" : "Saved"}</span>
            <span className="spacer" />
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
