// The options of the IDE view (Settings > Appearance > IDE view): the arrangement of the panes,
// the side of the chat, and the default sizes. A change resets the saved IDE layout of each
// project, and the open session shows the new layout at once. The user can still drag and resize
// the panes: each project keeps that layout until the next change of these options.

import { DEFAULT_IDE_OPTIONS, type IdeLayoutOptions, type IdePreset } from "../layout/model";
import { loadPref, prefsChanged, savePref } from "./prefs";

const PREF = "ideLayout";
export const IDE_LAYOUT_EVENT = "harness:ide-layout"; // The app loads the new IDE layout.

export const IDE_PRESETS: { id: IdePreset; label: string; help: string }[] = [
  { id: "classic", label: "Classic", help: "Editor and terminal, chat at the side" },
  { id: "focus", label: "Focus", help: "Editor and chat, no terminal" },
  { id: "wideTerminal", label: "Wide terminal", help: "Terminal under everything" },
  { id: "review", label: "Review", help: "Editor and Changes side by side" },
];

export const CHAT_WIDTHS: [number, string][] = [
  [0.25, "Narrow"],
  [0.3, "Medium"],
  [0.4, "Wide"],
];

export const TERMINAL_HEIGHTS: [number, string][] = [
  [0.2, "Small"],
  [0.28, "Medium"],
  [0.4, "Large"],
];

/** Read the saved options. Unknown or bad values give the default of each option. */
export function parseIdeOptions(text: string): IdeLayoutOptions {
  try {
    const v = JSON.parse(text) as Partial<IdeLayoutOptions> | null;
    if (!v || typeof v !== "object") return { ...DEFAULT_IDE_OPTIONS };
    return {
      preset: IDE_PRESETS.some((p) => p.id === v.preset) ? (v.preset as IdePreset) : DEFAULT_IDE_OPTIONS.preset,
      chatSide: v.chatSide === "left" ? "left" : "right",
      chatShare: CHAT_WIDTHS.some(([n]) => n === v.chatShare) ? (v.chatShare as number) : DEFAULT_IDE_OPTIONS.chatShare,
      terminalShare: TERMINAL_HEIGHTS.some(([n]) => n === v.terminalShare) ? (v.terminalShare as number) : DEFAULT_IDE_OPTIONS.terminalShare,
    };
  } catch {
    return { ...DEFAULT_IDE_OPTIONS };
  }
}

export function ideOptions(): IdeLayoutOptions {
  return parseIdeOptions(loadPref(PREF, "null"));
}

/** Save the options, remove the saved IDE layouts of the projects, and tell the app. */
export function setIdeOptions(options: IdeLayoutOptions): void {
  savePref(PREF, JSON.stringify(options));
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("harness.layout.") && key.endsWith(":ide")) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable. The new options still apply to the open session.
  }
  prefsChanged(); // The prefs file must lose the removed layouts too.
  window.dispatchEvent(new Event(IDE_LAYOUT_EVENT));
}
