// "Allow bypass permissions mode" (docs/UI_RULES.md C12): the mode menus show "Bypass permissions" only while
// the user setting is on. The daemon also refuses the mode while it is off (config.py bypass_allowed).

import { useSyncExternalStore } from "react";

let allowed = false;
const listeners = new Set<() => void>();

/** App.tsx calls it with each user_settings message. */
export function setAllowBypass(value: boolean): void {
  if (value === allowed) return;
  allowed = value;
  for (const listener of listeners) listener();
}

export function bypassAllowed(): boolean {
  return allowed;
}

export function useAllowBypass(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => allowed,
    () => allowed,
  );
}

/** The modes for a menu. A session that is in bypass already keeps its item, so the menu shows the mode. */
export function shownModes<T extends { mode: string }>(modes: T[], allow: boolean, current?: string): T[] {
  return modes.filter((m) => m.mode !== "bypassPermissions" || allow || m.mode === current);
}
