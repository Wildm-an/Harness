// Links in the chat: the system browser, or the Browser pane ("Open links in built-in browser" in
// the menu of the Browser pane). The app sets the function that opens a link in the pane.

import { loadPref, savePref } from "./prefs";
import { openExternal } from "./tauri";

const PREF = "browserOpenLinks";

let inPane: ((url: string) => void) | null = null;

export function linksInPane(): boolean {
  return loadPref(PREF, "false") === "true";
}

export function setLinksInPane(on: boolean): void {
  savePref(PREF, on ? "true" : "false");
}

/** The app calls this one time with the function that shows a URL in the Browser pane. */
export function setPaneOpener(fn: ((url: string) => void) | null): void {
  inPane = fn;
}

/** Opens an http or https link of the chat. */
export function openLink(url: string): void {
  if (linksInPane() && inPane) inPane(url);
  else void openExternal(url);
}
