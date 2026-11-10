// The keys of a card that waits for the user: a permission request, a question, or a plan
// (docs/UI_RULES.md M10a). After a prompt, the focus stays in the prompt box. The number keys and
// Esc of the card must work from there too, so that the user does not have to click the card first.
//
// - Esc answers the card (Deny, Skip, or Revise…) from the prompt box and from any place that is not a
//   text field, a menu, or a dialog. While a card waits, Esc does not stop the turn.
// - A number key answers the card from the same places, but from the prompt box only while the box is
//   empty: a number in a message stays text.
// - With two waiting cards, the older card takes the key: its listener was added first.

import { useContext, useEffect, useRef } from "react";
import type { ChatItem } from "../chat/state";
import { overlayOpen } from "./overlay";
import { InSplitPane, keyForPane, usePromptInputId } from "./split";

/** Fields and widgets that keep their own keys. */
const OWN_KEYS = 'input, textarea, select, [contenteditable="true"], .xterm, .monaco-editor, [role="dialog"], [role="menu"], [role="listbox"]';

/**
 * Where a key comes from: "prompt" (the prompt box of the pane), "free" (a place with no keys of its
 * own, for example the page body or a button), or null (a field or a widget that keeps the key).
 */
export function cardKeySource(target: EventTarget | null, promptId: string): "prompt" | "free" | null {
  const el = target !== null && typeof (target as Element).closest === "function" ? (target as Element) : null;
  if (!el) return "free";
  if (el.id === promptId) {
    // The / menu or the @ menu of the prompt box is open: Esc closes it first.
    return el.getAttribute("aria-expanded") === "true" ? null : "prompt";
  }
  return el.closest(OWN_KEYS) ? null : "free";
}

export interface CardKeys {
  digit?: (n: number) => boolean; // 1 to 9. true: the card used the key.
  escape?: () => void;
}

/** The decision of a key, or null when the card does not take it. */
export function cardKeyAction(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "repeat" | "defaultPrevented" | "isComposing">,
  source: "prompt" | "free" | null,
  promptEmpty: boolean,
): { kind: "escape" } | { kind: "digit"; n: number } | null {
  if (!source || e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Escape" && !e.shiftKey) return { kind: "escape" };
  if (/^[1-9]$/.test(e.key) && !e.shiftKey && (source === "free" || promptEmpty)) return { kind: "digit", n: Number(e.key) };
  return null;
}

/** Sends Esc and the number keys of the window to a card while `active` is true. */
export function useCardKeys(active: boolean, keys: CardKeys): void {
  const ref = useRef(keys);
  ref.current = keys;
  const inSplit = useContext(InSplitPane); // With a split view, the key is for the pane with the focus.
  const promptId = usePromptInputId();
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!keyForPane(e.target, inSplit) || overlayOpen()) return;
      const source = cardKeySource(e.target, promptId);
      const empty = source === "prompt" && (e.target as HTMLTextAreaElement).value === "";
      const action = cardKeyAction(e, source, empty);
      if (!action) return;
      let used = false;
      if (action.kind === "escape" && ref.current.escape) {
        ref.current.escape();
        used = true;
      } else if (action.kind === "digit") {
        used = ref.current.digit?.(action.n) ?? false;
      }
      if (!used) return;
      e.preventDefault();
      e.stopPropagation(); // The prompt box does not type the key, and Esc does not stop the turn.
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, inSplit, promptId]);
}

/** The text of the empty prompt box while a card waits: the keys that answer the oldest card. */
export function waitingCardHint(items: ChatItem[]): string | null {
  for (const item of items) {
    if (item.kind === "permission" && item.decision === undefined && !item.expired) {
      return `Press ${item.rule ? "1, 2, or 3" : "1 or 2"} to answer the request, or Esc to deny it.`;
    }
    if (item.kind === "question" && item.answers === undefined && !item.expired) {
      return "Press a number to choose an answer, or Esc to skip the questions.";
    }
    if (item.kind === "plan" && item.decision === undefined && !item.expired) {
      return "Press Ctrl+Enter to accept the plan, or Esc to revise it.";
    }
  }
  return null;
}
