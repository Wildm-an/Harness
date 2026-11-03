import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, Copy, File, FileText, Folder, FolderOpen, LoaderCircle, Pencil, Trash2, type LucideIcon } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { isEditableFile, renameProblem } from "./paths";
import { isPreviewFile } from "../preview/document";
import type { TreeEntry } from "./useEditor";

const MENU_WIDTH = 230;

type TreeAction = "copyPath" | "rename" | "delete";

/** The menu of a tree item: right click, or Shift+F10 / the context menu key. The keys are those of VS Code. */
function TreeMenu({ entry, x, y, onAction, onClose }: {
  entry: TreeEntry;
  x: number;
  y: number;
  onAction: (action: TreeAction, entry: TreeEntry) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useOverlay(true);

  // Keep the menu in the window.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setPos({
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
      left: Math.max(4, Math.min(x, window.innerWidth - MENU_WIDTH - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  const item = (action: TreeAction, label: string, key: string, Icon: LucideIcon, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={danger ? "danger" : undefined}
      onClick={() => {
        onClose();
        onAction(action, entry);
      }}
    >
      <Icon size={14} aria-hidden />
      <span className="session-menu-label">{label}</span>
      <kbd className="session-menu-key">{key}</kbd>
    </button>
  );

  return (
    <div
      ref={ref}
      className="menu tree-menu"
      role="menu"
      aria-label={`Actions for ${entry.name}`}
      style={pos ? { top: pos.top, left: pos.left, width: MENU_WIDTH } : { visibility: "hidden", width: MENU_WIDTH }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}
    >
      {item("copyPath", "Copy path", "Shift+Alt+C", Copy)}
      <div className="menu-sep" role="separator" />
      {item("rename", "Rename…", "F2", Pencil)}
      {item("delete", "Delete…", "Del", Trash2, true)}
    </div>
  );
}

/** The name field of Rename, in the place of the name. Enter or a click outside saves. Esc cancels. */
function RenameField({ entry, onDone }: { entry: TreeEntry; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(entry.name);
  const problem = name.trim() === entry.name ? null : renameProblem(name);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <span className="tree-rename">
      <input
        className="tree-rename-input"
        aria-label={`New name for ${entry.name}`}
        aria-invalid={problem ? true : undefined}
        value={name}
        autoFocus
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        // Select the name without the file type, as VS Code does.
        onFocus={(e) => {
          const dot = entry.type === "file" ? entry.name.lastIndexOf(".") : -1;
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !problem) finish(name.trim());
          else if (e.key === "Escape") finish(null);
        }}
        onBlur={() => finish(problem ? null : name.trim())}
      />
      {problem && (
        <span className="tree-rename-problem" role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}

/** The files of the session folder. The daemon applies the .gitignore files. */
export const FileTree = memo(function FileTree({
  tree,
  expanded,
  active,
  onToggle,
  onOpen,
  onPreview,
  onDelete,
  onRename,
  onCopyPath,
}: {
  tree: Record<string, TreeEntry[] | "loading">;
  expanded: Set<string>;
  active: string | null;
  onToggle: (dir: string) => void;
  onOpen: (path: string) => void;
  onPreview?: (path: string) => void; // A PDF or Word file: the Preview pane.
  onDelete: (entry: TreeEntry) => void; // Ask, then delete the file or the folder.
  onRename: (entry: TreeEntry, name: string) => void; // A new name in the same folder.
  onCopyPath: (entry: TreeEntry) => void; // Copy the full path.
}) {
  const [menu, setMenu] = useState<{ entry: TreeEntry; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null); // The path of the item with the name field.
  const closeMenu = useCallback(() => setMenu(null), []);
  const act = useCallback(
    (action: TreeAction, entry: TreeEntry) => {
      if (action === "delete") onDelete(entry);
      else if (action === "rename") setRenaming(entry.path);
      else onCopyPath(entry);
    },
    [onDelete, onCopyPath],
  );

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const entries = tree[dir];
    if (entries === undefined) return null;
    if (entries === "loading") {
      return (
        <li className="tree-loading" style={{ paddingLeft: 8 + depth * 14 }}>
          <LoaderCircle size={13} className="spin" aria-hidden /> Loading
        </li>
      );
    }
    if (entries.length === 0 && depth > 0) {
      return (
        <li className="tree-empty" style={{ paddingLeft: 8 + depth * 14 }}>
          Empty
        </li>
      );
    }
    return entries.map((entry) => {
      const open = expanded.has(entry.path);
      // A PDF or Word file opens in the Preview pane. Another binary file cannot open in the editor:
      // it shows grayed out, and a click does nothing.
      // aria-disabled, not disabled: a disabled button gets no hover, so it would show no hint.
      const preview = entry.type === "file" && !!onPreview && isPreviewFile(entry.path);
      const blocked = entry.type === "file" && !preview && !isEditableFile(entry.path);
      const icon =
        entry.type === "dir" ? (
          <>
            <ChevronRight size={13} aria-hidden className={`tree-chevron${open ? " open" : ""}`} />
            {open ? <FolderOpen size={14} aria-hidden /> : <Folder size={14} aria-hidden />}
          </>
        ) : (
          <>
            <span className="tree-chevron-space" />
            {preview ? <FileText size={14} aria-hidden /> : <File size={14} aria-hidden />}
          </>
        );
      return (
        <li key={entry.path}>
          {renaming === entry.path ? (
            <div className="tree-item renaming" style={{ paddingLeft: 8 + depth * 14 }}>
              {icon}
              <RenameField
                entry={entry}
                onDone={(name) => {
                  setRenaming(null);
                  if (name && name !== entry.name) onRename(entry, name);
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              className={`tree-item${entry.path === active ? " active" : ""}${blocked ? " blocked" : ""}${menu?.entry.path === entry.path ? " menu-open" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => {
                if (entry.type === "dir") onToggle(entry.path);
                else if (preview) onPreview?.(entry.path);
                else if (!blocked) onOpen(entry.path);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ entry, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
                if (e.key === "Delete" && plain) {
                  e.preventDefault();
                  act("delete", entry);
                } else if (e.key === "F2" && plain && !e.shiftKey) {
                  e.preventDefault();
                  act("rename", entry);
                } else if (e.code === "KeyC" && e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey) {
                  e.preventDefault();
                  act("copyPath", entry);
                } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  setMenu({ entry, x: box.left + 24, y: box.bottom });
                }
              }}
              aria-expanded={entry.type === "dir" ? open : undefined}
              aria-disabled={blocked || undefined}
              title={blocked ? "Binary file" : preview ? `Preview ${entry.path}` : entry.path}
            >
              {icon}
              <span className="tree-name">{entry.name}</span>
            </button>
          )}
          {entry.type === "dir" && open && <ul role="group">{renderDir(entry.path, depth + 1)}</ul>}
        </li>
      );
    });
  };

  return (
    <>
      <ul className="file-tree" aria-label="Files">
        {renderDir(".", 0)}
      </ul>
      {menu && <TreeMenu entry={menu.entry} x={menu.x} y={menu.y} onAction={act} onClose={closeMenu} />}
    </>
  );
});
