import { memo } from "react";
import { ChevronRight, File, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import type { TreeEntry } from "./useEditor";

/** The files of the session folder. The daemon applies the .gitignore files. */
export const FileTree = memo(function FileTree({
  tree,
  expanded,
  active,
  onToggle,
  onOpen,
}: {
  tree: Record<string, TreeEntry[] | "loading">;
  expanded: Set<string>;
  active: string | null;
  onToggle: (dir: string) => void;
  onOpen: (path: string) => void;
}) {
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
      return (
        <li key={entry.path}>
          <button
            type="button"
            className={`tree-item${entry.path === active ? " active" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (entry.type === "dir" ? onToggle(entry.path) : onOpen(entry.path))}
            aria-expanded={entry.type === "dir" ? open : undefined}
            title={entry.path}
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
    <ul className="file-tree" aria-label="Files">
      {renderDir(".", 0)}
    </ul>
  );
});
