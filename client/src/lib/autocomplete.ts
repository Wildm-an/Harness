// Editor autocomplete, as GitHub Copilot in VS Code: when the user stops typing, the model of the
// session writes the text at the cursor. The editor shows it as gray text, and Tab accepts it.
// The setting is a per-device preference (Settings > General), on by default.

import { loadPref, savePref } from "./prefs";

const PREF = "editorAutocomplete";
export const AUTOCOMPLETE_DELAY = 400; // Milliseconds of no typing before the request.
export const PREFIX_CHARS = 6000; // The text before the cursor that the client sends.
export const SUFFIX_CHARS = 2000; // The text after the cursor that the client sends.

export function autocompleteOn(): boolean {
  return loadPref(PREF, "1") === "1";
}

export function setAutocompleteOn(on: boolean): void {
  savePref(PREF, on ? "1" : "0");
}

/** The text before and after the cursor offset, cut to the sizes that the daemon uses. */
export function cursorContext(text: string, offset: number): { prefix: string; suffix: string } {
  const at = Math.max(0, Math.min(offset, text.length));
  return { prefix: text.slice(Math.max(0, at - PREFIX_CHARS), at), suffix: text.slice(at, at + SUFFIX_CHARS) };
}

/**
 * Ask for a completion only where it can help: not in an empty file, and not when the text after
 * the cursor on the same line is more than closing brackets, quotes, and spaces.
 */
export function wantsCompletion(prefix: string, suffix: string): boolean {
  if (!prefix.trim()) return false;
  const restOfLine = suffix.split("\n", 1)[0];
  return /^[\s)\]}>"'`;,]*$/.test(restOfLine);
}
