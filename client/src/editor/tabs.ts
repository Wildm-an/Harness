// The tabs of the editor (docs/UI_RULES.md V6k4). A file opens in an unpinned tab: the name is in
// italics, and the next file that opens takes the place of that tab. "Keep open" pins a tab.
// The list has one unpinned tab at most.

export interface Tab {
  path: string;
  pinned: boolean;
}

/**
 * The tab list after ``entry`` opens. ``replaced`` is the path of the unpinned tab that the new
 * file took the place of, or null.
 */
export function withOpened<T extends Tab>(list: T[], entry: T): { list: T[]; replaced: string | null } {
  const open = list.find((t) => t.path === entry.path);
  if (open) {
    // The file is open. A pinned open (a new file, for example) also pins its tab.
    if (!entry.pinned || open.pinned) return { list, replaced: null };
    return { list: list.map((t) => (t === open ? { ...t, pinned: true } : t)), replaced: null };
  }
  const preview = entry.pinned ? undefined : list.find((t) => !t.pinned);
  if (!preview) return { list: [...list, entry], replaced: null };
  return { list: list.map((t) => (t === preview ? entry : t)), replaced: preview.path };
}
