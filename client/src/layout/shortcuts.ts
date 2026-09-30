// The pane shortcuts. Browser, Diff, and Terminal use the keys of the Code tab of Claude. Claude
// has no documented key for its Files pane: Ctrl+Shift+F toggles the Files pane (the file tree and the editor).
// Cmd works in place of Ctrl on macOS, except for the terminal key, as in Claude.

import type { PaneId } from "./model";

export const PANE_SHORTCUTS: { pane: PaneId; code: string; label: string }[] = [
  { pane: "browser", code: "KeyB", label: "Ctrl+Shift+B" },
  { pane: "diff", code: "KeyD", label: "Ctrl+Shift+D" },
  { pane: "editor", code: "KeyF", label: "Ctrl+Shift+F" },
  { pane: "terminal", code: "Backquote", label: "Ctrl+`" },
];

type KeyInfo = Pick<KeyboardEvent, "code" | "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

/** The pane of a pane shortcut, or null. */
export function shortcutPane(e: KeyInfo): PaneId | null {
  if (e.altKey) return null;
  // The code is the key position. The key value helps when a keyboard layout or a tool gives no code.
  if (e.code === "Backquote" || e.key === "`") return e.ctrlKey && !e.shiftKey && !e.metaKey ? "terminal" : null;
  if (!e.shiftKey || !(e.ctrlKey || e.metaKey)) return null;
  return PANE_SHORTCUTS.find((s) => s.code === e.code && s.pane !== "terminal")?.pane ?? null;
}

/** The key of a pane for a tooltip, for example "Ctrl+Shift+F". */
export function shortcutLabel(pane: PaneId): string {
  return PANE_SHORTCUTS.find((s) => s.pane === pane)?.label ?? "";
}

/** The key that shows or hides the sidebar. */
export const SIDEBAR_SHORTCUT = "Ctrl+B";

/** Ctrl+B (Cmd+B on macOS) shows or hides the sidebar. */
export function isSidebarShortcut(e: KeyInfo): boolean {
  if (e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey)) return false;
  return e.code === "KeyB" || e.key.toLowerCase() === "b";
}
