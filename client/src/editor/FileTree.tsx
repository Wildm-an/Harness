import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, File, Folder, FolderOpen, LoaderCircle, Trash2 } from "lucide-react";
import { useOverlay } from "../lib/overlay";
import { isEditableFile } from "./paths";
import type { TreeEntry } from "./useEditor";

const MENU_WIDTH = 200;

/** The menu of a tree item: right click, or Shift+F10 / the context menu key. */
function TreeMenu({ entry, x, y, onDelete, onClose }: {
  entry: TreeEntry;
  x: number;
  y: number;
  onDelete: (entry: TreeEntry) => void;
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
        }
      }}
    >
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => {
          onClose();
          onDelete(entry);
        }}
      >
        <Trash2 size={14} aria-hidden />
        <span className="session-menu-label">Delete…</span>
        <kbd className="session-menu-key">Del</kbd>
      </button>
    </div>
  );
}

/** The files of the session folder. The daemon applies the .gitignore files. */
export const FileTree = memo(function FileTree({
  tree,
  expanded,
  active,
  onToggle,
  onOpen,
  onDelete,
}: {
  tree: Record<string, TreeEntry[] | "loading">;
  expanded: Set<string>;
  active: string | null;
  onToggle: (dir: string) => void;
  onOpen: (path: string) => void;
  onDelete: (entry: TreeEntry) => void; // Ask, then delete the file or the folder.
}) {
  const [menu, setMenu] = useState<{ entry: TreeEntry; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

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
      // A binary file cannot open in the editor: it shows grayed out, and a click does nothing.
      // aria-disabled, not disabled: a disabled button gets no hover, so it would show no hint.
      const blocked = entry.type === "file" && !isEditableFile(entry.path);
      return (
        <li key={entry.path}>
          <button
            type="button"
            className={`tree-item${entry.path === active ? " active" : ""}${blocked ? " blocked" : ""}${menu?.entry.path === entry.path ? " menu-open" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              if (entry.type === "dir") onToggle(entry.path);
              else if (!blocked) onOpen(entry.path);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ entry, x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              if (e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                onDelete(entry);
              } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                setMenu({ entry, x: box.left + 24, y: box.bottom });
              }
            }}
            aria-expanded={entry.type === "dir" ? open : undefined}
            aria-disabled={blocked || undefined}
            title={blocked ? "Binary file" : entry.path}
          >
            {entry.type === "dir" ? (
              <>
                <ChevronRight size={13} aria-hidden className={`tree-chevron${open ? " open" : ""}`} />
                {open ? <FolderOpen size={14} aria-hidden /> : <Folder size={14} aria-hidden />}
              </>
            ) : (
              <>
                <span className="tree-chevron-space" />
                <File size={14} aria-hidden />
              </>
            )}
            <span className="tree-name">{entry.name}</span>
          </button>
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
      {menu && <TreeMenu entry={menu.entry} x={menu.x} y={menu.y} onDelete={onDelete} onClose={closeMenu} />}
    </>
  );
});
