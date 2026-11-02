// The view of a session: the Code view (the chat first, as in Claude Code), or the IDE view (the
// editor first, as in Cursor). The switch in the title bar changes it. Each view keeps its own
// pane layout for each project.

import { loadPref, savePref } from "./prefs";

export type ViewMode = "code" | "ide";

const VIEW_PREF = "view";

export function viewMode(): ViewMode {
  return loadPref(VIEW_PREF, "code") === "ide" ? "ide" : "code";
}

export function setViewMode(mode: ViewMode): void {
  savePref(VIEW_PREF, mode);
}

/** The preference key of the layout of a project in a view. The Code view keeps the old key. */
export function layoutKey(connectionId: string, cwd: string, mode: ViewMode): string {
  const key = `layout.${connectionId}:${cwd}`;
  return mode === "ide" ? `${key}:ide` : key;
}

/** The prompt for an inline edit (Ctrl+K in the editor): the instruction, then the code to change. */
export function inlineEditPrompt(reference: string, instruction: string): string {
  return `${instruction.trim()}\n\nChange only the code at ${reference}. Keep the rest of the file as it is.`;
}
