// Links in the chat, for example the links that the agent lists: the Browser pane (the default), or
// the default browser of the system. Settings > General > "Open links in" and "Open links in
// built-in browser" in the menu of the Browser pane change the same preference.
// The app sets the function that opens a link in the pane.

import { useEffect, useState } from "react";
import { loadPref, savePref } from "./prefs";
import { openExternal } from "./tauri";

const PREF = "browserOpenLinks";
const CHANGED = "harness:links-pref"; // A window event: the preference changed.

let inPane: ((url: string) => void) | null = null;

/** True: a link of the chat opens in the Browser pane. The default is the Browser pane. */
export function linksInPane(): boolean {
  return loadPref(PREF, "true") === "true";
}

export function setLinksInPane(on: boolean): void {
  savePref(PREF, on ? "true" : "false");
  window.dispatchEvent(new Event(CHANGED));
}

/** The preference, updated when Settings or the Browser pane menu changes it. */
export function useLinksInPane(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(linksInPane);
  useEffect(() => {
    const update = () => setOn(linksInPane());
    window.addEventListener(CHANGED, update);
    return () => window.removeEventListener(CHANGED, update);
  }, []);
  return [on, setLinksInPane];
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
