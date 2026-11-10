// A form that opens on a click (for example "Add a provider") can open below the visible part of a
// page. It scrolls into view, and its first field gets the focus, so the user can type at once and
// Esc reaches the form (audit U9).

import { useCallback } from "react";

const FIRST_FIELD = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

/** Shows a new form and puts the focus in its first field. */
export function formIntoView(form: HTMLElement): void {
  const reduce = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  form.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  form.querySelector<HTMLElement>(FIRST_FIELD)?.focus({ preventScroll: true });
}

/** A ref callback for a form: formIntoView runs one time, when the form mounts. */
export function useFormIntoView(): (form: HTMLElement | null) => void {
  return useCallback((form: HTMLElement | null) => {
    if (form) formIntoView(form);
  }, []);
}
